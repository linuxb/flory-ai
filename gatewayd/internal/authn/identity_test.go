package authn

import (
	"crypto/ed25519"
	"crypto/rand"
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
