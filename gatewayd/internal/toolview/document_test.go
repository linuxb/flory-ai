package toolview

import (
	"encoding/json"
	"strings"
	"testing"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

func reserveContract() *gatewayv1.ToolContract {
	return &gatewayv1.ToolContract{
		ToolId:       "inventory.reserve",
		ToolVersion:  "1.0.0",
		Description:  "Reserve inventory for an order",
		InputSchema:  `{"type":"object","properties":{"sku":{"type":"string"}},"required":["sku"]}`,
		OutputSchema: `{"type":"object"}`,
		RouteId:      "inventory",
		Adapter:      &gatewayv1.AdapterSpec{Protocol: "grpc", Operation: "flory.gateway.v1.ToolExecutionService/Execute"},
		Txn: &gatewayv1.TransactionSpec{
			EffectClass:         gatewayv1.EffectClass_EFFECT_CLASS_REVERSIBLE,
			Mode:                gatewayv1.ToolMode_TOOL_MODE_TCC,
			IdempotencyKeyPath:  "$.order_id",
			IdempotentRetryable: true,
			TryTimeoutS:         900,
			ConfirmTool:         "inventory.confirm",
			CancelTool:          "inventory.release",
		},
		CompensationStyle: gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING,
		Footprint:         []string{"inventory:{sku}"},
		Writes:            []string{"inventory:{sku}"},
		TimeoutMs:         15000,
		RetryConstraints:  &gatewayv1.RetryConstraints{MaxAttempts: 3, InitialBackoffMs: 100, MultiplierMilli: 2000, MaxBackoffMs: 5000},
		Owner:             "inventory-team",
	}
}

func checkContract() *gatewayv1.ToolContract {
	return &gatewayv1.ToolContract{
		ToolId:            "inventory.check",
		ToolVersion:       "1.0.0",
		InputSchema:       `{"type":"object"}`,
		OutputSchema:      `{"type":"object"}`,
		RouteId:           "inventory",
		Adapter:           &gatewayv1.AdapterSpec{Protocol: "grpc"},
		Txn:               &gatewayv1.TransactionSpec{EffectClass: gatewayv1.EffectClass_EFFECT_CLASS_NONE, Mode: gatewayv1.ToolMode_TOOL_MODE_PLAIN, IdempotentRetryable: true},
		CompensationStyle: gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING,
		TimeoutMs:         5000,
		RetryConstraints:  &gatewayv1.RetryConstraints{MaxAttempts: 3, InitialBackoffMs: 100, MultiplierMilli: 2000, MaxBackoffMs: 5000},
		Owner:             "inventory-team",
	}
}

func mustTool(t *testing.T, contract *gatewayv1.ToolContract) Tool {
	t.Helper()
	tool, err := FromProto(contract)
	if err != nil {
		t.Fatalf("from proto: %v", err)
	}
	return tool
}

// Services start in whatever order the operating system schedules them; a view
// whose identity depended on that order could not be pinned by a planner.
func TestBuildDigestIsIndependentOfRegistrationOrder(t *testing.T) {
	reserve := mustTool(t, reserveContract())
	check := mustTool(t, checkContract())
	forward, err := Build([]Tool{reserve, check})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	backward, err := Build([]Tool{check, reserve})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if forward.Digest != backward.Digest {
		t.Fatalf("registration order changed the digest: %s vs %s", forward.Digest, backward.Digest)
	}
	if forward.Document.Tools[0].ToolID != "inventory.check" {
		t.Fatalf("tools are not sorted: %s first", forward.Document.Tools[0].ToolID)
	}
}

// A schema is stored verbatim but hashed canonically, so two services that spell
// the same schema differently do not fork the view's identity.
func TestBuildDigestIgnoresSchemaKeyOrder(t *testing.T) {
	first := reserveContract()
	second := reserveContract()
	second.InputSchema = `{"required":["sku"],"properties":{"sku":{"type":"string"}},"type":"object"}`
	left, err := Build([]Tool{mustTool(t, first)})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	right, err := Build([]Tool{mustTool(t, second)})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if left.Digest != right.Digest {
		t.Fatalf("schema key order changed the digest: %s vs %s", left.Digest, right.Digest)
	}
}

func TestBuildDigestChangesWithSemanticContent(t *testing.T) {
	base, err := Build([]Tool{mustTool(t, reserveContract())})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	altered := reserveContract()
	altered.Txn.TryTimeoutS = 600
	changed, err := Build([]Tool{mustTool(t, altered)})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if base.Digest == changed.Digest {
		t.Fatal("a changed try timeout left the digest unchanged")
	}
}

func TestParseVerifiesTheDigestItWasFetchedBy(t *testing.T) {
	published, err := Build([]Tool{mustTool(t, checkContract())})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if _, err := Parse(published.Canonical, published.Digest); err != nil {
		t.Fatalf("parse of its own output failed: %v", err)
	}
	wrong := "sha256:" + strings.Repeat("f", 64)
	if _, err := Parse(published.Canonical, wrong); err == nil {
		t.Fatal("a mismatched digest was accepted; content addressing is only a guarantee if it is checked")
	}
}

// An unset enum is the mislabelled-effect-class defect that no downstream
// check-rule can infer, so it must not survive as a silent zero value.
func TestFromProtoRejectsUnsetEnums(t *testing.T) {
	missingEffect := reserveContract()
	missingEffect.Txn.EffectClass = gatewayv1.EffectClass_EFFECT_CLASS_UNSPECIFIED
	if _, err := FromProto(missingEffect); err == nil {
		t.Fatal("an unspecified effect_class was accepted")
	}
	missingMode := reserveContract()
	missingMode.Txn.Mode = gatewayv1.ToolMode_TOOL_MODE_UNSPECIFIED
	if _, err := FromProto(missingMode); err == nil {
		t.Fatal("an unspecified mode was accepted")
	}
	missingStyle := reserveContract()
	missingStyle.CompensationStyle = gatewayv1.CompensationStyle_COMPENSATION_STYLE_UNSPECIFIED
	if _, err := FromProto(missingStyle); err == nil {
		t.Fatal("an unspecified compensation_style was accepted")
	}
}

func TestFromProtoRejectsSchemasThatAreNotJSONObjects(t *testing.T) {
	for _, schema := range []string{"", "not json", `"a string"`, `[1,2]`} {
		contract := checkContract()
		contract.InputSchema = schema
		if _, err := FromProto(contract); err == nil {
			t.Fatalf("input_schema %q was accepted", schema)
		}
	}
}

func TestLookupNeverSubstitutesAnotherVersion(t *testing.T) {
	older := reserveContract()
	newer := reserveContract()
	newer.ToolVersion = "2.0.0"
	published, err := Build([]Tool{mustTool(t, older), mustTool(t, newer)})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	tool, found := published.Document.Lookup("inventory.reserve", "1.0.0")
	if !found || tool.ToolVersion != "1.0.0" {
		t.Fatalf("lookup returned %+v, found=%v", tool, found)
	}
	if _, found := published.Document.Lookup("inventory.reserve", "3.0.0"); found {
		t.Fatal("an absent version resolved to something")
	}
}

// design document 09 section 3.2: is_pivot is derived from effect_class and must
// never appear as a declared field a planner could read instead of deriving.
func TestMetadataOmitsDerivedAttributes(t *testing.T) {
	tool := mustTool(t, reserveContract())
	metadata := tool.Metadata()
	for _, derived := range []string{"is_pivot", "compensable", "undoable"} {
		if _, present := metadata[derived]; present {
			t.Fatalf("metadata declares the derived attribute %q", derived)
		}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	for _, want := range []string{`"effect_class":"reversible"`, `"mode":"tcc"`, `"idempotency_key_path":"$.order_id"`} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("metadata %s is missing %s", encoded, want)
		}
	}
}
