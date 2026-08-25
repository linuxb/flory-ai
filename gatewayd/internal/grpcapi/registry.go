// Package grpcapi implements the gateway's south side: the registration surface
// tool services reach through the SDK.
package grpcapi

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/route"
	"github.com/linuxb/flory-ai/gatewayd/internal/toolview"
)

// RegistryServer serves RegistryService.
type RegistryServer struct {
	gatewayv1.UnimplementedRegistryServiceServer
	registry *registry.Registry
	table    *route.Table
	prober   *route.Prober
	blobs    blob.Store
}

// NewRegistryServer wires the registration surface to the registry, the instance
// table, and the blob store that holds every published view.
func NewRegistryServer(toolRegistry *registry.Registry, table *route.Table, prober *route.Prober, blobs blob.Store) *RegistryServer {
	return &RegistryServer{registry: toolRegistry, table: table, prober: prober, blobs: blobs}
}

// Register records an instance and admits the contracts it declares.
//
// The instance is recorded first and probed inline, so a service that is already
// answering is routable by the time its contracts are resolved. Without the
// inline probe every service start would stall on the gateway's probe tick,
// which the service has no way to observe or wait for.
func (server *RegistryServer) Register(ctx context.Context, request *gatewayv1.RegisterRequest) (*gatewayv1.RegisterResponse, error) {
	if request.GetInstance() == nil {
		return nil, status.Error(codes.InvalidArgument, "instance is required")
	}
	if err := server.table.Upsert(request.GetInstance(), request.GetHealth()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if server.prober != nil {
		server.prober.ProbeInstance(ctx, request.GetInstance().GetInstanceId(), request.GetInstance().GetTarget())
	}
	statuses, err := server.registry.Register(ctx, request.GetTools())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &gatewayv1.RegisterResponse{Statuses: statuses, View: server.currentRef()}, nil
}

// Heartbeat renews an instance's lease and carries its self-reported health.
//
// A false known_instance is how a service learns the gateway restarted and lost
// its registrations, which is its cue to register again. That is the whole
// recovery story for a gateway that deliberately keeps no durable registry.
func (server *RegistryServer) Heartbeat(ctx context.Context, request *gatewayv1.HeartbeatRequest) (*gatewayv1.HeartbeatResponse, error) {
	if request.GetInstanceId() == "" {
		return nil, status.Error(codes.InvalidArgument, "instance_id is required")
	}
	known := server.table.Heartbeat(request.GetInstanceId(), request.GetHealth(), 0)
	if known {
		// A serving report can complete a cluster that registered while its route
		// was still coming up, so a heartbeat is also a resolution trigger.
		if err := server.registry.Resolve(ctx); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	return &gatewayv1.HeartbeatResponse{KnownInstance: known, View: server.currentRef()}, nil
}

// Deregister drops an instance on a graceful shutdown.
//
// It removes a route and never a contract: the published view and its digest are
// unchanged, so a call for that tool fails as unroutable rather than as unknown,
// and a frozen subgraph that pinned the view still resolves it.
func (server *RegistryServer) Deregister(_ context.Context, request *gatewayv1.DeregisterRequest) (*gatewayv1.DeregisterResponse, error) {
	if request.GetInstanceId() == "" {
		return nil, status.Error(codes.InvalidArgument, "instance_id is required")
	}
	server.table.Remove(request.GetInstanceId())
	return &gatewayv1.DeregisterResponse{}, nil
}

// GetToolView resolves the current view, or an exact historical one by digest.
func (server *RegistryServer) GetToolView(ctx context.Context, request *gatewayv1.GetToolViewRequest) (*gatewayv1.GetToolViewResponse, error) {
	digest := request.GetToolViewDigest()
	if digest == "" {
		current := server.registry.Current()
		if current == nil {
			return nil, status.Error(codes.NotFound, "no tool view has been published yet")
		}
		return &gatewayv1.GetToolViewResponse{
			View:     &gatewayv1.ToolViewRef{ToolViewRef: current.Published.Ref, ToolViewDigest: current.Published.Digest},
			Document: string(current.Published.Canonical),
		}, nil
	}
	if !toolview.DigestPattern.MatchString(digest) {
		return nil, status.Errorf(codes.InvalidArgument, "tool_view_digest %q is not a sha256 digest", digest)
	}
	stored, err := server.blobs.Get(ctx, toolview.Ref(digest))
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			return nil, status.Errorf(codes.NotFound, "tool view %s is not stored", digest)
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	published, err := toolview.Parse(stored, digest)
	if err != nil {
		return nil, status.Error(codes.DataLoss, err.Error())
	}
	return &gatewayv1.GetToolViewResponse{
		View:     &gatewayv1.ToolViewRef{ToolViewRef: published.Ref, ToolViewDigest: published.Digest},
		Document: string(published.Canonical),
	}, nil
}

func (server *RegistryServer) currentRef() *gatewayv1.ToolViewRef {
	current := server.registry.Current()
	if current == nil {
		return nil
	}
	return &gatewayv1.ToolViewRef{ToolViewRef: current.Published.Ref, ToolViewDigest: current.Published.Digest}
}

// LeaseSweepInterval is how often a running gateway re-resolves registrations so
// an expired lease stops gating a route.
const LeaseSweepInterval = 5 * time.Second
