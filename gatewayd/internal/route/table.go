// Package route tracks tool-service instances and dispatches exactly one
// attempt to one of them.
//
// Instance membership and health live here rather than in the tool view on
// purpose: they may change so the gateway can route a pinned contract to a
// healthy instance, and that must not change the contract's identity.
package route

import (
	"fmt"
	"sort"
	"sync"
	"time"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

// DefaultLeaseTTL is used when a registration does not name one.
const DefaultLeaseTTL = 30 * time.Second

// Instance is one running tool-service process.
type Instance struct {
	InstanceID string
	RouteID    string
	Target     string
	// LeaseExpiry is refreshed by every heartbeat; an instance that stops
	// heartbeating drops out without anyone having to notice it died.
	LeaseExpiry time.Time
	// Probed is the result of the gateway's own health check.
	Probed bool
	// Reported is what the instance last said about itself on a heartbeat.
	Reported gatewayv1.ServingStatus
}

// Table holds the current instances of every route.
type Table struct {
	mutex     sync.RWMutex
	now       func() time.Time
	instances map[string]*Instance
	// cursor advances per route so successive calls spread over instances.
	cursor map[string]int
}

// NewTable creates an empty table. A nil clock uses the wall clock.
func NewTable(now func() time.Time) *Table {
	if now == nil {
		now = time.Now
	}
	return &Table{now: now, instances: map[string]*Instance{}, cursor: map[string]int{}}
}

// Upsert records or refreshes one instance and its self-reported health.
//
// A new instance starts unprobed, so it cannot be routed to before the gateway
// has confirmed for itself that it answers.
func (table *Table) Upsert(info *gatewayv1.InstanceInfo, report *gatewayv1.HealthReport) error {
	if info.GetInstanceId() == "" || info.GetRouteId() == "" || info.GetTarget() == "" {
		return fmt.Errorf("route: instance_id, route_id, and target are all required")
	}
	table.mutex.Lock()
	defer table.mutex.Unlock()
	ttl := time.Duration(info.GetLeaseTtlMs()) * time.Millisecond
	if ttl <= 0 {
		ttl = DefaultLeaseTTL
	}
	existing, known := table.instances[info.GetInstanceId()]
	if !known {
		existing = &Instance{InstanceID: info.GetInstanceId()}
		table.instances[info.GetInstanceId()] = existing
	}
	existing.RouteID = info.GetRouteId()
	existing.Target = info.GetTarget()
	existing.LeaseExpiry = table.now().Add(ttl)
	existing.Reported = reportedStatus(report)
	return nil
}

// Heartbeat refreshes a lease and reports whether the instance was known.
//
// An unknown instance is how a tool service learns the gateway restarted, which
// is its cue to register again rather than keep heartbeating into a void.
func (table *Table) Heartbeat(instanceID string, report *gatewayv1.HealthReport, ttl time.Duration) bool {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	existing, known := table.instances[instanceID]
	if !known {
		return false
	}
	if ttl <= 0 {
		ttl = DefaultLeaseTTL
	}
	existing.LeaseExpiry = table.now().Add(ttl)
	existing.Reported = reportedStatus(report)
	return true
}

// Remove drops an instance, which is what a graceful shutdown does.
//
// It removes a route, never a contract: the published view and its digest are
// unchanged, so calls for that tool fail as unroutable rather than as unknown.
func (table *Table) Remove(instanceID string) {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	delete(table.instances, instanceID)
}

// SetProbed records the outcome of the gateway's own health check.
func (table *Table) SetProbed(instanceID string, healthy bool) {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	if existing, known := table.instances[instanceID]; known {
		existing.Probed = healthy
	}
}

// Targets lists the instances a prober should check, live lease or not.
func (table *Table) Targets() []Instance {
	table.mutex.RLock()
	defer table.mutex.RUnlock()
	targets := make([]Instance, 0, len(table.instances))
	for _, instance := range table.instances {
		targets = append(targets, *instance)
	}
	sort.Slice(targets, func(first, second int) bool { return targets[first].InstanceID < targets[second].InstanceID })
	return targets
}

// Routable reports whether a route has at least one instance that can be used.
func (table *Table) Routable(routeID string) bool {
	table.mutex.RLock()
	defer table.mutex.RUnlock()
	return len(table.routableLocked(routeID)) > 0
}

// Pick selects one routable instance for a route.
//
// Selection is round-robin over instance ids in sorted order, so which instance
// serves an attempt depends only on the table's contents and how many attempts
// preceded it -- never on map iteration order.
func (table *Table) Pick(routeID string) (Instance, error) {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	candidates := table.routableLocked(routeID)
	if len(candidates) == 0 {
		return Instance{}, fmt.Errorf("route %s has no healthy instance", routeID)
	}
	index := table.cursor[routeID] % len(candidates)
	table.cursor[routeID] = (table.cursor[routeID] + 1) % len(candidates)
	return *candidates[index], nil
}

// routableLocked returns the usable instances of a route, in sorted order.
//
// All three conditions must hold: the lease is live, the gateway's own probe
// passed, and the instance says it is serving. The two health signals are
// independent evidence, and either one failing is enough to stop routing.
func (table *Table) routableLocked(routeID string) []*Instance {
	now := table.now()
	candidates := []*Instance{}
	for _, instance := range table.instances {
		if instance.RouteID != routeID {
			continue
		}
		if !instance.LeaseExpiry.After(now) || !instance.Probed || instance.Reported != gatewayv1.ServingStatus_SERVING_STATUS_SERVING {
			continue
		}
		candidates = append(candidates, instance)
	}
	sort.Slice(candidates, func(first, second int) bool { return candidates[first].InstanceID < candidates[second].InstanceID })
	return candidates
}

func reportedStatus(report *gatewayv1.HealthReport) gatewayv1.ServingStatus {
	if report == nil || report.GetStatus() == gatewayv1.ServingStatus_SERVING_STATUS_UNSPECIFIED {
		return gatewayv1.ServingStatus_SERVING_STATUS_NOT_SERVING
	}
	return report.GetStatus()
}
