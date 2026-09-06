// Package authn authenticates OIDC users and Gateway-signed workflow identities.
package authn

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"time"
)

// Principal is the authenticated identity and the roles resolved by gatewayd.
type Principal struct {
	Issuer   string
	Subject  string
	Roles    []string
	Revision int64
	RunID    string
	Source   string
	SPIFFEID string
}

type contextKey struct{}

// WithPrincipal attaches a verified principal to a request context.
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, contextKey{}, principal)
}

// PrincipalFrom returns the verified principal attached by the authentication middleware.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(contextKey{}).(Principal)
	return principal, ok
}

// WorkflowIdentity is a non-secret, Gateway-signed run authorization snapshot.
// It is accepted only together with an authorised internal mTLS identity.
type WorkflowIdentity struct {
	Version         string   `json:"version"`
	KeyID           string   `json:"key_id"`
	Issuer          string   `json:"issuer"`
	Subject         string   `json:"subject"`
	Roles           []string `json:"roles"`
	SubjectRevision int64    `json:"subject_revision"`
	RunID           string   `json:"run_id"`
	AuthenticatedAt string   `json:"authenticated_at"`
	Signature       string   `json:"signature"`
}

type identityPayload struct {
	Version         string   `json:"version"`
	KeyID           string   `json:"key_id"`
	Issuer          string   `json:"issuer"`
	Subject         string   `json:"subject"`
	Roles           []string `json:"roles"`
	SubjectRevision int64    `json:"subject_revision"`
	RunID           string   `json:"run_id"`
	AuthenticatedAt string   `json:"authenticated_at"`
}

// Signer signs with the active Ed25519 key and verifies against the retained keyring.
type Signer struct {
	keyID   string
	private ed25519.PrivateKey
	public  map[string]ed25519.PublicKey
	now     func() time.Time
}

// NewSigner creates a workflow-identity signer.
func NewSigner(keyID string, private ed25519.PrivateKey, retained map[string]ed25519.PublicKey) (*Signer, error) {
	if keyID == "" || len(private) != ed25519.PrivateKeySize {
		return nil, errors.New("authn: valid key ID and Ed25519 private key are required")
	}
	keys := make(map[string]ed25519.PublicKey, len(retained)+1)
	for id, key := range retained {
		keys[id] = key
	}
	keys[keyID] = private.Public().(ed25519.PublicKey)
	return &Signer{keyID: keyID, private: private, public: keys, now: time.Now}, nil
}

// LoadSigner loads a PKCS#8 private key and PEM public-key directory.
func LoadSigner(keyID, privatePath, keyringPath string) (*Signer, error) {
	raw, err := os.ReadFile(privatePath)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("authn: signing key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	private, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("authn: signing key is not Ed25519")
	}
	keys := map[string]ed25519.PublicKey{}
	entries, err := os.ReadDir(keyringPath)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		encoded, err := os.ReadFile(keyringPath + "/" + entry.Name())
		if err != nil {
			return nil, err
		}
		publicBlock, _ := pem.Decode(encoded)
		if publicBlock == nil {
			continue
		}
		parsedPublic, err := x509.ParsePKIXPublicKey(publicBlock.Bytes)
		if err != nil {
			return nil, err
		}
		if public, ok := parsedPublic.(ed25519.PublicKey); ok {
			keys[entry.Name()] = public
		}
	}
	return NewSigner(keyID, private, keys)
}

func payload(identity WorkflowIdentity) identityPayload {
	return identityPayload{Version: identity.Version, KeyID: identity.KeyID, Issuer: identity.Issuer, Subject: identity.Subject,
		Roles: identity.Roles, SubjectRevision: identity.SubjectRevision, RunID: identity.RunID, AuthenticatedAt: identity.AuthenticatedAt}
}

func payloadBytes(identity WorkflowIdentity) ([]byte, error) { return json.Marshal(payload(identity)) }

func normalizedRoles(roles []string) []string {
	unique := make(map[string]struct{}, len(roles))
	for _, role := range roles {
		unique[role] = struct{}{}
	}
	result := make([]string, 0, len(unique))
	for role := range unique {
		result = append(result, role)
	}
	sort.Strings(result)
	return result
}

// Issue freezes one bearer-authenticated principal for a run.
func (signer *Signer) Issue(principal Principal, runID string) (WorkflowIdentity, error) {
	if principal.Source != "bearer" || principal.Issuer == "" || principal.Subject == "" || runID == "" {
		return WorkflowIdentity{}, errors.New("authn: bearer principal and run ID are required")
	}
	identity := WorkflowIdentity{Version: "1", KeyID: signer.keyID, Issuer: principal.Issuer, Subject: principal.Subject,
		Roles: normalizedRoles(principal.Roles), SubjectRevision: principal.Revision, RunID: runID,
		AuthenticatedAt: signer.now().UTC().Format(time.RFC3339Nano)}
	encoded, err := payloadBytes(identity)
	if err != nil {
		return WorkflowIdentity{}, err
	}
	identity.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(signer.private, encoded))
	return identity, nil
}

// Verify verifies a workflow identity without consulting live role bindings.
func (signer *Signer) Verify(identity WorkflowIdentity) (Principal, error) {
	key, found := signer.public[identity.KeyID]
	if !found {
		return Principal{}, fmt.Errorf("authn: unknown identity key %q", identity.KeyID)
	}
	signature, err := base64.RawURLEncoding.DecodeString(identity.Signature)
	if err != nil {
		return Principal{}, errors.New("authn: malformed identity signature")
	}
	encoded, err := payloadBytes(identity)
	if err != nil {
		return Principal{}, err
	}
	_, timeErr := time.Parse(time.RFC3339Nano, identity.AuthenticatedAt)
	if identity.Version != "1" || identity.Issuer == "" || identity.Subject == "" || identity.RunID == "" || timeErr != nil ||
		!slices.Equal(identity.Roles, normalizedRoles(identity.Roles)) || !ed25519.Verify(key, encoded, signature) {
		return Principal{}, errors.New("authn: invalid workflow identity")
	}
	return Principal{Issuer: identity.Issuer, Subject: identity.Subject, Roles: append([]string(nil), identity.Roles...), Revision: identity.SubjectRevision,
		RunID: identity.RunID, Source: "workflow"}, nil
}

// Allows reports exact any-role RBAC matching. A public tool is always allowed.
func Allows(principalRoles, allowedRoles []string) bool {
	for _, role := range principalRoles {
		if role == "*" {
			return true
		}
	}
	allowed := make(map[string]struct{}, len(allowedRoles))
	for _, role := range allowedRoles {
		if role == "*" {
			return true
		}
		allowed[role] = struct{}{}
	}
	for _, role := range principalRoles {
		if _, found := allowed[role]; found {
			return true
		}
	}
	return false
}
