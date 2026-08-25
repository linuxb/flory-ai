// Package model defines the Coordinator's event-log and adapter boundary.
package model

import (
	"encoding/json"
	"time"

	"github.com/linuxb/flory-ai/coordinator/internal/eventlog/generated"
)

// EventDraft is an event before PostgreSQL allocates its stream sequence.
type EventDraft struct {
	EventType  string         `json:"event_type"`
	VertexID   *string        `json:"vertex_id,omitempty"`
	ParentRefs []string       `json:"parent_refs,omitempty"`
	ScopeID    *string        `json:"scope_id,omitempty"`
	Ignorable  bool           `json:"ignorable,omitempty"`
	Payload    map[string]any `json:"payload"`
}

// WorkItem is one recoverably leased executable vertex.
type WorkItem struct {
	VertexID   string
	RunID      string
	ScopeID    string
	ParentRefs []string
	Payload    generated.ToolVertexPayload
	Role       string
	Attempt    int
}

// ToolPin identifies the exact frozen contract an attempt is made against.
//
// A companion call -- confirm, cancel, compensate, or a pivot status query --
// carries the try's ViewDigest and no Version of its own: registration admission
// guarantees the companion lives in that same view, so it resolves by name there.
type ToolPin struct {
	Version    string
	ViewDigest string
}

// OperationRequest is the stable adapter request.
//
// The pin fields are omitempty, so the direct adapter's wire shape is exactly
// what it was before the gateway existed. That is what lets the dual-path
// fixture compare byte-identical upstream payloads across both routes.
type OperationRequest struct {
	RunID          string         `json:"run_id"`
	VertexID       string         `json:"vertex_id"`
	ScopeID        string         `json:"scope_id,omitempty"`
	AttemptNo      int            `json:"attempt_no"`
	Tool           string         `json:"tool"`
	ToolVersion    string         `json:"tool_version,omitempty"`
	ToolViewDigest string         `json:"tool_view_digest,omitempty"`
	IdempotencyKey string         `json:"idempotency_key,omitempty"`
	DeadlineMS     int64          `json:"deadline_ms,omitempty"`
	Input          map[string]any `json:"input"`
}

// OperationOutcome classifies an adapter result without transport-specific errors.
type OperationOutcome string

const (
	// OutcomeSucceeded means the operation completed.
	OutcomeSucceeded OperationOutcome = "succeeded"
	// OutcomeRetryableFailure means the same idempotent operation may be retried.
	OutcomeRetryableFailure OperationOutcome = "retryable-failure"
	// OutcomePermanentFailure means retry cannot resolve the failure.
	OutcomePermanentFailure OperationOutcome = "permanent-failure"
	// OutcomeUnknown means a pivot status query is required.
	OutcomeUnknown OperationOutcome = "unknown"
)

// OperationResponse is the stable HTTP adapter response.
type OperationResponse struct {
	Outcome OperationOutcome `json:"outcome"`
	Result  map[string]any   `json:"result,omitempty"`
	Error   string           `json:"error,omitempty"`
}

// DecodeWorkPayload validates the role discriminator and decodes a tool payload.
func DecodeWorkPayload(raw []byte) (generated.ToolVertexPayload, string, error) {
	var header struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return generated.ToolVertexPayload{}, "", err
	}
	if header.Role == "confirmation-barrier" {
		return generated.ToolVertexPayload{}, header.Role, nil
	}
	var payload generated.ToolVertexPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return generated.ToolVertexPayload{}, "", err
	}
	return payload, header.Role, nil
}

// Backoff returns the deterministic delay before the named one-based attempt.
func Backoff(policy generated.RetryPolicy, nextAttempt int) time.Duration {
	if nextAttempt <= 1 || policy.InitialBackoffMS <= 0 {
		return 0
	}
	delay := float64(policy.InitialBackoffMS)
	for attempt := 2; attempt < nextAttempt; attempt++ {
		delay *= policy.Multiplier
	}
	if maximum := float64(policy.MaxBackoffMS); maximum > 0 && delay > maximum {
		delay = maximum
	}
	return time.Duration(delay) * time.Millisecond
}
