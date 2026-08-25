package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/route"
)

func boolean(value bool) *bool { return &value }

// countingDispatcher records every attempt, so a test can assert not just what
// came back but how many times the upstream was actually touched.
type countingDispatcher struct {
	mutex    sync.Mutex
	attempts []*gatewayv1.ExecuteRequest
	response *gatewayv1.ExecuteResponse
	failure  error
}

func (dispatcher *countingDispatcher) Execute(_ context.Context, _ string, request *gatewayv1.ExecuteRequest) (*gatewayv1.ExecuteResponse, error) {
	dispatcher.mutex.Lock()
	defer dispatcher.mutex.Unlock()
	dispatcher.attempts = append(dispatcher.attempts, request)
	return dispatcher.response, dispatcher.failure
}

func (dispatcher *countingDispatcher) count() int {
	dispatcher.mutex.Lock()
	defer dispatcher.mutex.Unlock()
	return len(dispatcher.attempts)
}

func reserveContract() *gatewayv1.ToolContract {
	return &gatewayv1.ToolContract{
		ToolId:            "inventory.check",
		ToolVersion:       "1.0.0",
		Description:       "Report available stock",
		InputSchema:       `{"type":"object","properties":{"sku":{"type":"string"}},"required":["sku"],"additionalProperties":false}`,
		OutputSchema:      `{"type":"object"}`,
		RouteId:           "inventory",
		Adapter:           &gatewayv1.AdapterSpec{Protocol: "grpc"},
		Txn:               &gatewayv1.TransactionSpec{EffectClass: gatewayv1.EffectClass_EFFECT_CLASS_NONE, Mode: gatewayv1.ToolMode_TOOL_MODE_PLAIN, IdempotentRetryable: boolean(true)},
		CompensationStyle: gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING,
		TimeoutMs:         5000,
		RetryConstraints:  &gatewayv1.RetryConstraints{MaxAttempts: 3, InitialBackoffMs: 100, MultiplierMilli: 2000, MaxBackoffMs: 5000},
		Owner:             "inventory-team",
	}
}

type harness struct {
	server     *Server
	registry   *registry.Registry
	dispatcher *countingDispatcher
	blobs      *blob.Memory
}

func newHarness(t *testing.T, contracts ...*gatewayv1.ToolContract) *harness {
	t.Helper()
	blobs := blob.NewMemory()
	toolRegistry := registry.New(blobs, nil)
	if _, err := toolRegistry.Register(context.Background(), contracts); err != nil {
		t.Fatalf("register: %v", err)
	}
	dispatcher := &countingDispatcher{response: &gatewayv1.ExecuteResponse{Outcome: gatewayv1.Outcome_OUTCOME_SUCCEEDED, Result: `{"available":7}`}}
	return &harness{server: NewServer(toolRegistry, dispatcher, blobs), registry: toolRegistry, dispatcher: dispatcher, blobs: blobs}
}

func (test *harness) call(t *testing.T, method string, params any) (map[string]any, *rpcError) {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	recorder := httptest.NewRecorder()
	test.server.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(encoded)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("HTTP status %d", recorder.Code)
	}
	var response struct {
		Result map[string]any `json:"result"`
		Error  *rpcError      `json:"error"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response.Result, response.Error
}

func reasonOf(t *testing.T, failure *rpcError) string {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a refusal, got a result")
	}
	data, isMap := failure.Data.(map[string]any)
	if !isMap {
		t.Fatalf("refusal %q carries no reason", failure.Message)
	}
	reason, _ := data["reason"].(string)
	return reason
}

func currentDigest(t *testing.T, test *harness) string {
	t.Helper()
	view := test.registry.Current()
	if view == nil {
		t.Fatal("nothing was published")
	}
	return view.Published.Digest
}

func TestToolsListPublishesTransactionMetadataWithoutDerivedAttributes(t *testing.T) {
	test := newHarness(t, reserveContract())
	result, failure := test.call(t, "tools/list", map[string]any{})
	if failure != nil {
		t.Fatalf("tools/list: %v", failure)
	}
	meta, _ := result["_meta"].(map[string]any)
	if meta["tool_view_digest"] != currentDigest(t, test) {
		t.Fatalf("_meta reports %v, want the current digest", meta["tool_view_digest"])
	}
	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools/list returned %d tools, want 1", len(tools))
	}
	entry, _ := tools[0].(map[string]any)
	if entry["name"] != "inventory.check" {
		t.Fatalf("tool name = %v", entry["name"])
	}
	if entry["inputSchema"] == nil {
		t.Fatal("the listing carries no inputSchema for a planner to validate against")
	}
	metadata, _ := entry["metadata"].(map[string]any)
	transaction, isMap := metadata["flory_transaction"].(map[string]any)
	if !isMap {
		t.Fatalf("metadata carries no flory_transaction: %v", metadata)
	}
	if transaction["effect_class"] != "none" {
		t.Fatalf("effect_class = %v", transaction["effect_class"])
	}
	if _, declared := transaction["is_pivot"]; declared {
		t.Fatal("flory_transaction declares is_pivot, which is derived from effect_class")
	}
}

func TestToolsCallDispatchesExactlyOneAttempt(t *testing.T) {
	test := newHarness(t, reserveContract())
	result, failure := test.call(t, "tools/call", map[string]any{
		"name":      "inventory.check",
		"arguments": map[string]any{"sku": "SKU-1"},
		"_meta":     map[string]any{"run_id": "run-1", "vertex_id": "vertex-1", "tool_version": "1.0.0", "tool_view_digest": currentDigest(t, test), "attempt": 1},
	})
	if failure != nil {
		t.Fatalf("tools/call: %v", failure)
	}
	structured, _ := result["structuredContent"].(map[string]any)
	if structured["outcome"] != "succeeded" {
		t.Fatalf("outcome = %v", structured["outcome"])
	}
	if test.dispatcher.count() != 1 {
		t.Fatalf("dispatched %d attempts, want exactly 1", test.dispatcher.count())
	}
	sent := test.dispatcher.attempts[0]
	if sent.GetToolVersion() != "1.0.0" || sent.GetToolViewDigest() != currentDigest(t, test) {
		t.Fatalf("the attempt did not carry the caller's pin: %+v", sent)
	}
}

// A failing upstream is answered once. Whether the same side effect may be
// attempted again is the executor's decision, not the gateway's.
func TestToolsCallNeverRetriesAFailingUpstream(t *testing.T) {
	test := newHarness(t, reserveContract())
	test.dispatcher.response = nil
	test.dispatcher.failure = fmt.Errorf("connection reset")
	result, failure := test.call(t, "tools/call", map[string]any{
		"name":      "inventory.check",
		"arguments": map[string]any{"sku": "SKU-1"},
		"_meta":     map[string]any{"tool_version": "1.0.0", "tool_view_digest": currentDigest(t, test), "attempt": 1},
	})
	if failure != nil {
		t.Fatalf("a transport failure was reported as a refusal: %v", failure)
	}
	structured, _ := result["structuredContent"].(map[string]any)
	// The attempt left the gateway, so whether it took effect is unknowable here.
	// Reporting it as retryable would authorise a duplicate side effect.
	if structured["outcome"] != "unknown" {
		t.Fatalf("outcome = %v, want unknown", structured["outcome"])
	}
	if test.dispatcher.count() != 1 {
		t.Fatalf("dispatched %d attempts after a failure, want exactly 1", test.dispatcher.count())
	}
}

func TestToolsCallRefusesAnUnhealthyRouteBeforeDispatch(t *testing.T) {
	test := newHarness(t, reserveContract())
	test.dispatcher.response = nil
	test.dispatcher.failure = route.ErrNoHealthyInstance{RouteID: "inventory"}
	_, failure := test.call(t, "tools/call", map[string]any{
		"name":      "inventory.check",
		"arguments": map[string]any{"sku": "SKU-1"},
		"_meta":     map[string]any{"tool_version": "1.0.0", "tool_view_digest": currentDigest(t, test)},
	})
	if reason := reasonOf(t, failure); reason != ReasonRouteUnhealthy {
		t.Fatalf("reason = %q, want %q", reason, ReasonRouteUnhealthy)
	}
}

// Validation happens at the gateway, against the frozen schema, before anything
// reaches a tool service.
func TestToolsCallRejectsArgumentsAgainstTheFrozenSchema(t *testing.T) {
	test := newHarness(t, reserveContract())
	_, failure := test.call(t, "tools/call", map[string]any{
		"name":      "inventory.check",
		"arguments": map[string]any{"skew": "SKU-1"},
		"_meta":     map[string]any{"tool_version": "1.0.0", "tool_view_digest": currentDigest(t, test)},
	})
	if reason := reasonOf(t, failure); reason != ReasonSchemaViolation {
		t.Fatalf("reason = %q, want %q", reason, ReasonSchemaViolation)
	}
	if test.dispatcher.count() != 0 {
		t.Fatalf("%d attempts reached the tool service despite invalid arguments", test.dispatcher.count())
	}
}

func TestToolsCallRefusesAnUnknownDigestInsteadOfServingTheCurrentView(t *testing.T) {
	test := newHarness(t, reserveContract())
	_, failure := test.call(t, "tools/call", map[string]any{
		"name":      "inventory.check",
		"arguments": map[string]any{"sku": "SKU-1"},
		"_meta":     map[string]any{"tool_version": "1.0.0", "tool_view_digest": "sha256:" + strings.Repeat("b", 64)},
	})
	if reason := reasonOf(t, failure); reason != ReasonUnknownToolView {
		t.Fatalf("reason = %q, want %q", reason, ReasonUnknownToolView)
	}
	if test.dispatcher.count() != 0 {
		t.Fatal("an attempt was dispatched against a view that does not exist")
	}
}

// Pinning is the whole mechanism by which a frozen subgraph keeps seeing the
// contract it was admitted against, so a superseded version must fail rather
// than silently resolve to whatever is newest.
func TestToolsCallNeverUpgradesToANewerVersion(t *testing.T) {
	test := newHarness(t, reserveContract())
	newer := reserveContract()
	newer.ToolVersion = "2.0.0"
	if _, err := test.registry.Register(context.Background(), []*gatewayv1.ToolContract{newer}); err != nil {
		t.Fatalf("register newer: %v", err)
	}
	_, failure := test.call(t, "tools/call", map[string]any{
		"name":      "inventory.check",
		"arguments": map[string]any{"sku": "SKU-1"},
		"_meta":     map[string]any{"tool_version": "3.0.0", "tool_view_digest": currentDigest(t, test)},
	})
	if reason := reasonOf(t, failure); reason != ReasonVersionAbsent {
		t.Fatalf("reason = %q, want %q", reason, ReasonVersionAbsent)
	}
	if test.dispatcher.count() != 0 {
		t.Fatal("an attempt was dispatched for a version the view does not contain")
	}
}

// A frozen subgraph keeps resolving its recorded digest after the registry has
// moved on, which is exactly what makes replay independent of current state.
func TestASupersededViewStaysResolvableFromBlobStorage(t *testing.T) {
	test := newHarness(t, reserveContract())
	first := currentDigest(t, test)

	newer := reserveContract()
	newer.ToolVersion = "2.0.0"
	if _, err := test.registry.Register(context.Background(), []*gatewayv1.ToolContract{newer}); err != nil {
		t.Fatalf("register newer: %v", err)
	}
	if currentDigest(t, test) == first {
		t.Fatal("publishing a new version did not change the current digest")
	}

	result, failure := test.call(t, "tools/list", map[string]any{"tool_view_digest": first})
	if failure != nil {
		t.Fatalf("the superseded view is no longer resolvable: %v", failure)
	}
	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("the superseded view lists %d tools, want the 1 it was published with", len(tools))
	}
	meta, _ := result["_meta"].(map[string]any)
	if meta["tool_view_digest"] != first {
		t.Fatalf("resolving %s returned %v", first, meta["tool_view_digest"])
	}
}

func TestUnknownMethodIsReportedAsSuch(t *testing.T) {
	test := newHarness(t, reserveContract())
	_, failure := test.call(t, "tools/destroy", map[string]any{})
	if failure == nil || failure.Code != codeMethodNotFound {
		t.Fatalf("unknown method reported %v", failure)
	}
}

func TestInitializeAdvertisesTools(t *testing.T) {
	test := newHarness(t, reserveContract())
	result, failure := test.call(t, "initialize", map[string]any{})
	if failure != nil {
		t.Fatalf("initialize: %v", failure)
	}
	capabilities, _ := result["capabilities"].(map[string]any)
	if _, advertised := capabilities["tools"]; !advertised {
		t.Fatalf("initialize does not advertise tools: %v", result)
	}
}
