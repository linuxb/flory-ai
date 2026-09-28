package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
)

func boolean(value bool) *bool { return &value }

func readOnlyContract(toolID string) *gatewayv1.ToolContract {
	return &gatewayv1.ToolContract{
		ToolId:            toolID,
		ToolVersion:       "1.0.0",
		InputSchema:       `{"type":"object"}`,
		OutputSchema:      `{"type":"object"}`,
		RouteId:           "inventory",
		Adapter:           &gatewayv1.AdapterSpec{Protocol: "grpc"},
		Txn:               &gatewayv1.TransactionSpec{EffectClass: gatewayv1.EffectClass_EFFECT_CLASS_NONE, Mode: gatewayv1.ToolMode_TOOL_MODE_PLAIN, IdempotentRetryable: boolean(true)},
		CompensationStyle: gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING,
		TimeoutMs:         5000,
		RetryConstraints:  &gatewayv1.RetryConstraints{MaxAttempts: 3, InitialBackoffMs: 100, MultiplierMilli: 2000, MaxBackoffMs: 5000},
		Owner:             "inventory-team",
		AllowedRoles:      []string{"*"},
	}
}

func get(t *testing.T, handler http.Handler, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	if strings.HasPrefix(recorder.Header().Get("Content-Type"), "application/json") {
		if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	return recorder, body
}

// Before anything is published the gateway is alive but not ready: it cannot answer discovery,
// and saying otherwise would send an executor to a surface that can only refuse it.
func TestTheGatewayIsLiveButNotReadyUntilAViewIsPublished(t *testing.T) {
	handler := New(http.NotFoundHandler(), registry.New(blob.NewMemory(), nil))
	if recorder, _ := get(t, handler, "/healthz"); recorder.Code != http.StatusNoContent {
		t.Fatalf("healthz=%d", recorder.Code)
	}
	if recorder, body := get(t, handler, "/readyz"); recorder.Code != http.StatusServiceUnavailable || body["error"] == nil {
		t.Fatalf("readyz=%d body=%v", recorder.Code, body)
	}
	if recorder, body := get(t, handler, "/v1/tool-view"); recorder.Code != http.StatusNotFound || body["error"] == nil {
		t.Fatalf("tool-view=%d body=%v", recorder.Code, body)
	}
	if recorder, body := get(t, handler, "/v1/registrations"); recorder.Code != http.StatusOK || len(body["registrations"].([]any)) != 0 {
		t.Fatalf("registrations=%d body=%v", recorder.Code, body)
	}
	if recorder, body := get(t, handler, "/metrics"); recorder.Code != http.StatusOK || body["memstats"] == nil {
		t.Fatalf("metrics=%d", recorder.Code)
	}
}

func TestThePublishedViewAndEveryRegistrationAreReported(t *testing.T) {
	tools := registry.New(blob.NewMemory(), nil)
	broken := readOnlyContract("inventory.broken")
	broken.InputSchema = "not a schema"
	if _, err := tools.Register(context.Background(), []*gatewayv1.ToolContract{readOnlyContract("inventory.lookup"), broken}); err != nil {
		t.Fatal(err)
	}
	handler := New(http.NotFoundHandler(), tools)
	if recorder, _ := get(t, handler, "/readyz"); recorder.Code != http.StatusNoContent {
		t.Fatalf("readyz=%d after publication", recorder.Code)
	}
	recorder, view := get(t, handler, "/v1/tool-view")
	current := tools.Current()
	if recorder.Code != http.StatusOK || view["tool_count"] != float64(1) || view["tool_view_digest"] != current.Published.Digest || view["tool_view_ref"] != current.Published.Ref {
		t.Fatalf("tool-view=%d body=%v", recorder.Code, view)
	}
	// Sorted by key, and a rejection carries its code and why, which is the whole reason to ask.
	_, body := get(t, handler, "/v1/registrations")
	registrations := body["registrations"].([]any)
	if len(registrations) != 2 {
		t.Fatalf("registrations=%v", registrations)
	}
	rejected, admitted := registrations[0].(map[string]any), registrations[1].(map[string]any)
	if rejected["tool_id"] != "inventory.broken" || rejected["detail"] == nil || rejected["code"] == nil {
		t.Fatalf("the rejection lost its reason: %v", rejected)
	}
	if admitted["tool_id"] != "inventory.lookup" || admitted["tool_version"] != "1.0.0" || admitted["detail"] != nil {
		t.Fatalf("admitted=%v", admitted)
	}
}

func TestMCPIsServedByTheHandlerItWasGiven(t *testing.T) {
	served := false
	handler := New(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		served = true
		writer.WriteHeader(http.StatusAccepted)
	}), registry.New(blob.NewMemory(), nil))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`)))
	if !served || recorder.Code != http.StatusAccepted {
		t.Fatalf("served=%v status=%d", served, recorder.Code)
	}
}

// Without a role store there is nothing to administer, so the routes do not exist at all rather
// than existing and failing.
func TestRBACAdministrationIsAbsentWithoutARoleStore(t *testing.T) {
	handler := New(http.NotFoundHandler(), registry.New(blob.NewMemory(), nil), RBACAdminConfig{AdminSPIFFEIDs: map[string]bool{"spiffe://flory.local/rbac-admin": true}})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, "/admin/v1/roles/operator", strings.NewReader(`{}`)))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d", recorder.Code)
	}
}

func TestAMutationNeedsBothARequestIDAndAnIdempotencyKey(t *testing.T) {
	for name, headers := range map[string]map[string]string{
		"neither":                 {},
		"only a request ID":       {"X-Request-ID": "request-1"},
		"only an idempotency key": {"Idempotency-Key": "key-1"},
	} {
		request := httptest.NewRequest(http.MethodPut, "/", nil)
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		if _, ok := mutation(request, "actor", 0); ok {
			t.Fatalf("%s was enough", name)
		}
	}
	request := httptest.NewRequest(http.MethodPut, "/", nil)
	request.Header.Set("X-Request-ID", "request-1")
	request.Header.Set("Idempotency-Key", "key-1")
	change, ok := mutation(request, "spiffe://flory.local/rbac-admin", 4)
	if !ok || change.ActorSPIFFEID != "spiffe://flory.local/rbac-admin" || change.RequestID != "request-1" || change.IdempotencyKey != "key-1" || change.ExpectedRevision != 4 {
		t.Fatalf("change=%+v ok=%v", change, ok)
	}
}

func TestOnlyAConfiguredAdministratorIdentityMayAdminister(t *testing.T) {
	recorder := httptest.NewRecorder()
	if _, ok := adminActor(recorder, httptest.NewRequest(http.MethodPut, "/", nil), map[string]bool{"spiffe://flory.local/rbac-admin": true}); ok {
		t.Fatal("a request without a client certificate was admitted")
	}
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", recorder.Code)
	}
}

// A stale expected revision is the one failure a client can fix by re-reading, so it alone is a 409.
func TestARevisionConflictIsTheOnlyRBACFailureReportedAsAConflict(t *testing.T) {
	for message, want := range map[string]int{"rbac: revision conflict for role operator": http.StatusConflict, "rbac: unknown role operator": http.StatusBadRequest} {
		recorder := httptest.NewRecorder()
		writeRBACError(recorder, errors.New(message))
		if recorder.Code != want || !strings.Contains(recorder.Body.String(), message) {
			t.Fatalf("%q: status=%d body=%s", message, recorder.Code, recorder.Body)
		}
	}
}
