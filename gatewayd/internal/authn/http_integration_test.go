package authn

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/linuxb/flory-ai/gatewayd/internal/rbac"
)

func openRoleStore(t *testing.T) *rbac.Store {
	t.Helper()
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1")
	}
	connectionString := os.Getenv("GATEWAYD_DATABASE_URL")
	if connectionString == "" {
		connectionString = "postgresql://gateway_role:gateway-dev-password@127.0.0.1:5432/flory_test"
	}
	store, err := rbac.Open(context.Background(), connectionString)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// A bearer principal's roles are the Gateway's own bindings, read on every request, never a claim
// the token carries: an administrator's revocation takes effect on the very next call.
func TestMiddlewareResolvesABearerPrincipalsRolesFromTheRoleStore(t *testing.T) {
	store := openRoleStore(t)
	defer store.Close()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	id := hex.EncodeToString(raw)
	issuer := newTestIssuer(t)
	role := "test-" + id
	ctx := context.Background()
	actor := "spiffe://flory.local/rbac-admin"
	if _, err := store.PutRole(ctx, rbac.Mutation{ActorSPIFFEID: actor, RequestID: "role-" + id, IdempotencyKey: "role-" + id}, rbac.Role{RoleID: role, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplaceSubjectRoles(ctx, rbac.Mutation{ActorSPIFFEID: actor, RequestID: "bind-" + id, IdempotencyKey: "bind-" + id},
		rbac.Subject{Issuer: issuer.server.URL, Subject: "alice", Roles: []string{role}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	fixture := newMiddlewareFixture(t)
	fixture.middleware.OIDC = issuer.verifier(t)
	fixture.middleware.Roles = store
	token := issuer.token(t, "key-1", issuer.private, nil)

	// A caller behind mTLS is identified by its certificate as well; a browser-side caller is not.
	for name, request := range map[string]*http.Request{
		"with a client certificate":    withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), coordinatorSPIFFEID),
		"without a client certificate": httptest.NewRequest(http.MethodPost, "/mcp", nil),
	} {
		request.Header.Set("Authorization", "Bearer "+token)
		if recorder := fixture.serve(request); recorder.Code != http.StatusNoContent {
			t.Fatalf("%s: status=%d body=%s", name, recorder.Code, recorder.Body)
		}
		principal := fixture.reached
		if principal == nil || principal.Source != "bearer" || principal.Subject != "alice" || principal.Revision != 1 || !Allows(principal.Roles, []string{role}) {
			t.Fatalf("%s: principal=%+v", name, principal)
		}
		if wantSPIFFE := request.TLS != nil; (principal.SPIFFEID == coordinatorSPIFFEID) != wantSPIFFE {
			t.Fatalf("%s: SPIFFE ID=%q", name, principal.SPIFFEID)
		}
	}

	// Revoked in the store, refused in the gateway, with the same token still valid.
	if _, err := store.ReplaceSubjectRoles(ctx, rbac.Mutation{ActorSPIFFEID: actor, RequestID: "revoke-" + id, IdempotencyKey: "revoke-" + id, ExpectedRevision: 1},
		rbac.Subject{Issuer: issuer.server.URL, Subject: "alice", Roles: []string{}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if recorder := fixture.serve(request); recorder.Code != http.StatusNoContent || len(fixture.reached.Roles) != 0 || fixture.reached.Revision != 2 {
		t.Fatalf("after revocation: status=%d principal=%+v", recorder.Code, fixture.reached)
	}

	// And a store that cannot answer refuses the request instead of admitting it without roles.
	store.Close()
	request = httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if recorder := fixture.serve(request); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("with the store closed: status=%d body=%s", recorder.Code, recorder.Body)
	}
}
