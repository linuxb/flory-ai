package authn

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/linuxb/flory-ai/gatewayd/internal/rbac"
)

// IdentityHeader carries a Gateway-signed workflow identity on an internal mTLS request.
const IdentityHeader = "X-Flory-Workflow-Identity"

// Middleware authenticates either a short-lived bearer JWT or a signed workflow identity.
type Middleware struct {
	OIDC              *OIDCVerifier
	Roles             *rbac.Store
	Signer            *Signer
	InternalSPIFFEIDs map[string]bool
}

// SPIFFEID returns the sole URI SAN from the verified client certificate.
func SPIFFEID(request *http.Request) (string, error) {
	if request.TLS == nil || len(request.TLS.PeerCertificates) == 0 {
		return "", errors.New("client certificate is required")
	}
	identities := request.TLS.PeerCertificates[0].URIs
	if len(identities) != 1 || identities[0].Scheme != "spiffe" {
		return "", errors.New("exactly one SPIFFE URI SAN is required")
	}
	return identities[0].String(), nil
}

// EncodeWorkflowIdentity encodes the signed JSON value for transport in an HTTP header.
func EncodeWorkflowIdentity(identity WorkflowIdentity) (string, error) {
	raw, err := json.Marshal(identity)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func decodeWorkflowIdentity(encoded string) (WorkflowIdentity, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return WorkflowIdentity{}, err
	}
	var identity WorkflowIdentity
	if err := json.Unmarshal(raw, &identity); err != nil {
		return WorkflowIdentity{}, err
	}
	return identity, nil
}

// Handler wraps a protected surface. Health endpoints should be mounted outside it.
func (middleware *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		principal, err := middleware.authenticate(request)
		if err != nil {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(writer).Encode(map[string]string{"error": err.Error()})
			return
		}
		next.ServeHTTP(writer, request.WithContext(WithPrincipal(request.Context(), principal)))
	})
}

func (middleware *Middleware) authenticate(request *http.Request) (Principal, error) {
	authorization := request.Header.Get("Authorization")
	encodedIdentity := request.Header.Get(IdentityHeader)
	if authorization != "" && encodedIdentity != "" {
		return Principal{}, errors.New("bearer JWT and workflow identity are mutually exclusive")
	}
	if strings.HasPrefix(authorization, "Bearer ") {
		if middleware.OIDC == nil || middleware.Roles == nil {
			return Principal{}, errors.New("OIDC authentication is unavailable")
		}
		principal, err := middleware.OIDC.Verify(request.Context(), strings.TrimPrefix(authorization, "Bearer "))
		if err != nil {
			return Principal{}, err
		}
		subject, err := middleware.Roles.Subject(request.Context(), principal.Issuer, principal.Subject)
		if err != nil {
			return Principal{}, err
		}
		principal.Roles, principal.Revision = subject.Roles, subject.Revision
		if spiffeID, err := SPIFFEID(request); err == nil {
			principal.SPIFFEID = spiffeID
		}
		return principal, nil
	}
	if encodedIdentity != "" {
		if middleware.Signer == nil {
			return Principal{}, errors.New("workflow identity authentication is unavailable")
		}
		spiffeID, err := SPIFFEID(request)
		if err != nil || !middleware.InternalSPIFFEIDs[spiffeID] {
			return Principal{}, errors.New("internal SPIFFE identity is not authorised")
		}
		identity, err := decodeWorkflowIdentity(encodedIdentity)
		if err != nil {
			return Principal{}, errors.New("malformed workflow identity")
		}
		principal, err := middleware.Signer.Verify(identity)
		if err != nil {
			return Principal{}, err
		}
		principal.SPIFFEID = spiffeID
		return principal, nil
	}
	return Principal{}, errors.New("authentication is required")
}
