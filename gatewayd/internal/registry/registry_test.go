package registry

import (
	"context"
	"testing"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

func boolean(value bool) *bool { return &value }

// contract returns a minimal admissible read-only tool that each test bends
// into the shape of the rule it is about.
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

// compensator returns a delta-based, retry-safe undo tool.
func compensator(toolID string) *gatewayv1.ToolContract {
	built := contract(toolID)
	built.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_BUFFERABLE
	built.CompensationStyle = gatewayv1.CompensationStyle_COMPENSATION_STYLE_DELTA
	return built
}

// sagaContract returns a saga tool whose compensator lives elsewhere.
func sagaContract() *gatewayv1.ToolContract {
	built := contract("order.place")
	built.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_REVERSIBLE
	built.Txn.Mode = gatewayv1.ToolMode_TOOL_MODE_SAGA
	built.Txn.CompensateTool = "order.cancel"
	return built
}

// tccContract returns a try whose confirm and cancel live elsewhere.
func tccContract() *gatewayv1.ToolContract {
	built := contract("inventory.reserve")
	built.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_REVERSIBLE
	built.Txn.Mode = gatewayv1.ToolMode_TOOL_MODE_TCC
	built.Txn.ConfirmTool = "inventory.confirm"
	built.Txn.CancelTool = "inventory.release"
	built.Txn.TryTimeoutS = 900
	return built
}

func register(t *testing.T, registry *Registry, contracts ...*gatewayv1.ToolContract) []*gatewayv1.ToolStatus {
	t.Helper()
	statuses, err := registry.Register(context.Background(), contracts)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return statuses
}

func stateOf(t *testing.T, statuses []*gatewayv1.ToolStatus, toolID string) *gatewayv1.ToolStatus {
	t.Helper()
	for _, status := range statuses {
		if status.GetToolId() == toolID {
			return status
		}
	}
	t.Fatalf("no status reported for %s", toolID)
	return nil
}

func expectRejected(t *testing.T, contracts []*gatewayv1.ToolContract, toolID string, code gatewayv1.AdmissionCode) {
	t.Helper()
	registry := New(blob.NewMemory(), nil)
	statuses := register(t, registry, contracts...)
	status := stateOf(t, statuses, toolID)
	if status.GetState() != gatewayv1.ToolState_TOOL_STATE_REJECTED {
		t.Fatalf("%s is %s, want REJECTED", toolID, status.GetState())
	}
	if status.GetCode() != code {
		t.Fatalf("%s rejected with %s (%s), want %s", toolID, status.GetCode(), status.GetDetail(), code)
	}
}

func TestG1RejectsMalformedContracts(t *testing.T) {
	cases := map[string]func(*gatewayv1.ToolContract){
		"missing owner":           func(c *gatewayv1.ToolContract) { c.Owner = "" },
		"missing route":           func(c *gatewayv1.ToolContract) { c.RouteId = "" },
		"missing version":         func(c *gatewayv1.ToolContract) { c.ToolVersion = "" },
		"unsupported protocol":    func(c *gatewayv1.ToolContract) { c.Adapter.Protocol = "carrier-pigeon" },
		"no timeout":              func(c *gatewayv1.ToolContract) { c.TimeoutMs = 0 },
		"no attempts":             func(c *gatewayv1.ToolContract) { c.RetryConstraints.MaxAttempts = 0 },
		"shrinking backoff":       func(c *gatewayv1.ToolContract) { c.RetryConstraints.MultiplierMilli = 500 },
		"uncompilable schema":     func(c *gatewayv1.ToolContract) { c.InputSchema = `{"type":42}` },
		"schema is not an object": func(c *gatewayv1.ToolContract) { c.InputSchema = `[1,2,3]` },
	}
	for name, bend := range cases {
		t.Run(name, func(t *testing.T) {
			built := contract("inventory.check")
			bend(built)
			expectRejected(t, []*gatewayv1.ToolContract{built}, "inventory.check", gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT)
		})
	}
}

func TestG2RejectsIncompleteTCCTriples(t *testing.T) {
	t.Run("no cancel", func(t *testing.T) {
		built := tccContract()
		built.Txn.CancelTool = ""
		expectRejected(t, []*gatewayv1.ToolContract{built}, "inventory.reserve", gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_TCC_TRIPLE)
	})
	t.Run("no timeout", func(t *testing.T) {
		built := tccContract()
		built.Txn.TryTimeoutS = 0
		expectRejected(t, []*gatewayv1.ToolContract{built}, "inventory.reserve", gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_TCC_TRIPLE)
	})
	t.Run("confirm is not retry safe", func(t *testing.T) {
		confirm := compensator("inventory.confirm")
		confirm.Txn.IdempotentRetryable = boolean(false)
		registry := New(blob.NewMemory(), nil)
		statuses := register(t, registry, tccContract(), confirm, compensator("inventory.release"))
		status := stateOf(t, statuses, "inventory.reserve")
		if status.GetCode() != gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_TCC_TRIPLE {
			t.Fatalf("reserve reported %s (%s)", status.GetCode(), status.GetDetail())
		}
		if status.GetState() == gatewayv1.ToolState_TOOL_STATE_ADMITTED {
			t.Fatal("a try was published with a confirm that never claimed to be retry safe")
		}
	})
}

func TestG3RejectsIncompleteSagaCompensation(t *testing.T) {
	built := sagaContract()
	built.Txn.CompensateTool = ""
	expectRejected(t, []*gatewayv1.ToolContract{built}, "order.place", gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_SAGA_COMPENSATION)
}

func TestG4RejectsMislabelledEffectClasses(t *testing.T) {
	cases := map[string]func(*gatewayv1.ToolContract){
		"a read with a bracket": func(c *gatewayv1.ToolContract) {
			c.Txn.Mode = gatewayv1.ToolMode_TOOL_MODE_TCC
			c.Txn.ConfirmTool, c.Txn.CancelTool, c.Txn.TryTimeoutS = "a", "b", 10
		},
		"an irreversible try": func(c *gatewayv1.ToolContract) {
			c.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_IRREVERSIBLE
			c.Txn.Mode = gatewayv1.ToolMode_TOOL_MODE_TCC
			c.Txn.ConfirmTool, c.Txn.CancelTool, c.Txn.TryTimeoutS = "a", "b", 10
		},
		"an irreversible tool with an undo path": func(c *gatewayv1.ToolContract) {
			c.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_IRREVERSIBLE
			c.Txn.CompensateTool = "inventory.release"
		},
		"a reversible tool with no undo path": func(c *gatewayv1.ToolContract) {
			c.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_REVERSIBLE
		},
	}
	for name, bend := range cases {
		t.Run(name, func(t *testing.T) {
			built := contract("inventory.commit")
			bend(built)
			expectRejected(t, []*gatewayv1.ToolContract{built}, "inventory.commit", gatewayv1.AdmissionCode_ADMISSION_CODE_MISLABELLED_EFFECT_CLASS)
		})
	}
}

func TestG5RejectsSnapshotCompensation(t *testing.T) {
	t.Run("declared outright", func(t *testing.T) {
		built := contract("inventory.restore")
		built.CompensationStyle = gatewayv1.CompensationStyle_COMPENSATION_STYLE_SNAPSHOT
		expectRejected(t, []*gatewayv1.ToolContract{built}, "inventory.restore", gatewayv1.AdmissionCode_ADMISSION_CODE_NON_DELTA_COMPENSATION)
	})
	t.Run("referenced as a compensator", func(t *testing.T) {
		release := contract("order.cancel")
		release.CompensationStyle = gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING
		registry := New(blob.NewMemory(), nil)
		statuses := register(t, registry, sagaContract(), release)
		status := stateOf(t, statuses, "order.place")
		if status.GetCode() != gatewayv1.AdmissionCode_ADMISSION_CODE_NON_DELTA_COMPENSATION {
			t.Fatalf("order.place reported %s (%s)", status.GetCode(), status.GetDetail())
		}
	})
}

// Design document 09 section 3.1: services start asynchronously, so a saga tool
// may register before the service hosting its compensator exists.
func TestG6HoldsAToolPendingUntilItsCompanionRegisters(t *testing.T) {
	ctx := context.Background()
	store := blob.NewMemory()
	registry := New(store, nil)

	statuses := register(t, registry, sagaContract())
	status := stateOf(t, statuses, "order.place")
	if status.GetState() != gatewayv1.ToolState_TOOL_STATE_PENDING {
		t.Fatalf("order.place is %s, want PENDING", status.GetState())
	}
	if status.GetCode() != gatewayv1.AdmissionCode_ADMISSION_CODE_UNRESOLVED_COMPANION {
		t.Fatalf("order.place reported %s, want an unresolved companion", status.GetCode())
	}
	if view := registry.Current(); view != nil && len(view.Published.Document.Tools) != 0 {
		t.Fatalf("an incomplete compensation chain was published: %+v", view.Published.Document.Tools)
	}

	register(t, registry, compensator("order.cancel"))
	view := registry.Current()
	if view == nil || len(view.Published.Document.Tools) != 2 {
		t.Fatalf("the resolved cluster was not published: %+v", view)
	}
	// Both halves must appear in the same view: a reader may never observe the
	// try published without the compensator that makes it legal to plan.
	if _, found := view.Published.Document.Lookup("order.place", "1.0.0"); !found {
		t.Fatal("order.place is missing from the published view")
	}
	if _, found := view.Published.Document.Lookup("order.cancel", "1.0.0"); !found {
		t.Fatal("order.cancel is missing from the published view")
	}
	stored, err := store.Get(ctx, view.Published.Ref)
	if err != nil {
		t.Fatalf("the published digest has no blob behind it: %v", err)
	}
	if string(stored) != string(view.Published.Canonical) {
		t.Fatal("the stored blob differs from the published canonical document")
	}
}

func TestG7MakesAPublishedVersionImmutable(t *testing.T) {
	registry := New(blob.NewMemory(), nil)
	register(t, registry, contract("inventory.check"))
	first := registry.Current().Published.Digest

	// A restarted service re-registers exactly what it registered before.
	statuses := register(t, registry, contract("inventory.check"))
	if state := stateOf(t, statuses, "inventory.check").GetState(); state != gatewayv1.ToolState_TOOL_STATE_ADMITTED {
		t.Fatalf("an identical re-registration reported %s, want ADMITTED", state)
	}
	if registry.Current().Published.Digest != first {
		t.Fatal("an identical re-registration changed the tool-view digest")
	}

	changed := contract("inventory.check")
	changed.TimeoutMs = 9000
	statuses = register(t, registry, changed)
	status := stateOf(t, statuses, "inventory.check")
	if status.GetCode() != gatewayv1.AdmissionCode_ADMISSION_CODE_IMMUTABLE_VERSION_CONFLICT {
		t.Fatalf("a changed contract reported %s (%s)", status.GetCode(), status.GetDetail())
	}
	if registry.Current().Published.Digest != first {
		t.Fatal("a rejected re-registration republished the view")
	}
}

func TestG8RejectsSelfReferentialCompanions(t *testing.T) {
	built := sagaContract()
	built.Txn.CompensateTool = built.ToolId
	expectRejected(t, []*gatewayv1.ToolContract{built}, "order.place", gatewayv1.AdmissionCode_ADMISSION_CODE_INVALID_COMPANION_REFERENCE)
}

type routeHealth struct{ routable map[string]bool }

func (health *routeHealth) Routable(routeID string) bool { return health.routable[routeID] }

// Health gates the first admission and nothing after it. Withdrawing a published
// contract on a flap would let an already-frozen digest lose a tool.
func TestHealthGatesFirstAdmissionButNeverUnpublishes(t *testing.T) {
	ctx := context.Background()
	health := &routeHealth{routable: map[string]bool{}}
	registry := New(blob.NewMemory(), health)

	statuses := register(t, registry, contract("inventory.check"))
	if state := stateOf(t, statuses, "inventory.check").GetState(); state != gatewayv1.ToolState_TOOL_STATE_PENDING {
		t.Fatalf("a tool on an unroutable route is %s, want PENDING", state)
	}

	health.routable["inventory"] = true
	if err := registry.Resolve(ctx); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	admitted := registry.Current().Published.Digest
	if len(registry.Current().Published.Document.Tools) != 1 {
		t.Fatal("a healthy route did not admit its tool")
	}

	health.routable["inventory"] = false
	if err := registry.Resolve(ctx); err != nil {
		t.Fatalf("resolve after the route went unhealthy: %v", err)
	}
	if registry.Current().Published.Digest != admitted {
		t.Fatal("an unhealthy route withdrew a published contract; health is operational evidence, not a contract mutation")
	}
}

func TestPublishedViewCarriesCompiledSchemas(t *testing.T) {
	registry := New(blob.NewMemory(), nil)
	register(t, registry, contract("inventory.check"))
	view := registry.Current()
	if _, found := view.Schema(Key{ToolID: "inventory.check", ToolVersion: "1.0.0"}); !found {
		t.Fatal("the published view has no compiled schema for its own tool")
	}
	if _, found := view.Schema(Key{ToolID: "inventory.check", ToolVersion: "2.0.0"}); found {
		t.Fatal("an unpublished version resolved to a schema")
	}
}
