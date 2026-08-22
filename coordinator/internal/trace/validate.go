// Package trace validates recorded event streams against implementation-level S2 invariants.
package trace

import (
	"fmt"
	"sort"
)

// Event is the trace subset required by transaction invariants.
type Event struct {
	StreamSeq int64          `json:"stream_seq"`
	EventType string         `json:"event_type"`
	ScopeID   string         `json:"scope_id,omitempty"`
	Ignorable bool           `json:"ignorable,omitempty"`
	Payload   map[string]any `json:"payload"`
}

var knownEvents = map[string]struct{}{
	"run/start": {}, "run/end": {}, "run/end-seed": {}, "subgraph/proposed": {}, "subgraph/frozen": {}, "subgraph/rejected": {}, "subgraph/shadowed": {},
	"replan/boundary": {}, "fork/created": {}, "vertex/created": {}, "vertex/started": {}, "vertex/succeeded": {}, "vertex/failed": {}, "vertex/retried": {},
	"txn/scope": {}, "txn/try": {}, "txn/confirm": {}, "txn/cancel": {}, "txn/pivot-passed": {}, "budget/charged": {},
}

// Validate checks event ownership-independent S2 trace properties I4-I7 and fail-closed reads.
func Validate(events []Event) error {
	ordered := append([]Event(nil), events...)
	sort.Slice(ordered, func(first, second int) bool { return ordered[first].StreamSeq < ordered[second].StreamSeq })
	pivoted := map[string]bool{}
	inheritedTryScopes := map[string]bool{}
	seedSeen := false
	bracketTerminal := map[string]string{}
	for _, event := range ordered {
		if _, known := knownEvents[event.EventType]; !known {
			if event.Ignorable {
				continue
			}
			return fmt.Errorf("unknown non-ignorable event type %q at stream_seq %d", event.EventType, event.StreamSeq)
		}
		if event.EventType == "run/end-seed" {
			seedSeen = true
			continue
		}
		if event.EventType == "txn/try" && !seedSeen {
			inheritedTryScopes[event.ScopeID] = true
		}
		if seedSeen && inheritedTryScopes[event.ScopeID] && (event.EventType == "txn/confirm" || event.EventType == "txn/cancel") {
			return fmt.Errorf("I7: inherited scope %s mutated after run/end-seed", event.ScopeID)
		}
		switch event.EventType {
		case "txn/pivot-passed":
			if pivoted[event.ScopeID] {
				return fmt.Errorf("I4/I5: scope %s passed more than one pivot", event.ScopeID)
			}
			pivoted[event.ScopeID] = true
		case "txn/cancel":
			if pivoted[event.ScopeID] {
				return fmt.Errorf("I3: scope %s cancelled after pivot", event.ScopeID)
			}
			if event.Payload["phase"] == "completed" {
				bracketTerminal[event.ScopeID] = "cancelled"
			}
		case "txn/confirm":
			if terminal := bracketTerminal[event.ScopeID]; terminal == "cancelled" {
				return fmt.Errorf("I6: scope %s confirmed after completed cancellation", event.ScopeID)
			}
		}
	}
	return nil
}
