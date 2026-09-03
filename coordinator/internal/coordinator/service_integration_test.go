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
	calls    []string
}

func (adapter *recordingAdapter) Execute(_ context.Context, request model.OperationRequest) (model.OperationResponse, error) {
	adapter.calls = append(adapter.calls, request.Tool)
	if outcome, found := adapter.outcomes[request.Tool]; found {
		return model.OperationResponse{Outcome: outcome, Error: "injected " + string(outcome)}, nil
	}
	return model.OperationResponse{Outcome: model.OutcomeSucceeded, Result: map[string]any{"tool": request.Tool}}, nil
}

func TestRuntimeBarrierAndPostPivotConfirm(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
	if err := engine.QueryRow(ctx, `SELECT min(stream_seq) FILTER (WHERE event_type = 'txn/pivot-passed'), min(stream_seq) FILTER (WHERE event_type = 'txn/confirm')
        FROM event_log WHERE run_id = $1`, runID).Scan(&pivotSeq, &earliestConfirm); err != nil {
		t.Fatal(err)
	}
	if earliestConfirm <= pivotSeq {
		t.Fatalf("confirm seq %d must follow pivot seq %d", earliestConfirm, pivotSeq)
	}
}

func TestTryFailureCancelsWholeScope(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
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
        FROM event_log WHERE run_id = $1`, runID).Scan(&cancelEvents, &pivotEvents); err != nil {
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
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
	if err := engine.QueryRow(ctx, `SELECT count(*) FROM event_log WHERE run_id = $1 AND event_type = 'txn/scope' AND payload->>'state' = 'committed'`, runID).Scan(&committedEvents); err != nil {
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
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
        FROM event_log WHERE run_id = $1`, runID).Scan(&cancelEvents, &pivotEvents); err != nil {
		t.Fatal(err)
	}
	if state != "suspended" || cancelEvents != 0 || pivotEvents != 0 {
		t.Fatalf("state=%s cancel_events=%d pivot_events=%d", state, cancelEvents, pivotEvents)
	}
}

func TestScopeCancelResumesAfterCompletedMember(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
	if err := database.RequestScopeCancel(ctx, runID, scopeID, key, "recovery test"); err != nil {
		t.Fatal(err)
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
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
	engine := openPool(t, ctx, environmentForTest("ENGINE_DATABASE_URL", "postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory"))
	defer engine.Close()
	database, err := store.Open(ctx, environmentForTest("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory"))
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
	if err := database.RequestScopeCancel(ctx, runID, scopeID, key, "sweeper takeover test"); err != nil {
		t.Fatal(err)
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
	if _, err := pool.Exec(ctx, `SELECT stream_seq FROM append_events($1, $2::jsonb)`, runID, encoded); err != nil {
		t.Fatal(err)
	}
}

func environmentForTest(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
