package route

import (
	"context"
	"fmt"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health/grpc_health_v1"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

// ErrNoHealthyInstance is returned before any attempt is dispatched.
type ErrNoHealthyInstance struct {
	RouteID string
}

func (err ErrNoHealthyInstance) Error() string {
	return fmt.Sprintf("route %s has no healthy instance", err.RouteID)
}

// Dispatcher routes one attempt to one tool-service instance.
type Dispatcher struct {
	table       *Table
	mutex       sync.Mutex
	connections map[string]*grpc.ClientConn
}

// NewDispatcher creates a dispatcher over an instance table.
func NewDispatcher(table *Table) *Dispatcher {
	return &Dispatcher{table: table, connections: map[string]*grpc.ClientConn{}}
}

// Close releases every pooled connection.
func (dispatcher *Dispatcher) Close() {
	dispatcher.mutex.Lock()
	defer dispatcher.mutex.Unlock()
	for target, connection := range dispatcher.connections {
		_ = connection.Close()
		delete(dispatcher.connections, target)
	}
}

// Execute sends exactly one attempt and returns whatever the upstream said.
//
// It never sends a second one. Not on a timeout, not on a transport error, not
// on an UNAVAILABLE status. Whether a side effect may be attempted again depends
// on idempotency, TCC state, and pivot state that only the calling executor
// knows, and a gateway that retried on its own would make itself a second
// transaction authority (ADR-006).
func (dispatcher *Dispatcher) Execute(ctx context.Context, routeID string, request *gatewayv1.ExecuteRequest) (*gatewayv1.ExecuteResponse, error) {
	instance, err := dispatcher.table.Pick(routeID)
	if err != nil {
		return nil, ErrNoHealthyInstance{RouteID: routeID}
	}
	connection, err := dispatcher.connect(instance.Target)
	if err != nil {
		return nil, err
	}
	return gatewayv1.NewToolExecutionServiceClient(connection).Execute(ctx, request)
}

// Probe runs the gateway's own health check against one instance.
//
// It is deliberately separate from what the instance reports on its heartbeat:
// a process can believe it is serving while nothing can actually reach it.
func (dispatcher *Dispatcher) Probe(ctx context.Context, target string) error {
	connection, err := dispatcher.connect(target)
	if err != nil {
		return err
	}
	response, err := grpc_health_v1.NewHealthClient(connection).Check(ctx, &grpc_health_v1.HealthCheckRequest{})
	if err != nil {
		return err
	}
	if response.GetStatus() != grpc_health_v1.HealthCheckResponse_SERVING {
		return fmt.Errorf("route: %s reports %s", target, response.GetStatus())
	}
	return nil
}

// connect returns a pooled connection whose configuration cannot produce a
// second attempt.
//
// WithDisableRetry turns off configured retry, so an upstream cannot enable it
// through a service config either. gRPC's transparent retries remain, and are
// safe by construction: they only cover requests the server provably never saw.
func (dispatcher *Dispatcher) connect(target string) (*grpc.ClientConn, error) {
	dispatcher.mutex.Lock()
	defer dispatcher.mutex.Unlock()
	if connection, pooled := dispatcher.connections[target]; pooled {
		return connection, nil
	}
	connection, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDisableRetry(),
		grpc.WithDefaultCallOptions(grpc.WaitForReady(false)),
	)
	if err != nil {
		return nil, fmt.Errorf("route: dial %s: %w", target, err)
	}
	dispatcher.connections[target] = connection
	return connection, nil
}

// Prober periodically health-checks every known instance.
type Prober struct {
	table    *Table
	check    func(ctx context.Context, target string) error
	interval time.Duration
	timeout  time.Duration
	// OnChange runs after a probe changes an instance's state, so the registry
	// can resolve registrations that were waiting on a route to come up.
	OnChange func()
}

// NewProber creates a prober. A nil check uses the dispatcher's gRPC health call.
func NewProber(table *Table, check func(ctx context.Context, target string) error, interval, timeout time.Duration) *Prober {
	return &Prober{table: table, check: check, interval: interval, timeout: timeout}
}

// ProbeInstance checks one instance immediately and records the outcome.
//
// Registration calls it inline so a service that is already answering becomes
// routable at once, rather than waiting out a probe interval it has no way to
// observe. Without it, every service start would stall on the gateway's tick.
func (prober *Prober) ProbeInstance(ctx context.Context, instanceID, target string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, prober.timeout)
	defer cancel()
	healthy := prober.check(probeCtx, target) == nil
	prober.table.SetProbed(instanceID, healthy)
	return healthy
}

// ProbeOnce checks every instance and records the outcome.
func (prober *Prober) ProbeOnce(ctx context.Context) {
	changed := false
	for _, instance := range prober.table.Targets() {
		probeCtx, cancel := context.WithTimeout(ctx, prober.timeout)
		healthy := prober.check(probeCtx, instance.Target) == nil
		cancel()
		if healthy != instance.Probed {
			changed = true
		}
		prober.table.SetProbed(instance.InstanceID, healthy)
	}
	if changed && prober.OnChange != nil {
		prober.OnChange()
	}
}

// Run probes until the context is cancelled.
func (prober *Prober) Run(ctx context.Context) {
	ticker := time.NewTicker(prober.interval)
	defer ticker.Stop()
	prober.ProbeOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prober.ProbeOnce(ctx)
		}
	}
}
