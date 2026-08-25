// Package coordinator implements the Distributed Transaction Coordinator runtime.
package coordinator

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/linuxb/flory-ai/coordinator/internal/adapter"
	"github.com/linuxb/flory-ai/coordinator/internal/eventlog/generated"
	"github.com/linuxb/flory-ai/coordinator/internal/model"
	"github.com/linuxb/flory-ai/coordinator/internal/store"
)

// Service claims work and enforces scope-level transaction lifecycle rules.
type Service struct {
	store   *store.PostgresStore
	adapter adapter.Client
	worker  string
	lease   time.Duration
	poll    time.Duration
	sweep   time.Duration
	logger  *slog.Logger
}

// Config contains runtime intervals and identity.
type Config struct {
	WorkerID      string
	LeaseDuration time.Duration
	PollInterval  time.Duration
	SweepInterval time.Duration
}

// New creates a Coordinator service.
func New(database *store.PostgresStore, adapterClient adapter.Client, config Config, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{store: database, adapter: adapterClient, worker: config.WorkerID, lease: config.LeaseDuration, poll: config.PollInterval, sweep: config.SweepInterval, logger: logger}
}

// Run processes work and orphan sweeps until the context is cancelled.
func (service *Service) Run(ctx context.Context) error {
	pollTimer := time.NewTicker(service.poll)
	defer pollTimer.Stop()
	sweepTimer := time.NewTicker(service.sweep)
	defer sweepTimer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-pollTimer.C:
			if err := service.ProcessOne(ctx); err != nil {
				service.logger.Error("work processing failed", "error", err)
			}
		case <-sweepTimer.C:
			if err := service.Sweep(ctx); err != nil {
				service.logger.Error("orphan sweep failed", "error", err)
			}
		}
	}
}

// ProcessOne claims and processes at most one ready vertex.
func (service *Service) ProcessOne(ctx context.Context) error {
	item, err := service.store.ClaimWork(ctx, service.worker, service.lease)
	if err != nil || item == nil {
		return err
	}
	if item.Role == "confirmation-barrier" {
		events := []model.EventDraft{
			vertexEvent("vertex/started", item, map[string]any{"phase": "barrier"}),
			vertexEvent("vertex/succeeded", item, map[string]any{"result": map[string]any{"barrier": "sealed"}}),
		}
		if err := service.store.Append(ctx, item.RunID, events...); err != nil {
			return err
		}
		return service.store.CompleteWork(ctx, service.worker, item.VertexID)
	}
	if err := service.store.EnsureScope(ctx, item.RunID, item.ScopeID); err != nil {
		return err
	}
	if item.Payload.Txn.EffectClass == generated.EffectIrreversible {
		return service.processPivot(ctx, item)
	}
	return service.processRegular(ctx, item)
}

func (service *Service) processRegular(ctx context.Context, item *model.WorkItem) error {
	if err := service.store.Append(ctx, item.RunID, vertexEvent("vertex/started", item, map[string]any{"attempt": 1})); err != nil {
		return err
	}
	response, attempts, err := service.executeWithRetry(ctx, item.RunID, item.VertexID, item.Payload.Tool, item.Payload.Txn.IdempotencyKey, item.Payload.Input, item.Payload.RetryPolicy, pinOf(item))
	if err != nil {
		return err
	}
	if response.Outcome != model.OutcomeSucceeded {
		failure := vertexEvent("vertex/failed", item, map[string]any{"attempts": attempts, "error": response.Error, "outcome": response.Outcome})
		if err := service.store.Append(ctx, item.RunID, failure); err != nil {
			return err
		}
		if item.ScopeID != "" {
			key := "scope:" + item.ScopeID + ":cancel"
			if err := service.store.RequestScopeCancel(ctx, item.RunID, item.ScopeID, key, "pre-pivot vertex failure"); err != nil {
				return err
			}
			if err := service.cancelScope(ctx, item.RunID, item.ScopeID, key); err != nil {
				return err
			}
		}
		return service.store.CompleteWork(ctx, service.worker, item.VertexID)
	}
	events := []model.EventDraft{}
	if item.ScopeID != "" && (item.Payload.Txn.Mode == generated.ModeTCC || item.Payload.Txn.Mode == generated.ModeSaga) {
		deadline := time.Now().UTC().Add(time.Duration(item.Payload.Txn.TryTimeoutS) * time.Second)
		tryPayload := map[string]any{
			"idempotency_key": item.Payload.Txn.IdempotencyKey,
			"deadline_at":     deadline.Format(time.RFC3339Nano),
			"input":           item.Payload.Input,
			"retry_policy":    toMap(item.Payload.RetryPolicy),
		}
		optionalString(tryPayload, "tool_view_digest", item.Payload.ToolViewDigest)
		optionalString(tryPayload, "confirm_tool", item.Payload.Txn.ConfirmTool)
		optionalString(tryPayload, "cancel_tool", item.Payload.Txn.CancelTool)
		optionalString(tryPayload, "compensate_tool", item.Payload.Txn.CompensateTool)
		events = append(events, model.EventDraft{EventType: "txn/try", VertexID: &item.VertexID, ScopeID: &item.ScopeID, Payload: tryPayload})
	}
	events = append(events, vertexEvent("vertex/succeeded", item, map[string]any{"attempts": attempts, "result": response.Result}))
	if err := service.store.Append(ctx, item.RunID, events...); err != nil {
		return err
	}
	return service.store.CompleteWork(ctx, service.worker, item.VertexID)
}

func (service *Service) processPivot(ctx context.Context, item *model.WorkItem) error {
	admitted, err := service.store.AdmitPivot(ctx, item.RunID, item.ScopeID, item.VertexID)
	if err != nil {
		return err
	}
	if !admitted {
		return service.store.ReleaseWork(ctx, service.worker, item.VertexID, service.poll)
	}
	response, attempts, err := service.executeWithRetry(ctx, item.RunID, item.VertexID, item.Payload.Tool, item.Payload.Txn.IdempotencyKey, item.Payload.Input, item.Payload.RetryPolicy, pinOf(item))
	if err != nil {
		return err
	}
	if response.Outcome == model.OutcomeUnknown && item.Payload.Txn.StatusTool != "" {
		statusResponse, _, statusErr := service.executeWithRetry(ctx, item.RunID, item.VertexID, item.Payload.Txn.StatusTool, item.Payload.Txn.IdempotencyKey,
			item.Payload.Input, item.Payload.RetryPolicy, companionPin(item.Payload.ToolViewDigest))
		err = statusErr
		if err != nil {
			return err
		}
		if statusResponse.Outcome == model.OutcomeSucceeded {
			occurred, valid := statusResponse.Result["occurred"].(bool)
			if !valid {
				response = model.OperationResponse{Outcome: model.OutcomeUnknown, Error: "pivot status response omitted boolean occurred"}
			} else if !occurred {
				return service.failAbsentPivot(ctx, item, attempts, "pivot status confirmed absence")
			} else {
				response = model.OperationResponse{Outcome: model.OutcomeSucceeded, Result: map[string]any{"status_confirmed": true}}
			}
		} else {
			response = model.OperationResponse{Outcome: model.OutcomeUnknown, Error: "pivot status query did not establish an outcome: " + statusResponse.Error}
		}
	}
	if response.Outcome != model.OutcomeSucceeded {
		if response.Outcome != model.OutcomeUnknown {
			return service.failAbsentPivot(ctx, item, attempts, response.Error)
		}
		events := []model.EventDraft{
			vertexEvent("vertex/failed", item, map[string]any{"attempts": attempts, "error": response.Error, "outcome": response.Outcome}),
			{EventType: "txn/scope", ScopeID: &item.ScopeID, Payload: map[string]any{"state": "suspended"}},
		}
		if err := service.store.Append(ctx, item.RunID, events...); err != nil {
			return err
		}
		return service.store.CompleteWork(ctx, service.worker, item.VertexID)
	}
	events := []model.EventDraft{
		{EventType: "txn/pivot-passed", VertexID: &item.VertexID, ScopeID: &item.ScopeID, Payload: map[string]any{}},
		vertexEvent("vertex/succeeded", item, map[string]any{"attempts": attempts, "result": response.Result}),
	}
	if err := service.store.Append(ctx, item.RunID, events...); err != nil {
		return err
	}
	confirmed, err := service.confirmScope(ctx, item)
	if err != nil {
		return err
	}
	if !confirmed {
		return service.store.CompleteWork(ctx, service.worker, item.VertexID)
	}
	if err := service.store.Append(ctx, item.RunID, model.EventDraft{EventType: "txn/scope", ScopeID: &item.ScopeID, Payload: map[string]any{"state": "committed"}}); err != nil {
		return err
	}
	return service.store.CompleteWork(ctx, service.worker, item.VertexID)
}

func (service *Service) failAbsentPivot(ctx context.Context, item *model.WorkItem, attempts int, detail string) error {
	if err := service.store.ResolvePivotAbsent(ctx, item.RunID, item.ScopeID, item.VertexID); err != nil {
		return err
	}
	if err := service.store.Append(ctx, item.RunID, vertexEvent("vertex/failed", item, map[string]any{"attempts": attempts, "error": detail, "outcome": "confirmed-absent"})); err != nil {
		return err
	}
	key := "scope:" + item.ScopeID + ":cancel"
	if err := service.store.RequestScopeCancel(ctx, item.RunID, item.ScopeID, key, "pivot confirmed absent"); err != nil {
		return err
	}
	if err := service.cancelScope(ctx, item.RunID, item.ScopeID, key); err != nil {
		return err
	}
	return service.store.CompleteWork(ctx, service.worker, item.VertexID)
}

func (service *Service) confirmScope(ctx context.Context, item *model.WorkItem) (bool, error) {
	brackets, err := service.store.SealedBrackets(ctx, item.RunID, item.ScopeID)
	if err != nil {
		return false, err
	}
	for _, bracket := range brackets {
		response, _, err := service.executeWithRetry(ctx, item.RunID, bracket.VertexID, bracket.ConfirmTool, bracket.IdempotencyKey, bracket.Input, bracket.RetryPolicy,
			companionPin(bracket.ToolViewDigest))
		if err != nil {
			return false, err
		}
		if response.Outcome != model.OutcomeSucceeded {
			return false, service.store.Append(ctx, item.RunID, model.EventDraft{EventType: "txn/scope", ScopeID: &item.ScopeID, Payload: map[string]any{"state": "suspended"}})
		}
		if err := service.store.Append(ctx, item.RunID, model.EventDraft{EventType: "txn/confirm", VertexID: &bracket.VertexID, ScopeID: &item.ScopeID,
			Payload: map[string]any{"idempotency_key": bracket.IdempotencyKey}}); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (service *Service) cancelScope(ctx context.Context, runID, scopeID, key string) error {
	for {
		member, err := service.store.ClaimCancelMember(ctx, service.worker, runID, scopeID, service.lease)
		if err != nil {
			return err
		}
		if member == nil {
			return service.store.CompleteScopeCancel(ctx, runID, scopeID, key)
		}
		response, _, err := service.executeWithRetry(ctx, runID, member.VertexID, member.InverseTool, member.IdempotencyKey, member.Input, member.RetryPolicy,
			companionPin(member.ToolViewDigest))
		if err != nil {
			return err
		}
		if response.Outcome != model.OutcomeSucceeded {
			return service.store.Append(ctx, runID, model.EventDraft{EventType: "txn/scope", ScopeID: &scopeID, Payload: map[string]any{"state": "suspended"}})
		}
		if err := service.store.CompleteCancelMember(ctx, service.worker, runID, scopeID, member.VertexID); err != nil {
			return err
		}
	}
}

func (service *Service) executeWithRetry(ctx context.Context, runID, vertexID, tool, key string, input map[string]any, policy generated.RetryPolicy, pin model.ToolPin) (model.OperationResponse, int, error) {
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		if delay := model.Backoff(policy, attempt); delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return model.OperationResponse{}, attempt - 1, ctx.Err()
			case <-timer.C:
			}
		}
		response, err := service.adapter.Execute(ctx, model.OperationRequest{
			RunID: runID, VertexID: vertexID, AttemptNo: attempt, Tool: tool, ToolVersion: pin.Version, ToolViewDigest: pin.ViewDigest, IdempotencyKey: key, Input: input,
		})
		if err != nil {
			return model.OperationResponse{}, attempt, err
		}
		if response.Outcome != model.OutcomeRetryableFailure || attempt == policy.MaxAttempts {
			return response, attempt, nil
		}
		vertex := vertexID
		if err := service.store.Append(ctx, runID, model.EventDraft{EventType: "vertex/retried", VertexID: &vertex, Payload: map[string]any{"attempt": attempt + 1, "error": response.Error}}); err != nil {
			return model.OperationResponse{}, attempt, err
		}
	}
	return model.OperationResponse{Outcome: model.OutcomePermanentFailure, Error: "retry policy exhausted"}, policy.MaxAttempts, nil
}

// Sweep starts scope-level cancellation for expired sealed brackets.
func (service *Service) Sweep(ctx context.Context) error {
	expired, err := service.store.ExpiredScopes(ctx)
	if err != nil {
		return err
	}
	for runID, scopes := range expired {
		for _, scopeID := range scopes {
			key := "scope:" + scopeID + ":cancel"
			if err := service.store.RequestScopeCancel(ctx, runID, scopeID, key, "sealed try timeout"); err != nil {
				return err
			}
			if err := service.cancelScope(ctx, runID, scopeID, key); err != nil {
				return err
			}
		}
	}
	return nil
}

// pinOf is the exact contract a vertex was frozen against.
func pinOf(item *model.WorkItem) model.ToolPin {
	return model.ToolPin{Version: item.Payload.ToolVersion, ViewDigest: item.Payload.ToolViewDigest}
}

// companionPin resolves a confirm, cancel, compensate, or status tool inside the
// view its try was admitted against.
//
// It carries no version on purpose: registration admission guarantees a companion
// exists in the same published view as the tool that named it, so the gateway
// resolves it there by name. Threading a separate version for every companion
// would mean recording one in the bracket projection for no added safety.
func companionPin(viewDigest string) model.ToolPin {
	return model.ToolPin{ViewDigest: viewDigest}
}

func vertexEvent(eventType string, item *model.WorkItem, payload map[string]any) model.EventDraft {
	return model.EventDraft{EventType: eventType, VertexID: &item.VertexID, ScopeID: optionalPointer(item.ScopeID), Payload: payload}
}

func optionalPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func optionalString(values map[string]any, key, value string) {
	if value != "" {
		values[key] = value
	}
}

func toMap(value any) map[string]any {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("marshal generated contract: %v", err))
	}
	result := map[string]any{}
	if err := json.Unmarshal(encoded, &result); err != nil {
		panic(fmt.Sprintf("decode generated contract: %v", err))
	}
	return result
}
