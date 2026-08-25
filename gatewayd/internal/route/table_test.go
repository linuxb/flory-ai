package route

import (
	"context"
	"errors"
	"testing"
	"time"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

// clock is an injected time source, so lease expiry is exercised by advancing it
// rather than by sleeping.
type clock struct{ instant time.Time }

func (c *clock) now() time.Time           { return c.instant }
func (c *clock) advance(by time.Duration) { c.instant = c.instant.Add(by) }

var errUnreachable = errors.New("unreachable")

func serving() *gatewayv1.HealthReport {
	return &gatewayv1.HealthReport{Status: gatewayv1.ServingStatus_SERVING_STATUS_SERVING}
}

func notServing() *gatewayv1.HealthReport {
	return &gatewayv1.HealthReport{Status: gatewayv1.ServingStatus_SERVING_STATUS_NOT_SERVING}
}

func instanceInfo(instanceID, routeID, target string) *gatewayv1.InstanceInfo {
	return &gatewayv1.InstanceInfo{InstanceId: instanceID, RouteId: routeID, Target: target, LeaseTtlMs: 30000}
}

func newTestTable(t *testing.T) (*Table, *clock) {
	t.Helper()
	moment := &clock{instant: time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)}
	return NewTable(moment.now), moment
}

// A registration alone is not evidence that anything can be reached, so a new
// instance is not routable until the gateway has confirmed it for itself.
func TestNewInstanceIsNotRoutableUntilProbed(t *testing.T) {
	table, _ := newTestTable(t)
	if err := table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving()); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if table.Routable("inventory") {
		t.Fatal("an unprobed instance was routable on its own say-so")
	}
	table.SetProbed("inv-1", true)
	if !table.Routable("inventory") {
		t.Fatal("a probed, serving instance with a live lease is not routable")
	}
}

// The two health signals are independent evidence: a process can believe it is
// serving while nothing can reach it, and can be reachable while knowing it is
// not ready. Either one failing must stop routing.
func TestEitherHealthSignalStopsRouting(t *testing.T) {
	t.Run("the instance reports not serving", func(t *testing.T) {
		table, _ := newTestTable(t)
		_ = table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving())
		table.SetProbed("inv-1", true)
		table.Heartbeat("inv-1", notServing(), 30*time.Second)
		if table.Routable("inventory") {
			t.Fatal("an instance that reported not-serving was still routable")
		}
	})
	t.Run("the gateway's probe fails", func(t *testing.T) {
		table, _ := newTestTable(t)
		_ = table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving())
		table.SetProbed("inv-1", true)
		table.SetProbed("inv-1", false)
		if table.Routable("inventory") {
			t.Fatal("an instance that failed the gateway's own probe was still routable")
		}
	})
}

// An instance that stops heartbeating drops out without anyone having to notice
// it died, which is what makes a crashed service stop receiving attempts.
func TestLeaseExpiryDropsAnInstance(t *testing.T) {
	table, moment := newTestTable(t)
	_ = table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving())
	table.SetProbed("inv-1", true)

	moment.advance(29 * time.Second)
	if !table.Routable("inventory") {
		t.Fatal("the lease expired early")
	}
	moment.advance(2 * time.Second)
	if table.Routable("inventory") {
		t.Fatal("an expired lease still routed")
	}
	if !table.Heartbeat("inv-1", serving(), 30*time.Second) {
		t.Fatal("heartbeat reported the instance unknown")
	}
	if !table.Routable("inventory") {
		t.Fatal("a heartbeat did not renew the lease")
	}
}

// An unknown instance is how a service learns the gateway restarted; without it
// a restarted gateway would be heartbeated at forever by services it forgot.
func TestHeartbeatReportsAnUnknownInstance(t *testing.T) {
	table, _ := newTestTable(t)
	if table.Heartbeat("inv-1", serving(), time.Second) {
		t.Fatal("an unknown instance was reported as known")
	}
}

func TestPickIsDeterministicRoundRobin(t *testing.T) {
	table, _ := newTestTable(t)
	for _, id := range []string{"inv-2", "inv-1", "inv-3"} {
		_ = table.Upsert(instanceInfo(id, "inventory", "127.0.0.1:9000"), serving())
		table.SetProbed(id, true)
	}
	seen := []string{}
	for range 6 {
		picked, err := table.Pick("inventory")
		if err != nil {
			t.Fatalf("pick: %v", err)
		}
		seen = append(seen, picked.InstanceID)
	}
	want := []string{"inv-1", "inv-2", "inv-3", "inv-1", "inv-2", "inv-3"}
	for index, expected := range want {
		if seen[index] != expected {
			t.Fatalf("pick order = %v, want %v", seen, want)
		}
	}
}

func TestPickFailsWhenNoInstanceIsHealthy(t *testing.T) {
	table, _ := newTestTable(t)
	_ = table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving())
	if _, err := table.Pick("inventory"); err == nil {
		t.Fatal("pick succeeded with no probed instance")
	}
}

// Deregistration removes a route, never a contract.
func TestRemoveDropsOnlyTheInstance(t *testing.T) {
	table, _ := newTestTable(t)
	_ = table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving())
	table.SetProbed("inv-1", true)
	table.Remove("inv-1")
	if table.Routable("inventory") {
		t.Fatal("a removed instance was still routable")
	}
	if len(table.Targets()) != 0 {
		t.Fatal("a removed instance is still probed")
	}
}

func TestProberRecordsOutcomesAndReportsChanges(t *testing.T) {
	table, _ := newTestTable(t)
	_ = table.Upsert(instanceInfo("inv-1", "inventory", "up:9000"), serving())
	_ = table.Upsert(instanceInfo("pay-1", "payment", "down:9000"), serving())

	changes := 0
	prober := NewProber(table, func(_ context.Context, target string) error {
		if target == "down:9000" {
			return errUnreachable
		}
		return nil
	}, time.Second, time.Second)
	prober.OnChange = func() { changes++ }

	prober.ProbeOnce(context.Background())
	if !table.Routable("inventory") {
		t.Fatal("a reachable instance was not marked healthy")
	}
	if table.Routable("payment") {
		t.Fatal("an unreachable instance was marked healthy")
	}
	if changes != 1 {
		t.Fatalf("OnChange fired %d times, want 1", changes)
	}
	// A steady state must not keep waking the registry.
	prober.ProbeOnce(context.Background())
	if changes != 1 {
		t.Fatalf("OnChange fired %d times after an unchanged probe, want 1", changes)
	}
}
