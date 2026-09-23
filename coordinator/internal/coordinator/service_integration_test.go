package coordinator

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/linuxb/flory-ai/coordinator/internal/model"
	"github.com/linuxb/flory-ai/coordinator/internal/store"
)

type recordingAdapter struct {
	outcomes map[string]model.OperationOutcome
	// results replaces a successful call's result, for a tool whose answer the scenario reads.
	results map[string]map[string]any
	// scopedTo records calls for one run only. The sweeper is global, so a scenario that runs a
	// sweep would otherwise see recovery work belonging to an earlier scenario's leftovers.
	scopedTo string
	calls    []string
}

func (adapter *recordingAdapter) Execute(_ context.Context, request model.OperationRequest) (model.OperationResponse, error) {
	if adapter.scopedTo == "" || adapter.scopedTo == request.RunID {
		adapter.calls = append(adapter.calls, request.Tool)
	}
	if outcome, found := adapter.outcomes[request.Tool]; found {
		return model.OperationResponse{Outcome: outcome, Error: "injected " + string(outcome)}, nil
	}
	if result, found := adapter.results[request.Tool]; found {
		return model.OperationResponse{Outcome: model.OutcomeSucceeded, Result: result}, nil
	}
	return model.OperationResponse{Outcome: model.OutcomeSucceeded, Result: map[string]any{"tool": request.Tool}}, nil
}

func TestRuntimeBarrierAndPostPivotConfirm(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{}
	service := New(database, adapter, Config{WorkerID: "integration-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 3 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(adapter.calls, []string{"inventory.reserve.a", "inventory.reserve.b", "payment.capture", "inventory.confirm.a", "inventory.confirm.b"}) {
		t.Fatalf("unexpected adapter calls: %v", adapter.calls)
	}
	var pivotSeq int64
	var earliestConfirm int64
	if err := engine.QueryRow(ctx, `SELECT min(run_seq) FILTER (WHERE event_type = 'txn/pivot-passed'), min(run_seq) FILTER (WHERE event_type = 'txn/confirm')
        FROM run_event_log WHERE run_id = $1`, runID).Scan(&pivotSeq, &earliestConfirm); err != nil {
		t.Fatal(err)
	}
	if earliestConfirm <= pivotSeq {
		t.Fatalf("confirm seq %d must follow pivot seq %d", earliestConfirm, pivotSeq)
	}
}

// A pre-pivot failure fences its scope and cancels nothing. Cancellation is the Engine's decision,
// taken with the replan it serves; the Coordinator executes it once asked, and not before.
func TestTryFailureFencesUntilEngineRequests(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{outcomes: map[string]model.OperationOutcome{"inventory.reserve.b": model.OutcomePermanentFailure}}
	service := New(database, adapter, Config{WorkerID: "cancel-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 3 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// The third pass found nothing: the pivot's parents did not all succeed, and the scope is
	// fenced, so neither the pivot nor anything else in it is handed out.
	if !slices.Equal(adapter.calls, []string{"inventory.reserve.a", "inventory.reserve.b"}) {
		t.Fatalf("calls before the engine asked: %v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "open")
	if !scopeFenced(t, ctx, engine, runID, scopeID) {
		t.Fatal("a pre-pivot failure left its scope unfenced")
	}
	if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 0 {
		t.Fatalf("the Coordinator cancelled on its own: %d txn/cancel events", cancels)
	}
	if admitted, err := database.AdmitPivot(ctx, runID, scopeID, pivot); err != nil || admitted {
		t.Fatalf("a fenced scope admitted its pivot: admitted=%v error=%v", admitted, err)
	}

	requestEngineCancel(t, ctx, engine, runID, second, scopeID)
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(adapter.calls, []string{"inventory.reserve.a", "inventory.reserve.b", "inventory.release.a"}) {
		t.Fatalf("unexpected scope-cancel calls: %v", adapter.calls)
	}
	var state string
	var cancelEvents, pivotEvents int
	if err := engine.QueryRow(ctx, `SELECT state FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := engine.QueryRow(ctx, `SELECT count(*) FILTER (WHERE event_type = 'txn/cancel'), count(*) FILTER (WHERE event_type = 'txn/pivot-passed')
        FROM run_event_log WHERE run_id = $1`, runID).Scan(&cancelEvents, &pivotEvents); err != nil {
		t.Fatal(err)
	}
	if state != "cancelled" || cancelEvents != 2 || pivotEvents != 0 {
		t.Fatalf("state=%s cancel_events=%d pivot_events=%d", state, cancelEvents, pivotEvents)
	}
}

func TestConfirmExhaustionSuspendsWithoutCommit(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{outcomes: map[string]model.OperationOutcome{"inventory.confirm.a": model.OutcomePermanentFailure}}
	service := New(database, adapter, Config{WorkerID: "confirm-suspend-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 3 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var state string
	var committedEvents int
	if err := engine.QueryRow(ctx, `SELECT state FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := engine.QueryRow(ctx, `SELECT count(*) FROM run_event_log WHERE run_id = $1 AND event_type = 'txn/scope' AND payload->>'state' = 'committed'`, runID).Scan(&committedEvents); err != nil {
		t.Fatal(err)
	}
	if state != "suspended" || committedEvents != 0 {
		t.Fatalf("state=%s committed_events=%d", state, committedEvents)
	}
}

func TestUnknownPivotStatusFailureSuspendsWithoutCancel(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{outcomes: map[string]model.OperationOutcome{
		"payment.capture": model.OutcomeUnknown,
		"payment.status":  model.OutcomePermanentFailure,
	}}
	service := New(database, adapter, Config{WorkerID: "unknown-pivot-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 3 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var state string
	var cancelEvents, pivotEvents int
	if err := engine.QueryRow(ctx, `SELECT state FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := engine.QueryRow(ctx, `SELECT count(*) FILTER (WHERE event_type = 'txn/cancel'), count(*) FILTER (WHERE event_type = 'txn/pivot-passed')
        FROM run_event_log WHERE run_id = $1`, runID).Scan(&cancelEvents, &pivotEvents); err != nil {
		t.Fatal(err)
	}
	if state != "suspended" || cancelEvents != 0 || pivotEvents != 0 {
		t.Fatalf("state=%s cancel_events=%d pivot_events=%d", state, cancelEvents, pivotEvents)
	}
	// The pivot's own unknown outcome suspends; it does not fence, because the scope was not open.
	if scopeFenced(t, ctx, engine, runID, scopeID) {
		t.Fatal("an unknown pivot outcome fenced its scope")
	}
}

func TestScopeCancelResumesAfterCompletedMember(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
	setupAdapter := &recordingAdapter{}
	setupService := New(database, setupAdapter, Config{WorkerID: "cancel-setup-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 2 {
		if err := setupService.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	key := "scope:" + scopeID + ":cancel"
	requestEngineCancel(t, ctx, engine, runID, second, scopeID)
	if decision, err := database.RequestScopeCancel(ctx, "cancel-setup-worker", runID, scopeID, key, "recovery test", store.CancelOriginEngine); err != nil || decision != store.CancelRequested {
		t.Fatalf("request scope cancel: decision=%s error=%v", decision, err)
	}
	completed, err := database.ClaimCancelMember(ctx, "crashed-worker", runID, scopeID, time.Minute)
	if err != nil || completed == nil {
		t.Fatalf("claim first cancel member: member=%v error=%v", completed, err)
	}
	if err := database.CompleteCancelMember(ctx, "crashed-worker", runID, scopeID, completed.VertexID); err != nil {
		t.Fatal(err)
	}
	restartedAdapter := &recordingAdapter{}
	restarted := New(database, restartedAdapter, Config{WorkerID: "restarted-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := restarted.cancelScope(ctx, runID, scopeID, key); err != nil {
		t.Fatal(err)
	}
	if len(restartedAdapter.calls) != 1 || restartedAdapter.calls[0] == completed.InverseTool {
		t.Fatalf("restart calls=%v, already completed inverse=%s", restartedAdapter.calls, completed.InverseTool)
	}
	var state string
	if err := engine.QueryRow(ctx, `SELECT state FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "cancelled" {
		t.Fatalf("state=%s, want cancelled", state)
	}
}

func TestSweepCancelsExpiredOpenScope(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 1))
	setup := New(database, &recordingAdapter{}, Config{WorkerID: "sweep-setup-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 2 {
		if err := setup.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(1100 * time.Millisecond)
	adapter := &recordingAdapter{}
	sweeper := New(database, adapter, Config{WorkerID: "sweep-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := sweeper.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(adapter.calls, []string{"inventory.release.a", "inventory.release.b"}) {
		t.Fatalf("sweeper calls=%v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
}

func TestSweepResumesCancellationAfterLeaseExpires(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
	setup := New(database, &recordingAdapter{}, Config{WorkerID: "recovery-setup-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 2 {
		if err := setup.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	key := "scope:" + scopeID + ":cancel"
	requestEngineCancel(t, ctx, engine, runID, second, scopeID)
	if decision, err := database.RequestScopeCancel(ctx, "recovery-setup-worker", runID, scopeID, key, "sweeper takeover test", store.CancelOriginEngine); err != nil || decision != store.CancelRequested {
		t.Fatalf("request scope cancel: decision=%s error=%v", decision, err)
	}
	claimed, err := database.ClaimCancelMember(ctx, "crashed-worker", runID, scopeID, time.Second)
	if err != nil || claimed == nil {
		t.Fatalf("claim cancel member before crash: member=%v error=%v", claimed, err)
	}
	adapter := &recordingAdapter{}
	sweeper := New(database, adapter, Config{WorkerID: "takeover-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := sweeper.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if len(adapter.calls) != 0 {
		t.Fatalf("live lease was taken over: calls=%v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "cancelling")
	time.Sleep(1100 * time.Millisecond)
	if err := sweeper.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if len(adapter.calls) != 2 {
		t.Fatalf("expired lease recovery calls=%v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
}

// S19 -- cancel-versus-claim race. The two orders must produce opposite, complete outcomes, and
// never a third state where cancellation has started and a member call is running under it.
func TestS19CancelVersusClaimRaceIsDecisive(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	t.Run("cancellation first", func(t *testing.T) {
		runID, scopeID, first, second, _ := scenarioIDs(t)
		if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
			t.Fatal(err)
		}
		appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
		setup := New(database, &recordingAdapter{}, Config{WorkerID: "race-setup-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		if err := setup.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
		requestEngineCancel(t, ctx, engine, runID, first, scopeID)
		decision, err := database.RequestScopeCancel(ctx, "race-sweeper", runID, scopeID, cancelKey(scopeID), "cancel wins the race", store.CancelOriginEngine)
		if err != nil || decision != store.CancelRequested {
			t.Fatalf("fence decision=%s error=%v, want requested", decision, err)
		}
		// The fence took the queued member with it, and the eligibility filter refuses the scope
		// anyway, so no member adapter call can start after cancellation commits.
		item, err := database.ClaimWork(ctx, "race-claimer", time.Minute)
		if err != nil || item != nil {
			t.Fatalf("claim after cancellation: item=%v error=%v, want none", item, err)
		}
		if queued := countQueued(t, ctx, engine, runID, second); queued != 0 {
			t.Fatalf("pending ordinary work survived the fence: %d rows", queued)
		}
		// Drain the fence this subtest opened. The sweeper is global, so a cancellation left
		// half-finished here would be resumed inside an unrelated scenario's sweep.
		sweeper := New(database, &recordingAdapter{}, Config{WorkerID: "race-sweeper", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		if err := sweeper.cancelScope(ctx, runID, scopeID, cancelKey(scopeID)); err != nil {
			t.Fatal(err)
		}
		assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
	})

	t.Run("claim first", func(t *testing.T) {
		runID, scopeID, first, second, _ := scenarioIDs(t)
		if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
			t.Fatal(err)
		}
		appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
		setup := New(database, &recordingAdapter{}, Config{WorkerID: "race-setup-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		if err := setup.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
		claimed, err := database.ClaimWork(ctx, "race-holder", time.Minute)
		if err != nil || claimed == nil || claimed.VertexID != second {
			t.Fatalf("claim before cancellation: item=%v error=%v", claimed, err)
		}
		// The Engine asks after the claim: the scope is still open, so the request is accepted,
		// and the live lease is what defers it.
		requestEngineCancel(t, ctx, engine, runID, first, scopeID)
		decision, err := database.RequestScopeCancel(ctx, "race-sweeper", runID, scopeID, cancelKey(scopeID), "claim wins the race", store.CancelOriginEngine)
		if err != nil || decision != store.CancelDeferred {
			t.Fatalf("fence decision=%s error=%v, want deferred", decision, err)
		}
		assertScopeState(t, ctx, engine, runID, scopeID, "open")
		if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 0 {
			t.Fatalf("a live lease was cancelled through: %d txn/cancel events", cancels)
		}
		if outcome := requestOutcome(t, ctx, engine, runID, scopeID); outcome != "deferred" {
			t.Fatalf("request outcome=%s, want deferred", outcome)
		}
		// Settle what this subtest opened, so no later scenario's pass picks up its request.
		if err := database.ReleaseWork(ctx, "race-holder", second, 0); err != nil {
			t.Fatal(err)
		}
		if decision, err := database.RequestScopeCancel(ctx, "race-sweeper", runID, scopeID, cancelKey(scopeID), "lease released", store.CancelOriginEngine); err != nil || decision != store.CancelRequested {
			t.Fatalf("after release decision=%s error=%v, want requested", decision, err)
		}
		sweeper := New(database, &recordingAdapter{}, Config{WorkerID: "race-sweeper", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		if err := sweeper.cancelScope(ctx, runID, scopeID, cancelKey(scopeID)); err != nil {
			t.Fatal(err)
		}
		assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
	})
}

// S19a -- an attempt with a durable start and no recorded outcome. A lease expiry proves only that
// a worker stopped renewing, so the reservations stay and a person decides.
func TestS19aUnresolvedAttemptSuspendsWithoutCancelling(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 1))
	setup := New(database, &recordingAdapter{}, Config{WorkerID: "stall-setup-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := setup.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	stalled, err := database.ClaimWork(ctx, "stalled-worker", time.Second)
	if err != nil || stalled == nil || stalled.VertexID != second {
		t.Fatalf("claim the member that will stall: item=%v error=%v", stalled, err)
	}
	attemptID, err := database.RecordAttemptStart(ctx, "stalled-worker", store.AttemptStart{
		RunID: runID, ScopeID: scopeID, VertexID: stalled.VertexID, Operation: "call", AttemptNo: 1,
		Tool: "inventory.reserve.b", IdempotencyKey: scopeID + ":reserve-b",
		LeaseVertexID: stalled.VertexID, LeaseSource: "work_queue",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Past both the member lease and the sealed bracket's deadline: the scope is now a
	// cancellation candidate by every observation the old sweeper had.
	time.Sleep(1200 * time.Millisecond)
	adapter := &recordingAdapter{scopedTo: runID}
	sweeper := New(database, adapter, Config{WorkerID: "stall-sweeper", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := sweeper.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "suspended")
	if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 0 {
		t.Fatalf("an unresolved attempt was cancelled through: %d txn/cancel events", cancels)
	}
	if len(adapter.calls) != 0 {
		t.Fatalf("suspension ran inverse operations: %v", adapter.calls)
	}
	if queued := countQueued(t, ctx, engine, runID, second); queued != 1 {
		t.Fatalf("suspension discarded the queue it must preserve: %d rows", queued)
	}
	if unresolved := countUnresolvedAttempts(t, ctx, engine, runID, scopeID); unresolved != 1 {
		t.Fatalf("attempt evidence count=%d, want one unresolved row", unresolved)
	}
	if item, err := database.ClaimWork(ctx, "redispatch-worker", time.Minute); err != nil || item != nil {
		t.Fatalf("suspended scope redispatched work: item=%v error=%v", item, err)
	}
	// A late worker result is evidence. It resolves the row and authorizes nothing else: the scope
	// is no longer open, so no sweep may cancel it and no claim may restart it.
	if err := database.ResolveAttempt(ctx, "stalled-worker", attemptID, "succeeded", "late result after suspension"); err != nil {
		t.Fatal(err)
	}
	if err := sweeper.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "suspended")
	if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 0 {
		t.Fatalf("a late result authorized cancellation: %d txn/cancel events", cancels)
	}
	if item, err := database.ClaimWork(ctx, "redispatch-worker", time.Minute); err != nil || item != nil {
		t.Fatalf("a late result authorized redispatch: item=%v error=%v", item, err)
	}
}

// S19b -- claim eligibility follows the operation's frozen phase. A scope that has passed its pivot
// still carries forward work admitted at freeze, and carries nothing else.
func TestS19bPostPivotClaimEligibility(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, engineURL())
	defer engine.Close()
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	forward, lateTry := siblingID(pivot, "904"), siblingID(pivot, "905")
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{scopedTo: runID}
	service := New(database, adapter, Config{WorkerID: "post-pivot-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	// Frozen once the scope is already open, which is why the late try is not one of its required
	// members and the pivot barrier does not wait for it. That is the shape the eligibility filter
	// exists for: a try whose phase has passed, sitting in a scope that still exists.
	appendEngineEvents(t, ctx, engine, runID, postPivotFixture(scopeID, pivot, forward, lateTry))
	for range 5 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	expected := []string{"inventory.reserve.a", "inventory.reserve.b", "payment.capture", "inventory.confirm.a", "inventory.confirm.b", "logistics.notify"}
	if !slices.Equal(adapter.calls, expected) {
		t.Fatalf("post-pivot calls=%v, want %v", adapter.calls, expected)
	}
	// The fresh try behind the pivot is refused by phase, not consumed: its row is still queued,
	// waiting for a graph state that will never arrive in this scope.
	if queued := countQueued(t, ctx, engine, runID, lateTry); queued != 1 {
		t.Fatalf("the post-pivot try row count=%d, want the row left intact", queued)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "committed")
	if _, err := database.RequestScopeCancel(ctx, "post-pivot-worker", runID, scopeID, cancelKey(scopeID), "backward cancellation", store.CancelOriginEngine); err == nil {
		t.Fatal("backward cancellation of a committed scope was accepted")
	}
	if err := tryEngineCancel(ctx, engine, runID, second, scopeID); err == nil {
		t.Fatal("the Engine was allowed to request cancellation of a committed scope")
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "committed")
}

// A failure after the pivot is forward recovery's, and there is nothing to fence or cancel. The
// Coordinator used to ask anyway; the database refused a committed scope, the error skipped the
// row's completion, and the row stayed leased with its worker gone.
func TestPostPivotForwardFailureCompletesWork(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	forward, lateTry := siblingID(pivot, "904"), siblingID(pivot, "905")
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{scopedTo: runID, outcomes: map[string]model.OperationOutcome{"logistics.notify": model.OutcomePermanentFailure}}
	service := New(database, adapter, Config{WorkerID: "forward-failure-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, postPivotFixture(scopeID, pivot, forward, lateTry))
	for range 5 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatalf("a post-pivot failure errored the pass: %v", err)
		}
	}
	if countEvents(t, ctx, engine, runID, "vertex/failed") != 1 {
		t.Fatalf("forward call did not fail as injected: calls=%v", adapter.calls)
	}
	if queued := countQueued(t, ctx, engine, runID, forward); queued != 0 {
		t.Fatalf("the failed forward call's row was left behind: %d rows", queued)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "committed")
	if scopeFenced(t, ctx, engine, runID, scopeID) {
		t.Fatal("a post-pivot failure fenced a committed scope")
	}
	if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 0 {
		t.Fatalf("a post-pivot failure cancelled: %d txn/cancel events", cancels)
	}
}

// A pivot the status query proves never happened reopens its scope already fenced, and waits for
// the Engine exactly as any other pre-pivot failure does.
func TestAbsentPivotFencesWithoutCancelling(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, pivot := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, barrierFixture(scopeID, first, second, pivot))
	adapter := &recordingAdapter{
		outcomes: map[string]model.OperationOutcome{"payment.capture": model.OutcomeUnknown},
		results:  map[string]map[string]any{"payment.status": {"occurred": false}},
	}
	service := New(database, adapter, Config{WorkerID: "absent-pivot-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	for range 4 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(adapter.calls, []string{"inventory.reserve.a", "inventory.reserve.b", "payment.capture", "payment.status"}) {
		t.Fatalf("calls before the engine asked: %v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "open")
	if !scopeFenced(t, ctx, engine, runID, scopeID) {
		t.Fatal("a pivot proven absent left its scope unfenced")
	}
	if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 0 {
		t.Fatalf("the Coordinator cancelled on its own: %d txn/cancel events", cancels)
	}
	requestEngineCancel(t, ctx, engine, runID, pivot, scopeID)
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(adapter.calls[4:], []string{"inventory.release.a", "inventory.release.b"}) {
		t.Fatalf("inverse calls after the request: %v", adapter.calls[4:])
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
}

// A request a live lease defers is not dropped: it stays pending and is decided on a later pass.
func TestEngineRequestDeferredIsRetried(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
	adapter := &recordingAdapter{scopedTo: runID}
	service := New(database, adapter, Config{WorkerID: "deferred-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	if held, err := database.ClaimWork(ctx, "lease-holder", time.Minute); err != nil || held == nil || held.VertexID != second {
		t.Fatalf("claim the member that holds the lease: item=%v error=%v", held, err)
	}
	requestEngineCancel(t, ctx, engine, runID, first, scopeID)
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	if outcome := requestOutcome(t, ctx, engine, runID, scopeID); outcome != "deferred" {
		t.Fatalf("request outcome=%s, want deferred", outcome)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "open")
	if err := database.ReleaseWork(ctx, "lease-holder", second, 0); err != nil {
		t.Fatal(err)
	}
	// A deferred request comes round again a second later, not on every poll.
	time.Sleep(1100 * time.Millisecond)
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	if outcome := requestOutcome(t, ctx, engine, runID, scopeID); outcome != "requested" {
		t.Fatalf("request outcome=%s, want requested", outcome)
	}
	if !slices.Equal(adapter.calls, []string{"inventory.reserve.a", "inventory.release.a"}) {
		t.Fatalf("calls=%v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
}

// The orphan sweep and an Engine request share one cancel key, so whichever arrives first, a scope
// is cancelled exactly once and each inverse runs exactly once.
func TestSweepAndEngineRequestConverge(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	expired := func(t *testing.T) (string, string, string) {
		runID, scopeID, first, second, _ := scenarioIDs(t)
		if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
			t.Fatal(err)
		}
		appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 1))
		setup := New(database, &recordingAdapter{}, Config{WorkerID: "converge-setup", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		for range 2 {
			if err := setup.ProcessOne(ctx); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(1100 * time.Millisecond)
		return runID, scopeID, first
	}

	t.Run("engine request first", func(t *testing.T) {
		runID, scopeID, first := expired(t)
		requestEngineCancel(t, ctx, engine, runID, first, scopeID)
		adapter := &recordingAdapter{scopedTo: runID}
		service := New(database, adapter, Config{WorkerID: "converge-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		if err := service.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		// The sweep's cancellation answered the pending request, so the next pass finds nothing.
		if outcome := requestOutcome(t, ctx, engine, runID, scopeID); outcome != "requested" {
			t.Fatalf("request outcome=%s, want requested", outcome)
		}
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(adapter.calls, []string{"inventory.release.a", "inventory.release.b"}) {
			t.Fatalf("inverse calls=%v", adapter.calls)
		}
		assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
		if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 2 {
			t.Fatalf("txn/cancel events=%d, want one requested and one completed", cancels)
		}
	})

	t.Run("sweep first", func(t *testing.T) {
		runID, scopeID, first := expired(t)
		adapter := &recordingAdapter{scopedTo: runID}
		service := New(database, adapter, Config{WorkerID: "converge-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
		if err := service.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		// The Engine reads the scope under the same lock and sees it cancelled, so it has no reason
		// to ask; if it asked anyway, the database refuses rather than start a second cancellation.
		if err := tryEngineCancel(ctx, engine, runID, first, scopeID); err == nil {
			t.Fatal("a request for an already cancelled scope was accepted")
		}
		if !slices.Equal(adapter.calls, []string{"inventory.release.a", "inventory.release.b"}) {
			t.Fatalf("inverse calls=%v", adapter.calls)
		}
		if cancels := countEvents(t, ctx, engine, runID, "txn/cancel"); cancels != 2 {
			t.Fatalf("txn/cancel events=%d, want one requested and one completed", cancels)
		}
	})
}

// A pending request whose scope suspended by some other path resolves as suspended, once, instead
// of raising on every poll and starving every other run's claims.
func TestRequestOnScopeSuspendedAfterRequest(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
	adapter := &recordingAdapter{scopedTo: runID}
	service := New(database, adapter, Config{WorkerID: "suspended-request-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	requestEngineCancel(t, ctx, engine, runID, first, scopeID)
	if err := database.AppendScoped(ctx, runID, scopeID, model.EventDraft{EventType: "txn/scope", ScopeID: &scopeID, Payload: map[string]any{"state": "suspended", "reason": "operator hold"}}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := service.ProcessOne(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if outcome := requestOutcome(t, ctx, engine, runID, scopeID); outcome != "suspended" {
		t.Fatalf("request outcome=%s, want suspended", outcome)
	}
	if len(adapter.calls) != 1 {
		t.Fatalf("a suspended scope ran work: calls=%v", adapter.calls)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "suspended")
}

// A failure-driven cancellation needs the Engine's request; asking without one is refused by name.
func TestFailureDrivenCancelRequiresEngineRequest(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60))
	setup := New(database, &recordingAdapter{}, Config{WorkerID: "unrequested-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := setup.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := database.RequestScopeCancel(ctx, "unrequested-worker", runID, scopeID, cancelKey(scopeID), "no request", store.CancelOriginEngine); err == nil {
		t.Fatal("a failure-driven cancellation without an engine request was accepted")
	}
	if decision, err := database.RequestScopeCancel(ctx, "unrequested-worker", runID, scopeID, cancelKey(scopeID), "not expired", store.CancelOriginTimeout); err != nil || decision != store.CancelIneligible {
		t.Fatalf("timeout decision=%s error=%v, want ineligible", decision, err)
	}
	// Around the function as well: the projection refuses an unauthorized txn/cancel outright.
	if err := database.AppendScoped(ctx, runID, scopeID, model.EventDraft{EventType: "txn/cancel", ScopeID: &scopeID, Payload: map[string]any{"idempotency_key": cancelKey(scopeID), "phase": "requested"}}); err == nil {
		t.Fatal("an unauthorized txn/cancel was accepted")
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "open")
	// Leave nothing behind for a later scenario: the Engine asks, and the request is served here.
	requestEngineCancel(t, ctx, engine, runID, first, scopeID)
	if err := setup.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	assertScopeState(t, ctx, engine, runID, scopeID, "cancelled")
}

func openIntegration(t *testing.T, ctx context.Context) (*pgxpool.Pool, *store.PostgresStore) {
	t.Helper()
	engine := openPool(t, ctx, engineURL())
	t.Cleanup(engine.Close)
	database, err := store.Open(ctx, coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return engine, database
}

// postPivotFixture places two vertices behind the pivot: one plain forward call, which was
// admitted at freeze and stays claimable, and one fresh TCC try, which would seal a bracket the
// pivot has already passed.
func postPivotFixture(integrationScope, pivotVertex, forwardVertex, lateTryVertex string) []map[string]any {
	retry := map[string]any{"max_attempts": 2, "initial_backoff_ms": 0, "multiplier": 2, "max_backoff_ms": 0}
	return []map[string]any{
		{"event_type": "vertex/created", "vertex_id": forwardVertex, "parent_refs": []string{pivotVertex}, "scope_id": integrationScope,
			"payload": map[string]any{"role": "tool", "tool": "logistics.notify", "input": map[string]any{"order_id": "ORDER-1"}, "retry_policy": retry,
				"txn": map[string]any{"effect_class": "reversible", "mode": "plain", "idempotency_key": integrationScope + ":notify"}}},
		{"event_type": "vertex/created", "vertex_id": lateTryVertex, "parent_refs": []string{pivotVertex}, "scope_id": integrationScope,
			"payload": map[string]any{"role": "tool", "tool": "inventory.reserve.c", "input": map[string]any{"sku": "SKU-2"}, "retry_policy": retry,
				"txn": map[string]any{"effect_class": "reversible", "mode": "tcc", "idempotency_key": integrationScope + ":reserve-c", "try_timeout_s": 60,
					"confirm_tool": "inventory.confirm.c", "cancel_tool": "inventory.release.c"}}},
	}
}

// siblingID mints another vertex id in the same random family as a scenario's own, so two runs of
// the suite never collide and claim order stays the fixture's declared order.
func siblingID(sibling, suffix string) string {
	return sibling[:len(sibling)-len(suffix)] + suffix
}

// requestEngineCancel appends the Engine's request, which is the only thing that authorizes a
// failure-driven cancellation.
func requestEngineCancel(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, failedVertex string, scopeIDs ...string) {
	t.Helper()
	if err := tryEngineCancel(ctx, engine, runID, failedVertex, scopeIDs...); err != nil {
		t.Fatal(err)
	}
}

func tryEngineCancel(ctx context.Context, engine *pgxpool.Pool, runID, failedVertex string, scopeIDs ...string) error {
	encoded, err := json.Marshal([]map[string]any{{"event_type": "replan/cancel-requested", "payload": map[string]any{
		"failed_vertex_id": failedVertex, "scope_ids": scopeIDs, "level": "L1", "reason": "integration test", "candidates": []any{},
	}}})
	if err != nil {
		return err
	}
	_, err = engine.Exec(ctx, `SELECT run_seq FROM append_events($1, $2::jsonb)`, runID, encoded)
	return err
}

func scopeFenced(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, scopeID string) bool {
	t.Helper()
	var fenced bool
	if err := engine.QueryRow(ctx, `SELECT fenced_at IS NOT NULL FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&fenced); err != nil {
		t.Fatal(err)
	}
	return fenced
}

func requestOutcome(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, scopeID string) string {
	t.Helper()
	var outcome *string
	if err := engine.QueryRow(ctx, `SELECT cancel_request_outcome FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&outcome); err != nil {
		t.Fatal(err)
	}
	if outcome == nil {
		return ""
	}
	return *outcome
}

func countQueued(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, vertexID string) int {
	t.Helper()
	var count int
	if err := engine.QueryRow(ctx, `SELECT count(*) FROM work_queue WHERE run_id = $1 AND vertex_id = $2`, runID, vertexID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func countEvents(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, eventType string) int {
	t.Helper()
	var count int
	if err := engine.QueryRow(ctx, `SELECT count(*) FROM run_event_log WHERE run_id = $1 AND event_type = $2`, runID, eventType).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func countUnresolvedAttempts(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, scopeID string) int {
	t.Helper()
	var count int
	if err := engine.QueryRow(ctx, `SELECT count(*) FROM txn_attempt WHERE run_id = $1 AND scope_id = $2 AND outcome IS NULL`, runID, scopeID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func barrierFixture(integrationScope, firstTry, secondTry, pivotVertex string) []map[string]any {
	events := tryFixture(integrationScope, firstTry, secondTry, 60)
	retry := map[string]any{"max_attempts": 2, "initial_backoff_ms": 0, "multiplier": 2, "max_backoff_ms": 0}
	return append(events, map[string]any{"event_type": "vertex/created", "vertex_id": pivotVertex, "parent_refs": []string{firstTry, secondTry}, "scope_id": integrationScope, "payload": map[string]any{"role": "tool", "tool": "payment.capture", "input": map[string]any{"order_id": "ORDER-1"}, "retry_policy": retry, "txn": map[string]any{"effect_class": "irreversible", "mode": "plain", "idempotency_key": integrationScope + ":capture", "status_tool": "payment.status"}}})
}

func tryFixture(integrationScope, firstTry, secondTry string, tryTimeoutSeconds int) []map[string]any {
	retry := map[string]any{"max_attempts": 2, "initial_backoff_ms": 0, "multiplier": 2, "max_backoff_ms": 0}
	return []map[string]any{
		{"event_type": "run/start", "payload": map[string]any{"schema_version": "v1"}},
		{"event_type": "vertex/created", "vertex_id": firstTry, "scope_id": integrationScope, "payload": map[string]any{"role": "tool", "tool": "inventory.reserve.a", "input": map[string]any{"sku": "SKU-1"}, "retry_policy": retry, "txn": map[string]any{"effect_class": "reversible", "mode": "tcc", "idempotency_key": integrationScope + ":reserve-a", "try_timeout_s": tryTimeoutSeconds, "confirm_tool": "inventory.confirm.a", "cancel_tool": "inventory.release.a"}}},
		{"event_type": "vertex/created", "vertex_id": secondTry, "scope_id": integrationScope, "payload": map[string]any{"role": "tool", "tool": "inventory.reserve.b", "input": map[string]any{"sku": "SKU-1"}, "retry_policy": retry, "txn": map[string]any{"effect_class": "reversible", "mode": "tcc", "idempotency_key": integrationScope + ":reserve-b", "try_timeout_s": tryTimeoutSeconds, "confirm_tool": "inventory.confirm.b", "cancel_tool": "inventory.release.b"}}},
	}
}

func assertScopeState(t *testing.T, ctx context.Context, engine *pgxpool.Pool, runID, scopeID, expected string) {
	t.Helper()
	var state string
	if err := engine.QueryRow(ctx, `SELECT state FROM txn_scope WHERE run_id = $1 AND scope_id = $2`, runID, scopeID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != expected {
		t.Fatalf("scope state=%s, want %s", state, expected)
	}
}

func scenarioIDs(t *testing.T) (string, string, string, string, string) {
	t.Helper()
	var prefix [4]byte
	if _, err := rand.Read(prefix[:]); err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("%x", prefix)
	return base + "-0000-4000-8000-000000000999", base + "-0000-4000-8000-000000000900", base + "-0000-4000-8000-000000000901",
		base + "-0000-4000-8000-000000000902", base + "-0000-4000-8000-000000000903"
}

func openPool(t *testing.T, ctx context.Context, connectionString string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(ctx, connectionString)
	if err != nil {
		t.Fatal(err)
	}
	return pool
}

func appendEngineEvents(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID string, events []map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT run_seq FROM append_events($1, $2::jsonb)`, runID, encoded); err != nil {
		t.Fatal(err)
	}
}

// The integration tests get a database of their own, exactly as the TypeScript suites do
// (test/setup/database.ts provisions and migrates it on every `npm test`). They used to default to
// the development database, where a Coordinator left running in another terminal claims the work a
// test enqueues, and where one failed run's leftovers are the next run's first claims.
func engineURL() string {
	return environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory_test")
}

func coordinatorURL() string {
	return environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory_test")
}

func environmentForTest(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
