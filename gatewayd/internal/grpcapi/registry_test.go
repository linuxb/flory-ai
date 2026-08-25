package grpcapi

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/route"
	"github.com/linuxb/flory-ai/gatewayd/internal/toolview"
)

func boolean(value bool) *bool { return &value }

// toolService is a real gRPC tool service, so registration is exercised against
// something the gateway actually has to reach and health-check rather than a
// stub that is healthy by assumption.
type toolService struct {
	gatewayv1.UnimplementedToolExecutionServiceServer
	server *grpc.Server
	health *health.Server
	target string
}

func startToolService(t *testing.T) *toolService {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	service := &toolService{server: grpc.NewServer(), health: health.NewServer(), target: listener.Addr().String()}
	gatewayv1.RegisterToolExecutionServiceServer(service.server, service)
	grpc_health_v1.RegisterHealthServer(service.server, service.health)
	service.health.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	go func() { _ = service.server.Serve(listener) }()
	t.Cleanup(service.server.Stop)
	return service
}

func (service *toolService) Execute(_ context.Context, _ *gatewayv1.ExecuteRequest) (*gatewayv1.ExecuteResponse, error) {
	return &gatewayv1.ExecuteResponse{Outcome: gatewayv1.Outcome_OUTCOME_SUCCEEDED, Result: `{}`}, nil
}

func contract(toolID string) *gatewayv1.ToolContract {
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
	}
}

type gateway struct {
	client   gatewayv1.RegistryServiceClient
	registry *registry.Registry
	table    *route.Table
	blobs    *blob.Memory
}

func startGateway(t *testing.T) *gateway {
	t.Helper()
	blobs := blob.NewMemory()
	table := route.NewTable(nil)
	dispatcher := route.NewDispatcher(table)
	t.Cleanup(dispatcher.Close)
	toolRegistry := registry.New(blobs, table)
	prober := route.NewProber(table, dispatcher.Probe, time.Hour, time.Second)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := grpc.NewServer()
	gatewayv1.RegisterRegistryServiceServer(server, NewRegistryServer(toolRegistry, table, prober, blobs))
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	connection, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return &gateway{client: gatewayv1.NewRegistryServiceClient(connection), registry: toolRegistry, table: table, blobs: blobs}
}

func instanceOf(service *toolService, instanceID string) *gatewayv1.InstanceInfo {
	return &gatewayv1.InstanceInfo{InstanceId: instanceID, RouteId: "inventory", Target: service.target, LeaseTtlMs: 30000}
}

func serving() *gatewayv1.HealthReport {
	return &gatewayv1.HealthReport{Status: gatewayv1.ServingStatus_SERVING_STATUS_SERVING}
}

// A service that is already answering must be routable the moment it registers.
// Waiting for a probe tick it cannot observe would stall every service start.
func TestRegisterProbesInlineSoAServiceIsUsableImmediately(t *testing.T) {
	ctx := context.Background()
	service := startToolService(t)
	gate := startGateway(t)

	response, err := gate.client.Register(ctx, &gatewayv1.RegisterRequest{
		Instance: instanceOf(service, "inv-1"),
		Tools:    []*gatewayv1.ToolContract{contract("inventory.check")},
		Health:   serving(),
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if state := response.GetStatuses()[0].GetState(); state != gatewayv1.ToolState_TOOL_STATE_ADMITTED {
		t.Fatalf("inventory.check is %s after registering a live service, want ADMITTED", state)
	}
	if !gate.table.Routable("inventory") {
		t.Fatal("a live, registered instance is not routable")
	}
	if response.GetView().GetToolViewDigest() == "" {
		t.Fatal("registration returned no tool-view digest")
	}
}

// The gateway keeps no durable registry, so its whole recovery story is that a
// service is told its instance is unknown and registers again.
func TestHeartbeatTellsAServiceTheGatewayForgotIt(t *testing.T) {
	ctx := context.Background()
	service := startToolService(t)
	gate := startGateway(t)

	if _, err := gate.client.Register(ctx, &gatewayv1.RegisterRequest{
		Instance: instanceOf(service, "inv-1"), Tools: []*gatewayv1.ToolContract{contract("inventory.check")}, Health: serving(),
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	beat, err := gate.client.Heartbeat(ctx, &gatewayv1.HeartbeatRequest{InstanceId: "inv-1", Health: serving()})
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if !beat.GetKnownInstance() {
		t.Fatal("a registered instance was reported unknown")
	}

	forgotten, err := gate.client.Heartbeat(ctx, &gatewayv1.HeartbeatRequest{InstanceId: "inv-2", Health: serving()})
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if forgotten.GetKnownInstance() {
		t.Fatal("an instance the gateway never saw was reported as known")
	}
}

// Deregistration withdraws a route, never a contract. A frozen subgraph that
// pinned this view must still resolve it after the service that served it left.
func TestDeregisterLeavesThePublishedViewIntact(t *testing.T) {
	ctx := context.Background()
	service := startToolService(t)
	gate := startGateway(t)

	registered, err := gate.client.Register(ctx, &gatewayv1.RegisterRequest{
		Instance: instanceOf(service, "inv-1"), Tools: []*gatewayv1.ToolContract{contract("inventory.check")}, Health: serving(),
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	digest := registered.GetView().GetToolViewDigest()

	if _, err := gate.client.Deregister(ctx, &gatewayv1.DeregisterRequest{InstanceId: "inv-1"}); err != nil {
		t.Fatalf("deregister: %v", err)
	}
	if gate.table.Routable("inventory") {
		t.Fatal("a deregistered instance is still routable")
	}
	view, err := gate.client.GetToolView(ctx, &gatewayv1.GetToolViewRequest{})
	if err != nil {
		t.Fatalf("get tool view: %v", err)
	}
	if view.GetView().GetToolViewDigest() != digest {
		t.Fatalf("deregistration changed the published digest from %s to %s", digest, view.GetView().GetToolViewDigest())
	}
}

func TestGetToolViewResolvesAnExactDigestAndVerifiesIt(t *testing.T) {
	ctx := context.Background()
	service := startToolService(t)
	gate := startGateway(t)

	registered, err := gate.client.Register(ctx, &gatewayv1.RegisterRequest{
		Instance: instanceOf(service, "inv-1"), Tools: []*gatewayv1.ToolContract{contract("inventory.check")}, Health: serving(),
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	digest := registered.GetView().GetToolViewDigest()

	resolved, err := gate.client.GetToolView(ctx, &gatewayv1.GetToolViewRequest{ToolViewDigest: digest})
	if err != nil {
		t.Fatalf("get tool view by digest: %v", err)
	}
	// The document is returned verbatim so a caller can re-derive the digest
	// instead of trusting the gateway's word for what it served.
	if toolview.Digest([]byte(resolved.GetDocument())) != digest {
		t.Fatal("the returned document does not canonicalise to the digest it was fetched by")
	}

	if _, err := gate.client.GetToolView(ctx, &gatewayv1.GetToolViewRequest{ToolViewDigest: "sha256:" + strings.Repeat("c", 64)}); err == nil {
		t.Fatal("an unstored digest resolved to something")
	}
}

// A registered but unreachable instance must not make its tools plannable: the
// gateway's own probe is the evidence, not the service's claim about itself.
func TestAnUnreachableInstanceIsNotAdmitted(t *testing.T) {
	ctx := context.Background()
	gate := startGateway(t)
	unreachable := &gatewayv1.InstanceInfo{InstanceId: "inv-1", RouteId: "inventory", Target: "127.0.0.1:1", LeaseTtlMs: 30000}

	response, err := gate.client.Register(ctx, &gatewayv1.RegisterRequest{
		Instance: unreachable, Tools: []*gatewayv1.ToolContract{contract("inventory.check")}, Health: serving(),
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if state := response.GetStatuses()[0].GetState(); state == gatewayv1.ToolState_TOOL_STATE_ADMITTED {
		t.Fatal("a tool on an unreachable instance was published")
	}
	if gate.registry.Current() != nil && len(gate.registry.Current().Published.Document.Tools) != 0 {
		t.Fatal("an unreachable service's tools reached the published view")
	}
}
