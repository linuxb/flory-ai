package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	"github.com/linuxb/flory-ai/gatewayd/internal/rbac"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
)

const administrator = "spiffe://flory.local/rbac-admin"

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

func uniqueID(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw)
}

// adminClient drives the administration routes as a caller presenting spiffeID, or no client
// certificate at all when it is empty.
type adminClient struct {
	t        *testing.T
	handler  http.Handler
	spiffeID string
}

func (client adminClient) do(method, path, body string, headers map[string]string) (int, map[string]any) {
	client.t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	if client.spiffeID != "" {
		identity, err := url.Parse(client.spiffeID)
		if err != nil {
			client.t.Fatal(err)
		}
		request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{URIs: []*url.URL{identity}}}}
	}
	recorder := httptest.NewRecorder()
	client.handler.ServeHTTP(recorder, request)
	var decoded map[string]any
	if err := json.NewDecoder(recorder.Body).Decode(&decoded); err != nil {
		client.t.Fatalf("%s %s: %v", method, path, err)
	}
	return recorder.Code, decoded
}

func idempotent(key string) map[string]string {
	return map[string]string{"X-Request-ID": key, "Idempotency-Key": key}
}

func TestRBACAdministrationWritesReadsAndAuditsThroughTheRoleStore(t *testing.T) {
	store := openRoleStore(t)
	defer store.Close()
	handler := New(http.NotFoundHandler(), registry.New(blob.NewMemory(), nil), RBACAdminConfig{Store: store, AdminSPIFFEIDs: map[string]bool{administrator: true}})
	admin := adminClient{t: t, handler: handler, spiffeID: administrator}
	id := uniqueID(t)
	role := "test-" + id
	issuer := "https://issuer.example/" + id

	status, created := admin.do(http.MethodPut, "/admin/v1/roles/"+role, `{"description":"integration role","enabled":true,"expected_revision":0}`, idempotent("role-"+id))
	if status != http.StatusOK || created["role_id"] != role || created["revision"] != float64(1) {
		t.Fatalf("put role: %d %v", status, created)
	}
	// Writing against the revision the role had before is the one failure a client fixes by re-reading.
	if status, body := admin.do(http.MethodPut, "/admin/v1/roles/"+role, `{"description":"stale","enabled":true,"expected_revision":0}`, idempotent("stale-"+id)); status != http.StatusConflict {
		t.Fatalf("stale role write: %d %v", status, body)
	}

	binding := `{"issuer":"` + issuer + `","subject":"alice","roles":["` + role + `"],"enabled":true,"expected_revision":0}`
	status, bound := admin.do(http.MethodPut, "/admin/v1/subjects/roles", binding, idempotent("bind-"+id))
	if status != http.StatusOK || bound["revision"] != float64(1) || len(bound["roles"].([]any)) != 1 {
		t.Fatalf("bind subject: %d %v", status, bound)
	}
	// The public marker names every caller, so binding it to one subject would mean nothing.
	reserved := `{"issuer":"` + issuer + `","subject":"alice","roles":["*"],"enabled":true,"expected_revision":1}`
	if status, body := admin.do(http.MethodPut, "/admin/v1/subjects/roles", reserved, idempotent("reserved-"+id)); status != http.StatusBadRequest {
		t.Fatalf("binding the reserved role: %d %v", status, body)
	}

	query := "?issuer=" + url.QueryEscape(issuer) + "&subject=alice"
	status, current := admin.do(http.MethodGet, "/admin/v1/subjects/roles"+query, "", nil)
	if status != http.StatusOK || current["subject"] != "alice" || len(current["roles"].([]any)) != 1 {
		t.Fatalf("read subject: %d %v", status, current)
	}
	status, audit := admin.do(http.MethodGet, "/admin/v1/subjects/audit"+query, "", nil)
	if status != http.StatusOK || len(audit["entries"].([]any)) != 1 {
		t.Fatalf("read audit: %d %v", status, audit)
	}
}

// Nothing reaches the store unless the caller is an administrator and the write is well formed.
func TestRBACAdministrationRefusesBeforeTouchingTheRoleStore(t *testing.T) {
	store := openRoleStore(t)
	defer store.Close()
	handler := New(http.NotFoundHandler(), registry.New(blob.NewMemory(), nil), RBACAdminConfig{Store: store, AdminSPIFFEIDs: map[string]bool{administrator: true}})
	id := uniqueID(t)
	writes := map[string]string{
		"/admin/v1/roles/test-" + id: `{"description":"never written","enabled":true}`,
		"/admin/v1/subjects/roles":   `{"issuer":"https://issuer.example/` + id + `","subject":"alice","roles":[],"enabled":true}`,
	}
	for _, caller := range []adminClient{{t: t, handler: handler}, {t: t, handler: handler, spiffeID: "spiffe://flory.local/coordinator"}} {
		for path, body := range writes {
			if status, _ := caller.do(http.MethodPut, path, body, idempotent("denied-"+id)); status != http.StatusUnauthorized {
				t.Fatalf("PUT %s as %q: %d", path, caller.spiffeID, status)
			}
		}
		for _, path := range []string{"/admin/v1/subjects/roles?issuer=x&subject=y", "/admin/v1/subjects/audit?issuer=x&subject=y"} {
			if status, _ := caller.do(http.MethodGet, path, "", nil); status != http.StatusUnauthorized {
				t.Fatalf("GET %s as %q: %d", path, caller.spiffeID, status)
			}
		}
	}
	admin := adminClient{t: t, handler: handler, spiffeID: administrator}
	for path, body := range writes {
		if status, _ := admin.do(http.MethodPut, path, "{", idempotent("malformed-"+id)); status != http.StatusBadRequest {
			t.Fatalf("malformed PUT %s: %d", path, status)
		}
		if status, _ := admin.do(http.MethodPut, path, body, nil); status != http.StatusBadRequest {
			t.Fatalf("PUT %s without idempotency headers: %d", path, status)
		}
	}
	// Nothing above was written, so the role is still unknown and the subject has no audit trail.
	query := "?issuer=" + url.QueryEscape("https://issuer.example/"+id) + "&subject=alice"
	if status, audit := admin.do(http.MethodGet, "/admin/v1/subjects/audit"+query, "", nil); status != http.StatusOK || len(audit["entries"].([]any)) != 0 {
		t.Fatalf("a refused write was audited: %d %v", status, audit)
	}
}

// A store that fails is reported to the administrator, not mistaken for an empty answer.
func TestRBACAdministrationReportsAFailingRoleStore(t *testing.T) {
	store := openRoleStore(t)
	store.Close()
	handler := New(http.NotFoundHandler(), registry.New(blob.NewMemory(), nil), RBACAdminConfig{Store: store, AdminSPIFFEIDs: map[string]bool{administrator: true}})
	admin := adminClient{t: t, handler: handler, spiffeID: administrator}
	for _, path := range []string{"/admin/v1/subjects/roles?issuer=x&subject=y", "/admin/v1/subjects/audit?issuer=x&subject=y"} {
		if status, body := admin.do(http.MethodGet, path, "", nil); status != http.StatusBadRequest || body["error"] == nil {
			t.Fatalf("GET %s on a closed store: %d %v", path, status, body)
		}
	}
}
