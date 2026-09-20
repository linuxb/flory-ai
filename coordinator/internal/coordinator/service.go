// Package coordinator implements the Distributed Transaction Coordinator runtime.
package coordinator

import (
	"context"
	"encoding/json"
	"errors"
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
	result, err := service.executeWithRetry(ctx, call{
		runID: item.RunID, scopeID: item.ScopeID, vertexID: item.VertexID, operation: "call",
		leaseVertexID: item.VertexID, leaseSource: "work_queue",
		tool: item.Payload.Tool, idempotencyKey: item.Payload.Txn.IdempotencyKey,
		input: item.Payload.Input, policy: item.Payload.RetryPolicy, pin: pinOf(item),
	})
	if err != nil {
		return err
	}
	response, attempts := result.response, result.attempts
	if response.Outcome != model.OutcomeSucceeded {
		failure := vertexEvent("vertex/failed", item, map[string]any{"attempts": attempts, "error": response.Error, "outcome": response.Outcome})
		if err := service.store.Append(ctx, item.RunID, failure); err != nil {
			return err
		}
		if item.ScopeID != "" {
			// An unknown outcome leaves the attempt unresolved, so this is also the path on which
			// the scope suspends instead of cancelling. The decision is the database's.
			if err := service.fenceScope(ctx, item.RunID, item.ScopeID, "pre-pivot vertex failure"); err != nil {
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
		// Carried through untouched. This process never builds a companion's arguments: the tool
		// that owns the bracket declared the mapping and the engine resolved it at freeze, so what
		// is recorded here is what will be sent, and a replay sends the same thing.
		optionalObject(tryPayload, "confirm_input", item.Payload.Txn.ConfirmInput)
		optionalObject(tryPayload, "cancel_input", item.Payload.Txn.CancelInput)
		optionalObject(tryPayload, "compensate_input", item.Payload.Txn.CompensateInput)
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
	result, err := service.executeWithRetry(ctx, call{
		runID: item.RunID, scopeID: item.ScopeID, vertexID: item.VertexID, operation: "pivot",
		leaseVertexID: item.VertexID, leaseSource: "work_queue",
		tool: item.Payload.Tool, idempotencyKey: item.Payload.Txn.IdempotencyKey,
		input: item.Payload.Input, policy: item.Payload.RetryPolicy, pin: pinOf(item),
	})
	if err != nil {
		return err
	}
	if result.response.Outcome == model.OutcomeUnknown && item.Payload.Txn.StatusTool != "" {
		status, statusErr := service.executeWithRetry(ctx, call{
			runID: item.RunID, scopeID: item.ScopeID, vertexID: item.VertexID, operation: "status",
			leaseVertexID: item.VertexID, leaseSource: "work_queue",
			tool: item.Payload.Txn.StatusTool, idempotencyKey: item.Payload.Txn.IdempotencyKey,
			input: item.Payload.Input, policy: item.Payload.RetryPolicy, pin: companionPin(item.Payload.ToolViewDigest),
		})
		if statusErr != nil {
			return statusErr
		}
		if status.response.Outcome == model.OutcomeSucceeded {
			occurred, valid := status.response.Result["occurred"].(bool)
			if !valid {
				result.response = model.OperationResponse{Outcome: model.OutcomeUnknown, Error: "pivot status response omitted boolean occurred"}
			} else if !occurred {
				return service.failAbsentPivot(ctx, item, result, "pivot status confirmed absence")
			} else {
				// The status query is the one thing that may resolve an unknown pivot, so it is
				// also what writes the outcome onto the pivot's own attempt evidence.
				if err := service.store.ResolveAttempt(ctx, service.worker, result.attemptID, "succeeded", "pivot status confirmed occurrence"); err != nil {
					return err
				}
				result.response = model.OperationResponse{Outcome: model.OutcomeSucceeded, Result: map[string]any{"status_confirmed": true}}
			}
		} else {
			result.response = model.OperationResponse{Outcome: model.OutcomeUnknown, Error: "pivot status query did not establish an outcome: " + status.response.Error}
		}
	}
	response, attempts := result.response, result.attempts
	if response.Outcome != model.OutcomeSucceeded {
		if response.Outcome != model.OutcomeUnknown {
			return service.failAbsentPivot(ctx, item, result, response.Error)
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

func (service *Service) failAbsentPivot(ctx context.Context, item *model.WorkItem, result execution, detail string) error {
	// Proven absence is a definitive outcome, so it resolves the attempt. Without this the scope
	// would carry unresolved evidence of an effect the status query has just disproved, and would
	// suspend where it is safe to cancel. An attempt already resolved keeps its first answer.
	if result.attemptID != 0 {
		if err := service.store.ResolveAttempt(ctx, service.worker, result.attemptID, "confirmed-absent", detail); err != nil {
			return err
		}
	}
	if err := service.store.ResolvePivotAbsent(ctx, item.RunID, item.ScopeID, item.VertexID); err != nil {
		return err
	}
	if err := service.store.Append(ctx, item.RunID, vertexEvent("vertex/failed", item, map[string]any{"attempts": result.attempts, "error": detail, "outcome": "confirmed-absent"})); err != nil {
		return err
	}
	if err := service.fenceScope(ctx, item.RunID, item.ScopeID, "pivot confirmed absent"); err != nil {
		return err
	}
	return service.store.CompleteWork(ctx, service.worker, item.VertexID)
}

// fenceScope asks the database, under the scope lock, whether this scope may cancel at all, and
// then does exactly what it was told.
//
// The decision cannot be taken here. An expired deadline, an empty queue, and a dead lease are all
// observations that may be stale by the time they are acted on, and one of the three answers --
// suspend on an unresolved attempt -- exists precisely because releasing reservations behind an
// effect that may still land is the failure this whole path is built to refuse.
func (service *Service) fenceScope(ctx context.Context, runID, scopeID, reason string) error {
	key := cancelKey(scopeID)
	decision, err := service.store.RequestScopeCancel(ctx, service.worker, runID, scopeID, key, reason)
	if err != nil {
		return err
	}
	switch decision {
	case store.CancelRequested, store.CancelDuplicate:
		return service.cancelScope(ctx, runID, scopeID, key)
	case store.CancelSuspended:
		service.logger.Warn("scope suspended holding an unresolved attempt", "run_id", runID, "scope_id", scopeID, "reason", reason)
	case store.CancelDeferred:
		service.logger.Info("scope cancellation deferred by a live lease", "run_id", runID, "scope_id", scopeID, "reason", reason)
	}
	return nil
}

func (service *Service) confirmScope(ctx context.Context, item *model.WorkItem) (bool, error) {
	brackets, err := service.store.SealedBrackets(ctx, item.RunID, item.ScopeID)
	if err != nil {
		return false, err
	}
	for _, bracket := range brackets {
		// The confirm runs on the bracket's own vertex, but what authorizes it is the pivot
		// worker's live lease: the bracket's queue row is long gone.
		result, err := service.executeWithRetry(ctx, call{
			runID: item.RunID, scopeID: item.ScopeID, vertexID: bracket.VertexID, operation: "confirm",
			leaseVertexID: item.VertexID, leaseSource: "work_queue",
			tool: bracket.ConfirmTool, idempotencyKey: bracket.IdempotencyKey,
			input: bracket.ConfirmInput, policy: bracket.RetryPolicy, pin: companionPin(bracket.ToolViewDigest),
		})
		if err != nil {
			return false, err
		}
		response := result.response
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
		result, err := service.executeWithRetry(ctx, call{
			runID: runID, scopeID: scopeID, vertexID: member.VertexID, operation: "inverse",
			leaseVertexID: member.VertexID, leaseSource: "cancel_member",
			tool: member.InverseTool, idempotencyKey: member.IdempotencyKey,
			input: member.InverseInput, policy: member.RetryPolicy, pin: companionPin(member.ToolViewDigest),
		})
		if err != nil {
			return err
		}
		if result.response.Outcome != model.OutcomeSucceeded {
			return service.store.Append(ctx, runID, model.EventDraft{EventType: "txn/scope", ScopeID: &scopeID, Payload: map[string]any{"state": "suspended"}})
		}
		if err := service.store.CompleteCancelMember(ctx, service.worker, runID, scopeID, member.VertexID); err != nil {
			return err
		}
	}
}

// call is one adapter request: what to send, and what authorizes sending it.
//
// leaseVertexID is separate from vertexID because the two diverge on every companion operation: a
// confirm is made against its bracket's vertex while the authority to make it is the pivot
// worker's live queue lease, and an inverse operation is authorized by a cancellation-member lease
// instead. Recording the attempt is what turns that authority into something a later sweep can
// check, so the two have to be carried apart.
type call struct {
	runID          string
	scopeID        string
	vertexID       string
	operation      string
	leaseVertexID  string
	leaseSource    string
	tool           string
	idempotencyKey string
	input          map[string]any
	policy         generated.RetryPolicy
	pin            model.ToolPin
}

// execution is one completed adapter exchange together with the evidence row it left behind.
type execution struct {
	response model.OperationResponse
	attempts int
	// attemptID identifies the final attempt's txn_attempt row, so a later definitive answer --
	// a pivot status query, above all -- can resolve evidence the call itself could not.
	attemptID int64
}

func (service *Service) executeWithRetry(ctx context.Context, request call) (execution, error) {
	identity, err := service.store.WorkflowIdentity(ctx, request.runID)
	if err != nil {
		return execution{}, err
	}
	result := execution{}
	for attempt := 1; attempt <= request.policy.MaxAttempts; attempt++ {
		if delay := model.Backoff(request.policy, attempt); delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				result.attempts = attempt - 1
				return result, ctx.Err()
			case <-timer.C:
			}
		}
		result.attempts = attempt
		// Durable before the request leaves, never after: a record written afterwards cannot
		// describe a request that was sent and then lost its worker, which is the one case the
		// sweeper has no other way to recognize.
		attemptID, err := service.store.RecordAttemptStart(ctx, service.worker, store.AttemptStart{
			RunID: request.runID, ScopeID: request.scopeID, VertexID: request.vertexID, Operation: request.operation,
			AttemptNo: attempt, Tool: request.tool, IdempotencyKey: request.idempotencyKey,
			LeaseVertexID: request.leaseVertexID, LeaseSource: request.leaseSource,
		})
		if err != nil {
			return result, err
		}
		result.attemptID = attemptID
		response, err := service.adapter.Execute(ctx, model.OperationRequest{
			RunID: request.runID, VertexID: request.vertexID, ScopeID: request.scopeID, AttemptNo: attempt, Tool: request.tool,
			ToolVersion: request.pin.Version, ToolViewDigest: request.pin.ViewDigest, IdempotencyKey: request.idempotencyKey,
			Input: request.input, AuthorizationIdentity: identity,
		})
		if err != nil {
			// A transport error says nothing about whether the tool ran, so the attempt stays
			// unresolved and the scope will suspend rather than release its reservations.
			return result, err
		}
		result.response = response
		if response.Outcome != model.OutcomeUnknown {
			if err := service.store.ResolveAttempt(ctx, service.worker, attemptID, string(response.Outcome), response.Error); err != nil {
				return result, err
			}
		}
		if response.Outcome != model.OutcomeRetryableFailure || attempt == request.policy.MaxAttempts {
			return result, nil
		}
		vertex := request.vertexID
		if err := service.store.Append(ctx, request.runID, model.EventDraft{EventType: "vertex/retried", VertexID: &vertex, Payload: map[string]any{"attempt": attempt + 1, "error": response.Error}}); err != nil {
			return result, err
		}
	}
	result.response = model.OperationResponse{Outcome: model.OutcomePermanentFailure, Error: "retry policy exhausted"}
	result.attempts = request.policy.MaxAttempts
	return result, nil
}

// Sweep offers every expired sealed bracket to the scope fence and resumes fenced cancellations
// whose member leases are no longer live.
//
// What the sweep produces is candidates, never verdicts. Each candidate is re-examined under the
// scope lock by fenceScope, which defers on a live lease, suspends on an unresolved attempt, and
// cancels only a scope that holds neither.
//
// One scope's failure no longer abandons the rest of the sweep: these are independent recoveries,
// and a stuck cancellation that keeps erroring would otherwise starve every scope behind it.
func (service *Service) Sweep(ctx context.Context) error {
	expired, err := service.store.ExpiredScopes(ctx)
	if err != nil {
		return err
	}
	failures := []error{}
	for runID, scopes := range expired {
		for _, scopeID := range scopes {
			if err := service.fenceScope(ctx, runID, scopeID, "sealed try timeout"); err != nil {
				failures = append(failures, fmt.Errorf("fence scope %s: %w", scopeID, err))
			}
		}
	}
	stuck, err := service.store.StuckCancellations(ctx)
	if err != nil {
		return errors.Join(append(failures, err)...)
	}
	for _, cancellation := range stuck {
		if err := service.cancelScope(ctx, cancellation.RunID, cancellation.ScopeID, cancellation.IdempotencyKey); err != nil {
			failures = append(failures, fmt.Errorf("resume cancellation of scope %s: %w", cancellation.ScopeID, err))
		}
	}
	return errors.Join(failures...)
}

// cancelKey is the one idempotency key a scope's cancellation ever uses, so a resumed sweep and
// the worker that first fenced the scope name the same cancellation.
func cancelKey(scopeID string) string {
	return "scope:" + scopeID + ":cancel"
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

// optionalObject records a frozen companion argument set, and omits it when the
// tool declared no such companion.
func optionalObject(values map[string]any, key string, value map[string]any) {
	if value != nil {
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
