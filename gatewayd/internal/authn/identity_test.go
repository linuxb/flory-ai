package authn

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkflowIdentityFreezesRolesAndRun(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner("test-key", private, map[string]ed25519.PublicKey{"old-key": public})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := signer.Issue(Principal{Issuer: "https://issuer.example", Subject: "alice", Roles: []string{"reader", "operator", "reader"}, Revision: 7, Source: "bearer"}, "run-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(identity.Roles) != 2 || identity.Roles[0] != "operator" || identity.Roles[1] != "reader" {
		t.Fatalf("roles were not normalized: %v", identity.Roles)
	}
	principal, err := signer.Verify(identity)
	if err != nil {
		t.Fatal(err)
	}
	if principal.RunID != "run-1" || principal.Revision != 7 || !Allows(principal.Roles, []string{"operator"}) {
		t.Fatalf("unexpected principal: %+v", principal)
	}
	identity.Subject = "mallory"
	if _, err := signer.Verify(identity); err == nil {
		t.Fatal("tampered identity was accepted")
	}
}

func TestWorkflowIdentitySurvivesRestartWhileKeyIsRetained(t *testing.T) {
	oldPublic, oldPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	oldSigner, err := NewSigner("old-key", oldPrivate, nil)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := oldSigner.Issue(Principal{Issuer: "https://issuer.example", Subject: "alice", Roles: []string{"operator"}, Source: "bearer"}, "run-1")
	if err != nil {
		t.Fatal(err)
	}
	_, newPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewSigner("new-key", newPrivate, map[string]ed25519.PublicKey{"old-key": oldPublic})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Verify(identity); err != nil {
		t.Fatalf("retained identity rejected after restart: %v", err)
	}
	withoutOldKey, err := NewSigner("new-key", newPrivate, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := withoutOldKey.Verify(identity); err == nil {
		t.Fatal("removed signing key was still accepted")
	}
}

func TestAllowsUsesExactAnyRoleMatching(t *testing.T) {
	if !Allows([]string{"reader", "operator"}, []string{"operator"}) {
		t.Fatal("matching role was denied")
	}
	if Allows([]string{"Operator"}, []string{"operator"}) {
		t.Fatal("role matching was not case-sensitive")
	}
	if !Allows(nil, []string{"*"}) {
		t.Fatal("public tool was denied")
	}
}

func writePEM(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeSigningKey(t *testing.T, path string, key any) {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	writePEM(t, path, "PRIVATE KEY", der)
}

func writePublicKey(t *testing.T, path string, key any) {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	writePEM(t, path, "PUBLIC KEY", der)
}

// The keyring is what lets a restarted gateway keep honouring identities its predecessor signed.
// Each retained key is named by its file, and anything in the directory that is not an Ed25519
// public key is passed over rather than trusted or fatal.
func TestLoadSignerRetainsEveryEd25519KeyInTheKeyring(t *testing.T) {
	directory := t.TempDir()
	oldPublic, oldPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, currentPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyring := filepath.Join(directory, "keyring")
	if err := os.MkdirAll(filepath.Join(keyring, "archive"), 0o700); err != nil {
		t.Fatal(err)
	}
	writePublicKey(t, filepath.Join(keyring, "old-key"), oldPublic)
	writePublicKey(t, filepath.Join(keyring, "not-ed25519"), &ecdsaKey.PublicKey)
	if err := os.WriteFile(filepath.Join(keyring, "README"), []byte("rotated keys live here"), 0o600); err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(directory, "signing.pem")
	writeSigningKey(t, privatePath, currentPrivate)

	signer, err := LoadSigner("current-key", privatePath, keyring)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := signer.public["not-ed25519"]; found {
		t.Fatal("a non-Ed25519 key was retained")
	}
	oldSigner, err := NewSigner("old-key", oldPrivate, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, issuer := range map[string]*Signer{"the retained key": oldSigner, "the loaded key": signer} {
		identity, err := issuer.Issue(Principal{Issuer: "https://issuer.example", Subject: "alice", Source: "bearer"}, "run-1")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := signer.Verify(identity); err != nil {
			t.Fatalf("an identity signed with %s was refused: %v", name, err)
		}
	}
}

func TestLoadSignerRefusesKeysItCannotUse(t *testing.T) {
	directory := t.TempDir()
	keyring := filepath.Join(directory, "keyring")
	if err := os.Mkdir(keyring, 0o700); err != nil {
		t.Fatal(err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	valid := filepath.Join(directory, "valid.pem")
	writeSigningKey(t, valid, private)
	notPEM := filepath.Join(directory, "not.pem")
	if err := os.WriteFile(notPEM, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	notPKCS8 := filepath.Join(directory, "not-pkcs8.pem")
	writePEM(t, notPKCS8, "PRIVATE KEY", []byte("garbage"))
	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	notEd25519 := filepath.Join(directory, "ecdsa.pem")
	writeSigningKey(t, notEd25519, ecdsaKey)
	corruptKeyring := filepath.Join(directory, "corrupt-keyring")
	if err := os.Mkdir(corruptKeyring, 0o700); err != nil {
		t.Fatal(err)
	}
	writePEM(t, filepath.Join(corruptKeyring, "broken"), "PUBLIC KEY", []byte("garbage"))

	cases := map[string][2]string{
		"a missing signing key":            {filepath.Join(directory, "absent.pem"), keyring},
		"a signing key that is no PEM":     {notPEM, keyring},
		"a signing key that is no PKCS#8":  {notPKCS8, keyring},
		"a signing key that is no Ed25519": {notEd25519, keyring},
		"a missing keyring":                {valid, filepath.Join(directory, "absent")},
		"a keyring with a corrupt key":     {valid, corruptKeyring},
	}
	for name, paths := range cases {
		if _, err := LoadSigner("key", paths[0], paths[1]); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestSignerRefusesToIssueOrVerifyWhatItCannotStandBehind(t *testing.T) {
	if _, err := NewSigner("", nil, nil); err == nil {
		t.Fatal("a signer without a key was created")
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner("key-1", private, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Only a principal a person authenticated as can be frozen into a run: re-signing a workflow
	// identity would let a snapshot outlive the revocation it was meant to be checked against.
	for name, principal := range map[string]Principal{
		"a workflow principal": {Issuer: "https://issuer.example", Subject: "alice", Source: "workflow"},
		"no subject":           {Issuer: "https://issuer.example", Source: "bearer"},
	} {
		if _, err := signer.Issue(principal, "run-1"); err == nil {
			t.Fatalf("%s was issued", name)
		}
	}
	if _, err := signer.Issue(Principal{Issuer: "https://issuer.example", Subject: "alice", Source: "bearer"}, ""); err == nil {
		t.Fatal("an identity without a run was issued")
	}
	valid, err := signer.Issue(Principal{Issuer: "https://issuer.example", Subject: "alice", Roles: []string{"reader"}, Source: "bearer"}, "run-1")
	if err != nil {
		t.Fatal(err)
	}
	spoiled := map[string]func(*WorkflowIdentity){
		"an unknown key":          func(identity *WorkflowIdentity) { identity.KeyID = "key-2" },
		"a malformed signature":   func(identity *WorkflowIdentity) { identity.Signature = "%%%" },
		"an unreadable timestamp": func(identity *WorkflowIdentity) { identity.AuthenticatedAt = "yesterday" },
		"an unsorted role list":   func(identity *WorkflowIdentity) { identity.Roles = []string{"reader", "operator"} },
		"another version":         func(identity *WorkflowIdentity) { identity.Version = "2" },
	}
	for name, spoil := range spoiled {
		identity := valid
		identity.Roles = append([]string(nil), valid.Roles...)
		spoil(&identity)
		if _, err := signer.Verify(identity); err == nil {
			t.Fatalf("an identity with %s was accepted", name)
		}
	}
}

func TestPrincipalFromReportsAContextWithoutOne(t *testing.T) {
	if _, ok := PrincipalFrom(t.Context()); ok {
		t.Fatal("an unauthenticated context carried a principal")
	}
	if !Allows([]string{"*"}, []string{"operator"}) {
		t.Fatal("a wildcard principal was denied")
	}
	if Allows([]string{"reader"}, []string{"operator"}) {
		t.Fatal("a principal without the role was allowed")
	}
}
