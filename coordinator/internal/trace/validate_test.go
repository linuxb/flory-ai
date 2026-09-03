package trace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestValidateRejectsDuplicatePivotAndInheritedMutation(t *testing.T) {
	if err := Validate([]Event{{StreamSeq: 1, EventType: "txn/pivot-passed", ScopeID: "s", Payload: map[string]any{}},
		{StreamSeq: 2, EventType: "txn/pivot-passed", ScopeID: "s", Payload: map[string]any{}}}); err == nil {
		t.Fatal("expected duplicate pivot rejection")
	}
	if err := Validate([]Event{{StreamSeq: 1, EventType: "txn/try", ScopeID: "s", Inherited: true, Payload: map[string]any{}},
		{StreamSeq: 4, EventType: "run/end-seed", Payload: map[string]any{}},
		{StreamSeq: 5, EventType: "txn/cancel", ScopeID: "s", Payload: map[string]any{"phase": "requested"}}}); err == nil {
		t.Fatal("expected inherited mutation rejection")
	}
	if err := Validate([]Event{{StreamSeq: 1, EventType: "txn/try", ScopeID: "s", Inherited: true, Payload: map[string]any{}},
		{StreamSeq: 4, EventType: "run/end-seed", Payload: map[string]any{}},
		{StreamSeq: 2, EventType: "txn/cancel", ScopeID: "s", Inherited: true, Payload: map[string]any{"phase": "requested"}}}); err != nil {
		t.Fatalf("inherited copies of source history must stay valid: %v", err)
	}
}

func TestValidateFailsClosedAndAcceptsIgnorableUnknown(t *testing.T) {
	if err := Validate([]Event{{StreamSeq: 1, EventType: "future/event", Payload: map[string]any{}}}); err == nil {
		t.Fatal("expected fail-closed unknown event rejection")
	}
	if err := Validate([]Event{{StreamSeq: 1, EventType: "future/event", Ignorable: true, Payload: map[string]any{}}}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRequiresBudgetChargeVertex(t *testing.T) {
	if err := Validate([]Event{{StreamSeq: 1, EventType: "budget/charged", Payload: map[string]any{"category": "llm"}}}); err == nil {
		t.Fatal("expected budget charge without planner vertex to be rejected")
	}
	if err := Validate([]Event{{StreamSeq: 1, EventType: "budget/charged", VertexID: "planner-1", Payload: map[string]any{"category": "llm"}}}); err != nil {
		t.Fatal(err)
	}
}

func TestCrossLanguageConformanceFixture(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../../test/fixtures/event-log-conformance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name               string  `json:"name"`
			Valid              bool    `json:"valid"`
			ExpectedScopeState string  `json:"expected_scope_state"`
			Events             []Event `json:"events"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			err := Validate(testCase.Events)
			if testCase.Valid && err != nil {
				t.Fatal(err)
			}
			if !testCase.Valid && err == nil {
				t.Fatal("expected fixture rejection")
			}
			if state := fixtureScopeState(testCase.Events); state != testCase.ExpectedScopeState {
				t.Fatalf("scope state=%s, want %s", state, testCase.ExpectedScopeState)
			}
		})
	}
}

func fixtureScopeState(events []Event) string {
	state := "open"
	for _, event := range events {
		if event.EventType == "txn/scope" {
			if next, valid := event.Payload["state"].(string); valid {
				state = next
			}
		}
		if event.EventType == "txn/cancel" && event.Payload["phase"] == "completed" {
			state = "cancelled"
		}
	}
	return state
}
