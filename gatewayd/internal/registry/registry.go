package registry

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/toolview"
)

// Key identifies one immutable published contract.
type Key struct {
	ToolID      string
	ToolVersion string
}

func (key Key) String() string {
	return key.ToolID + "@" + key.ToolVersion
}

// View is a published tool view together with the compiled schemas the gateway
// validates call arguments against.
//
// The schemas are compiled once, at publication, so a call resolves them by
// pointer rather than paying for compilation on the dispatch path.
type View struct {
	Published toolview.Published
	schemas   map[Key]*jsonschema.Schema
}

// Schema returns the frozen input schema for one exact pinned contract.
func (view *View) Schema(key Key) (*jsonschema.Schema, bool) {
	schema, found := view.schemas[key]
	return schema, found
}

// RouteHealth reports whether a route currently has a routable instance.
//
// It gates a tool's first admission only. After a contract is published, a
// health flap must not withdraw it: health is operational evidence, not a
// contract mutation (design document 09 section 5), and unpublishing on a flap
// would let an already-frozen digest lose a tool it was admitted against.
type RouteHealth interface {
	Routable(routeID string) bool
}

type alwaysRoutable struct{}

func (alwaysRoutable) Routable(string) bool { return true }

type record struct {
	tool      toolview.Tool
	canonical []byte
	state     gatewayv1.ToolState
	code      gatewayv1.AdmissionCode
	detail    string
	// admitted records that this contract has been published at least once, after
	// which health can stop routing it but can no longer withdraw it.
	admitted bool
}

// Registry holds the current registrations and owns tool-view publication.
//
// Registrations are in-process and deliberately not durable: gatewayd is the
// stateless gateway, and services re-register through the SDK after a restart.
// What is durable is every published view, in content-addressed blob storage.
type Registry struct {
	mutex   sync.Mutex
	store   blob.Store
	health  RouteHealth
	records map[Key]*record
	current atomic.Pointer[View]
}

// New creates an empty registry that publishes into store.
//
// A nil health treats every route as routable, which is what unit tests of pure
// admission want; the running gateway passes its instance table.
func New(store blob.Store, health RouteHealth) *Registry {
	if health == nil {
		health = alwaysRoutable{}
	}
	return &Registry{store: store, health: health, records: map[Key]*record{}}
}

// Current returns the published view, or nil before anything is admitted.
func (registry *Registry) Current() *View {
	return registry.current.Load()
}

// Register admits a batch of contracts and republishes if the admitted set changed.
//
// The whole batch is evaluated against every known registration, not just its own
// contents, because a contract's admissibility can be completed by a service that
// registers later (design document 09 section 3.1).
func (registry *Registry) Register(ctx context.Context, contracts []*gatewayv1.ToolContract) ([]*gatewayv1.ToolStatus, error) {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()

	for _, contract := range contracts {
		tool, err := toolview.FromProto(contract)
		if err != nil {
			registry.records[Key{ToolID: contract.GetToolId(), ToolVersion: contract.GetToolVersion()}] = &record{
				tool:   tool,
				state:  gatewayv1.ToolState_TOOL_STATE_REJECTED,
				code:   gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT,
				detail: err.Error(),
			}
			continue
		}
		key := Key{ToolID: tool.ToolID, ToolVersion: tool.ToolVersion}
		canonical, err := toolview.Canonical(tool)
		if err != nil {
			registry.records[key] = &record{tool: tool, state: gatewayv1.ToolState_TOOL_STATE_REJECTED,
				code: gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, detail: err.Error()}
			continue
		}
		// G7. Re-registering an identical contract is how a restarted service
		// rejoins, so it must be idempotent; re-registering a different body
		// under a published version is a contract mutation and is refused.
		if existing, known := registry.records[key]; known && existing.state != gatewayv1.ToolState_TOOL_STATE_REJECTED {
			if !bytes.Equal(existing.canonical, canonical) {
				registry.records[key] = &record{
					tool: existing.tool, canonical: existing.canonical, state: existing.state, admitted: existing.admitted,
					code:   gatewayv1.AdmissionCode_ADMISSION_CODE_IMMUTABLE_VERSION_CONFLICT,
					detail: fmt.Sprintf("%s is already published with a different contract; publish a new tool_version instead", key),
				}
				continue
			}
			continue
		}
		if violation := ValidateStructure(tool); violation != nil {
			registry.records[key] = &record{tool: tool, canonical: canonical, state: gatewayv1.ToolState_TOOL_STATE_REJECTED, code: violation.Code, detail: violation.Detail}
			continue
		}
		registry.records[key] = &record{tool: tool, canonical: canonical, state: gatewayv1.ToolState_TOOL_STATE_PENDING}
	}

	if err := registry.resolveAndPublish(ctx); err != nil {
		return nil, err
	}
	return registry.statusesFor(contracts), nil
}

// Resolve re-evaluates pending registrations and republishes if anything changed.
//
// The gateway calls it when route health changes, so a cluster that was complete
// but unhealthy at registration time is admitted once its instances come up.
func (registry *Registry) Resolve(ctx context.Context) error {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	return registry.resolveAndPublish(ctx)
}

// Statuses reports every known registration, for diagnostics.
func (registry *Registry) Statuses() []*gatewayv1.ToolStatus {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	keys := make([]Key, 0, len(registry.records))
	for key := range registry.records {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(first, second int) bool { return keys[first].String() < keys[second].String() })
	statuses := make([]*gatewayv1.ToolStatus, 0, len(keys))
	for _, key := range keys {
		statuses = append(statuses, registry.records[key].status(key))
	}
	return statuses
}

func (registry *Registry) statusesFor(contracts []*gatewayv1.ToolContract) []*gatewayv1.ToolStatus {
	statuses := make([]*gatewayv1.ToolStatus, 0, len(contracts))
	for _, contract := range contracts {
		key := Key{ToolID: contract.GetToolId(), ToolVersion: contract.GetToolVersion()}
		if stored, known := registry.records[key]; known {
			statuses = append(statuses, stored.status(key))
		}
	}
	return statuses
}

func (stored *record) status(key Key) *gatewayv1.ToolStatus {
	return &gatewayv1.ToolStatus{ToolId: key.ToolID, ToolVersion: key.ToolVersion, State: stored.state, Code: stored.code, Detail: stored.detail}
}

// resolveAndPublish computes the admitted set and publishes it if it changed.
func (registry *Registry) resolveAndPublish(ctx context.Context) error {
	registry.resolvePending()
	admitted := make([]toolview.Tool, 0, len(registry.records))
	for _, stored := range registry.records {
		if stored.state == gatewayv1.ToolState_TOOL_STATE_ADMITTED {
			admitted = append(admitted, stored.tool)
		}
	}
	published, err := toolview.Build(admitted)
	if err != nil {
		return err
	}
	if current := registry.current.Load(); current != nil && current.Published.Digest == published.Digest {
		return nil
	}
	schemas := map[Key]*jsonschema.Schema{}
	for _, tool := range published.Document.Tools {
		schema, err := CompileSchema(tool.ToolID+"@"+tool.ToolVersion, string(tool.InputSchema))
		if err != nil {
			return fmt.Errorf("registry: %w", err)
		}
		schemas[Key{ToolID: tool.ToolID, ToolVersion: tool.ToolVersion}] = schema
	}
	// Write the blob before swapping the pointer. A reader that resolves the new
	// digest must always find the document behind it, so the only two states an
	// observer can see are the previous complete view and the next complete one.
	if err := registry.store.Put(ctx, published.Ref, published.Canonical); err != nil {
		return err
	}
	registry.current.Store(&View{Published: published, schemas: schemas})
	return nil
}

// resolvePending runs G6 to a fixed point.
//
// Admission is monotone -- admitting one tool can only enable others, never
// disable one -- so iterating until nothing changes terminates, and it lets a
// chain of dependencies resolve in whatever order the services happened to start.
func (registry *Registry) resolvePending() {
	for {
		changed := false
		for key, stored := range registry.records {
			if stored.state != gatewayv1.ToolState_TOOL_STATE_PENDING {
				continue
			}
			if violation := registry.resolveCompanions(stored.tool); violation != nil {
				stored.code, stored.detail = violation.Code, violation.Detail
				continue
			}
			if !stored.admitted && !registry.health.Routable(stored.tool.RouteID) {
				stored.code = gatewayv1.AdmissionCode_ADMISSION_CODE_UNRESOLVED_COMPANION
				stored.detail = fmt.Sprintf("route %s has no routable instance yet", stored.tool.RouteID)
				continue
			}
			stored.state = gatewayv1.ToolState_TOOL_STATE_ADMITTED
			stored.admitted = true
			stored.code, stored.detail = gatewayv1.AdmissionCode_ADMISSION_CODE_UNSPECIFIED, ""
			registry.records[key] = stored
			changed = true
		}
		if !changed {
			return
		}
	}
}

// resolveCompanions completes G2, G3, and G5 against the rest of the registry,
// and reports G6 while a companion is still missing.
func (registry *Registry) resolveCompanions(tool toolview.Tool) *Violation {
	for _, companion := range companions(tool) {
		resolved := registry.companionVersions(companion)
		if len(resolved) == 0 {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_UNRESOLVED_COMPANION,
				"companion %s is not registered yet", companion)
		}
		// A companion reference names a tool but not a version, so the obligation
		// is checked against every registered version rather than against one
		// picked by an ordering rule. Choosing a "latest" would mean guessing at
		// version ordering, and guessing wrong would publish a recovery path that
		// was never validated.
		for _, candidate := range resolved {
			// "Proven idempotent" in design document 09 section 3.1 means declared:
			// the gateway cannot prove idempotency, it can only refuse to publish a
			// recovery path that never claimed to be safe to retry.
			if mustBeRetrySafe(tool, companion) && !candidate.Txn.IdempotentRetryable {
				code := gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_SAGA_COMPENSATION
				if tool.Txn.Mode == "tcc" {
					code = gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_TCC_TRIPLE
				}
				return reject(code, "companion %s@%s is not declared idempotent_retryable", companion, candidate.ToolVersion)
			}
			if isCompensating(tool, companion) && candidate.CompensationStyle != "delta" {
				return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_NON_DELTA_COMPENSATION,
					"companion %s@%s must declare delta compensation, not %s", companion, candidate.ToolVersion, candidate.CompensationStyle)
			}
		}
	}
	return nil
}

// companionVersions returns every registered version of a companion tool that
// has not already been rejected.
func (registry *Registry) companionVersions(toolID string) []toolview.Tool {
	candidates := []toolview.Tool{}
	for key, stored := range registry.records {
		if key.ToolID == toolID && stored.state != gatewayv1.ToolState_TOOL_STATE_REJECTED {
			candidates = append(candidates, stored.tool)
		}
	}
	sort.Slice(candidates, func(first, second int) bool { return candidates[first].ToolVersion < candidates[second].ToolVersion })
	return candidates
}
