package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	"github.com/linuxb/flory-ai/gatewayd/internal/grpcapi"
	"github.com/linuxb/flory-ai/gatewayd/internal/httpapi"
	"github.com/linuxb/flory-ai/gatewayd/internal/mcp"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/route"
)

// gateway is a complete gatewayd running in-process: real registration surface,
// real routing, real MCP. The SDK is exercised against the thing it will face in
// production rather than against a stand-in that is agreeable by construction.
type gateway struct {
	address  string
	mcp      *httptest.Server
	registry *registry.Registry
	table    *route.Table
	prober   *route.Prober
}

func startGateway(t *testing.T) *gateway {
	t.Helper()
	blobs := blob.NewMemory()
	table := route.NewTable(nil)
	dispatcher := route.NewDispatcher(table)
	t.Cleanup(dispatcher.Close)
	toolRegistry := registry.New(blobs, table)
	prober := route.NewProber(table, dispatcher.Probe, time.Hour, 2*time.Second)
	prober.OnChange = func() { _ = toolRegistry.Resolve(context.Background()) }

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := grpc.NewServer()
	gatewayv1.RegisterRegistryServiceServer(server, grpcapi.NewRegistryServer(toolRegistry, table, prober, blobs))
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	mcpServer := httptest.NewServer(httpapi.New(mcp.NewServer(toolRegistry, dispatcher, blobs), toolRegistry))
	t.Cleanup(mcpServer.Close)
	return &gateway{address: listener.Addr().String(), mcp: mcpServer, registry: toolRegistry, table: table, prober: prober}
}

// call drives the MCP surface the way an executor would.
func (gate *gateway) call(t *testing.T, method string, params any) (map[string]any, map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	response, err := http.Post(gate.mcp.URL+"/mcp", "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer response.Body.Close()
	var decoded struct {
		Result map[string]any `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return decoded.Result, decoded.Error
}

func (gate *gateway) digest(t *testing.T) string {
	t.Helper()
	current := gate.registry.Current()
	if current == nil {
		t.Fatal("nothing has been published")
	}
	return current.Published.Digest
}

// inventoryService is a minimal tool service built on the SDK.
type inventoryService struct {
	service *Service
	calls   atomic.Int64
}

func checkContract() Contract {
	return Contract{
		ToolID:              "inventory.check",
		ToolVersion:         "1.0.0",
		Description:         "Report available stock",
		InputSchema:         `{"type":"object","properties":{"sku":{"type":"string"}},"required":["sku"],"additionalProperties":false}`,
		OutputSchema:        `{"type":"object"}`,
		EffectClass:         EffectNone,
		Mode:                ModePlain,
		IdempotentRetryable: true,
		Footprint:           []string{"inventory:{sku}"},
		TimeoutMS:           5000,
		Retry:               DefaultRetry(),
		Owner:               "inventory-team",
	}
}

func startService(t *testing.T, gate *gateway, instanceID string, contracts ...Contract) *inventoryService {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	service, err := NewService(Config{
		InstanceID:        instanceID,
		RouteID:           "inventory",
		Target:            listener.Addr().String(),
		GatewayAddress:    gate.address,
		HeartbeatInterval: 50 * time.Millisecond,
		Logger:            slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	built := &inventoryService{service: service}
	if len(contracts) == 0 {
		contracts = []Contract{checkContract()}
	}
	tools := make([]Tool, 0, len(contracts))
	for _, contract := range contracts {
		tools = append(tools, Tool{Contract: contract, Handler: func(_ context.Context, call Call) Result {
			built.calls.Add(1)
			var arguments struct {
				SKU string `json:"sku"`
			}
			_ = call.Arg(&arguments)
			return Result{Outcome: OutcomeSucceeded, Value: map[string]any{"available": 7, "sku": arguments.SKU}}
		}})
	}
	if err := service.Declare(tools...); err != nil {
		t.Fatalf("declare: %v", err)
	}
	go func() { _ = service.Serve(listener) }()
	service.SetServing(true)
	t.Cleanup(func() { _ = service.Shutdown(context.Background()) })
	return built
}

func registerService(t *testing.T, built *inventoryService) []*gatewayv1.ToolStatus {
	t.Helper()
	statuses, err := built.service.Register(context.Background())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return statuses
}

func reasonOf(t *testing.T, failure map[string]any) string {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a refusal, got a result")
	}
	data, _ := failure["data"].(map[string]any)
	reason, _ := data["reason"].(string)
	return reason
}

// The registration a service publishes must be exactly what a planner then
// reads, including the transaction metadata it derives structure from.
func TestRegistrationPublishesWhatTheServiceDeclared(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	statuses := registerService(t, built)

	if statuses[0].GetState() != gatewayv1.ToolState_TOOL_STATE_ADMITTED {
		t.Fatalf("inventory.check is %s (%s)", statuses[0].GetState(), statuses[0].GetDetail())
	}
	result, failure := gate.call(t, "tools/list", map[string]any{})
	if failure != nil {
		t.Fatalf("tools/list: %v", failure)
	}
	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("the view lists %d tools; no tool should appear that no service declared", len(tools))
	}
	entry, _ := tools[0].(map[string]any)
	metadata, _ := entry["metadata"].(map[string]any)
	transaction, _ := metadata["flory_transaction"].(map[string]any)
	if transaction["effect_class"] != "none" || transaction["mode"] != "plain" {
		t.Fatalf("flory_transaction = %v", transaction)
	}
	if _, declared := transaction["is_pivot"]; declared {
		t.Fatal("the listing declares is_pivot, which a planner must derive from effect_class")
	}
}

// A restarted service re-registers exactly what it registered before, which must
// not move the digest a planner may already have pinned.
func TestIdenticalReRegistrationLeavesTheDigestUnchanged(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	registerService(t, built)
	first := gate.digest(t)
	registerService(t, built)
	if gate.digest(t) != first {
		t.Fatalf("re-registering the same contracts moved the digest from %s to %s", first, gate.digest(t))
	}
}

func TestDeclareRejectsAnUnregistrableContractBeforeAnyNetworkCall(t *testing.T) {
	gate := startGateway(t)
	service, err := NewService(Config{InstanceID: "inv-1", RouteID: "inventory", Target: "127.0.0.1:1", GatewayAddress: gate.address})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	t.Run("a reversible tool with no undo path", func(t *testing.T) {
		bad := checkContract()
		bad.ToolID = "inventory.rollback"
		bad.EffectClass = EffectReversible
		if err := service.Declare(Tool{Contract: bad, Handler: nil}); err == nil {
			t.Fatal("a reversible tool with no undo path was declared")
		}
	})
	t.Run("snapshot compensation cannot be expressed at all", func(t *testing.T) {
		// A service marks a tool Compensating and the SDK builds it as delta. There
		// is no snapshot spelling to choose, so discipline 17 is discharged by the
		// declaration surface rather than by a check a caller could route around.
		compensating := checkContract()
		compensating.ToolID = "inventory.release"
		compensating.EffectClass = EffectBufferable
		compensating.Compensating = true
		built, err := compensating.Build("inventory")
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		if built.GetCompensationStyle() != gatewayv1.CompensationStyle_COMPENSATION_STYLE_DELTA {
			t.Fatalf("compensation style = %s, want delta", built.GetCompensationStyle())
		}
	})
	t.Run("saga with no compensator", func(t *testing.T) {
		bad := checkContract()
		bad.ToolID = "order.place"
		bad.EffectClass = EffectReversible
		bad.Mode = ModeSaga
		if err := service.Declare(Tool{Contract: bad, Handler: nil}); err == nil {
			t.Fatal("a saga with no compensate_tool was declared")
		}
	})
	t.Run("an irreversible tool that claims an undo path", func(t *testing.T) {
		bad := checkContract()
		bad.ToolID = "inventory.commit"
		bad.EffectClass = EffectIrreversible
		bad.CompensateTool = "inventory.release"
		if err := service.Declare(Tool{Contract: bad, Handler: nil}); err == nil {
			t.Fatal("an irreversible tool declaring compensation was declared")
		}
	})
}

// Contract identity and operational membership are independent. A lease that
// lapses must stop routing without changing what the view says the tool is.
func TestALapsedLeaseStopsRoutingButLeavesTheViewIntact(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	registerService(t, built)
	digest := gate.digest(t)

	// Simulate the lease lapsing rather than waiting it out.
	gate.table.Remove("inv-1")
	if err := gate.registry.Resolve(context.Background()); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if gate.digest(t) != digest {
		t.Fatal("losing an instance changed the published digest")
	}
	result, _ := gate.call(t, "tools/list", map[string]any{})
	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatal("losing an instance withdrew the contract from the listing")
	}
	_, failure := gate.call(t, "tools/call", map[string]any{
		"name": "inventory.check", "arguments": map[string]any{"sku": "SKU-1"},
		"_meta": map[string]any{"tool_version": "1.0.0", "tool_view_digest": digest},
	})
	if reason := reasonOf(t, failure); reason != mcp.ReasonRouteUnhealthy {
		t.Fatalf("reason = %q, want %q", reason, mcp.ReasonRouteUnhealthy)
	}
}

// A service that knows it cannot work says so, and stops receiving attempts
// without deregistering or losing its place in the view.
func TestNotServingStopsDispatchWithoutReachingTheHandler(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	registerService(t, built)
	digest := gate.digest(t)

	built.service.SetServing(false)
	// The gateway learns this two ways; drive both so neither alone is credited.
	gate.prober.ProbeOnce(context.Background())
	if _, err := built.service.registryClient(); err != nil {
		t.Fatalf("client: %v", err)
	}
	gate.table.Heartbeat("inv-1", &gatewayv1.HealthReport{Status: gatewayv1.ServingStatus_SERVING_STATUS_NOT_SERVING}, time.Minute)

	_, failure := gate.call(t, "tools/call", map[string]any{
		"name": "inventory.check", "arguments": map[string]any{"sku": "SKU-1"},
		"_meta": map[string]any{"tool_version": "1.0.0", "tool_view_digest": digest},
	})
	if reason := reasonOf(t, failure); reason != mcp.ReasonRouteUnhealthy {
		t.Fatalf("reason = %q, want %q", reason, mcp.ReasonRouteUnhealthy)
	}
	if built.calls.Load() != 0 {
		t.Fatalf("the handler ran %d times while the service reported not serving", built.calls.Load())
	}
}

// The whole recovery story for a gateway that keeps no durable registry: it
// restarts empty, tells each service it does not know it, and every live service
// registers again -- rebuilding the identical digest, because the canonical
// encoding does not depend on which process produced it.
func TestAServiceReRegistersAfterTheGatewayForgetsIt(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	registerService(t, built)
	original := gate.digest(t)

	replacement := startGateway(t)
	built.service.config.GatewayAddress = replacement.address
	built.service.clientMutex.Lock()
	built.service.connection, built.service.client = nil, nil
	built.service.clientMutex.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = built.service.Run(ctx) }()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if current := replacement.registry.Current(); current != nil && len(current.Published.Document.Tools) == 1 {
			if current.Published.Digest != original {
				t.Fatalf("the rebuilt view has digest %s, want the original %s", current.Published.Digest, original)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the service never re-registered with the replacement gateway")
}

// Deregistration withdraws a route, not a contract.
func TestShutdownLeavesTheContractPublished(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	registerService(t, built)
	digest := gate.digest(t)

	if err := built.service.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if gate.digest(t) != digest {
		t.Fatal("shutting a service down changed the published digest")
	}
	if gate.table.Routable("inventory") {
		t.Fatal("a shut-down instance is still routable")
	}
}

// The end-to-end path: an executor's call reaches the handler exactly once, and
// a refused call reaches it not at all.
func TestAnAttemptReachesTheHandlerExactlyOnce(t *testing.T) {
	gate := startGateway(t)
	built := startService(t, gate, "inv-1")
	registerService(t, built)
	digest := gate.digest(t)

	result, failure := gate.call(t, "tools/call", map[string]any{
		"name": "inventory.check", "arguments": map[string]any{"sku": "SKU-1"},
		"_meta": map[string]any{"run_id": "run-1", "vertex_id": "v-1", "tool_version": "1.0.0", "tool_view_digest": digest, "attempt": 1},
	})
	if failure != nil {
		t.Fatalf("tools/call: %v", failure)
	}
	structured, _ := result["structuredContent"].(map[string]any)
	if structured["outcome"] != "succeeded" {
		t.Fatalf("outcome = %v", structured["outcome"])
	}
	value, _ := structured["result"].(map[string]any)
	if value["sku"] != "SKU-1" {
		t.Fatalf("the handler did not receive the arguments: %v", value)
	}
	if built.calls.Load() != 1 {
		t.Fatalf("the handler ran %d times, want exactly 1", built.calls.Load())
	}

	// Every gateway refusal must be decided before the service is touched.
	for name, params := range map[string]map[string]any{
		"bad arguments": {"name": "inventory.check", "arguments": map[string]any{"skew": "x"},
			"_meta": map[string]any{"tool_version": "1.0.0", "tool_view_digest": digest}},
		"unknown digest": {"name": "inventory.check", "arguments": map[string]any{"sku": "x"},
			"_meta": map[string]any{"tool_version": "1.0.0", "tool_view_digest": "sha256:" + strings.Repeat("d", 64)}},
		"absent version": {"name": "inventory.check", "arguments": map[string]any{"sku": "x"},
			"_meta": map[string]any{"tool_version": "9.9.9", "tool_view_digest": digest}},
	} {
		if _, failure := gate.call(t, "tools/call", params); failure == nil {
			t.Fatalf("%s was not refused", name)
		}
	}
	if built.calls.Load() != 1 {
		t.Fatalf("refused calls reached the handler: %d total runs, want 1", built.calls.Load())
	}
}

// Two services declaring one contract must produce the same registration, or the
// tool view's identity would depend on which language published it.
func TestContractProjectionIsStable(t *testing.T) {
	first, err := checkContract().Build("inventory")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	second, err := checkContract().Build("inventory")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	metadataFirst, err := Metadata(first)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	metadataSecond, err := Metadata(second)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if fmt.Sprint(metadataFirst) != fmt.Sprint(metadataSecond) {
		t.Fatalf("metadata differs across builds: %v vs %v", metadataFirst, metadataSecond)
	}
}
