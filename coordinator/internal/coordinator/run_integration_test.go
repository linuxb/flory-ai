package coordinator

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/linuxb/flory-ai/coordinator/internal/model"
	"github.com/linuxb/flory-ai/coordinator/internal/store"
)

// transportFailure answers every call the way a dropped connection does: with no outcome at all.
type transportFailure struct{ calls int }

func (adapter *transportFailure) Execute(context.Context, model.OperationRequest) (model.OperationResponse, error) {
	adapter.calls++
	return model.OperationResponse{}, errors.New("connection reset by peer")
}

// retryingOnce reports a retryable failure, so the next attempt waits out its backoff first.
type retryingOnce struct{ calls int }

func (adapter *retryingOnce) Execute(context.Context, model.OperationRequest) (model.OperationResponse, error) {
	adapter.calls++
	return model.OperationResponse{Outcome: model.OutcomeRetryableFailure, Error: "try again"}, nil
}

// releaseQueuedWork removes a scenario's rows from the global queue once it is done, so a row it
// deliberately left leased can never become the next scenario's first claim.
func releaseQueuedWork(t *testing.T, runID string) {
	t.Cleanup(func() {
		owner := openPool(t, context.Background(), ownerURL(t))
		defer owner.Close()
		if _, err := owner.Exec(context.Background(), `DELETE FROM work_queue WHERE run_id = $1`, runID); err != nil {
			t.Error(err)
		}
	})
}

// A transport error says nothing about whether the tool ran. The attempt is therefore neither a
// success nor a failure: no bracket is sealed, nothing is recorded as failed, and the evidence row
// stays unresolved, which is what later makes the scope suspend instead of releasing reservations
// a tool may in fact have taken.
func TestATransportErrorLeavesTheAttemptUnresolved(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	releaseQueuedWork(t, runID)
	appendEngineEvents(t, ctx, engine, runID, tryFixture(scopeID, first, second, 60)[:2])
	adapter := &transportFailure{}
	service := New(database, adapter, Config{WorkerID: "transport-worker", LeaseDuration: time.Hour, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	if err := service.ProcessOne(ctx); err == nil || !strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("ProcessOne returned %v, want the transport error", err)
	}
	// One request, never repeated: a retry of a call that may have landed is a second effect.
	if adapter.calls != 1 {
		t.Fatalf("calls=%d, want 1", adapter.calls)
	}
	for _, eventType := range []string{"txn/try", "vertex/succeeded", "vertex/failed"} {
		if count := countEvents(t, ctx, engine, runID, eventType); count != 0 {
			t.Fatalf("%d %s events for an attempt with no answer", count, eventType)
		}
	}
	if unresolved := countUnresolvedAttempts(t, ctx, engine, runID, scopeID); unresolved != 1 {
		t.Fatalf("unresolved attempts=%d, want 1", unresolved)
	}
	// The row stays leased to this worker rather than being completed or handed straight back.
	if queued := countQueued(t, ctx, engine, runID, first); queued != 1 {
		t.Fatalf("queued rows=%d, want the one leased row", queued)
	}
}

// Stopping while an attempt waits out its backoff stops before the next request is sent.
func TestCancellationDuringBackoffSendsNoFurtherAttempt(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	ctx := context.Background()
	engine, database := openIntegration(t, ctx)
	runID, scopeID, first, second, _ := scenarioIDs(t)
	if _, err := engine.Exec(ctx, `SELECT create_run($1)`, runID); err != nil {
		t.Fatal(err)
	}
	releaseQueuedWork(t, runID)
	events := tryFixture(scopeID, first, second, 60)[:2]
	events[1]["payload"].(map[string]any)["retry_policy"] = map[string]any{"max_attempts": 2, "initial_backoff_ms": 60000, "multiplier": 2, "max_backoff_ms": 60000}
	appendEngineEvents(t, ctx, engine, runID, events)
	adapter := &retryingOnce{}
	service := New(database, adapter, Config{WorkerID: "backoff-worker", LeaseDuration: time.Hour, PollInterval: time.Millisecond, SweepInterval: time.Minute}, slog.Default())
	stopping, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	started := time.Now()
	if err := service.ProcessOne(stopping); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ProcessOne returned %v, want the context's deadline", err)
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("the backoff was waited out in full: %s", elapsed)
	}
	if adapter.calls != 1 {
		t.Fatalf("calls=%d, want only the first attempt", adapter.calls)
	}
	// The retry was announced before the wait began, and nothing after it was.
	if retried := countEvents(t, ctx, engine, runID, "vertex/retried"); retried != 1 {
		t.Fatalf("vertex/retried events=%d, want 1", retried)
	}
	if failed := countEvents(t, ctx, engine, runID, "vertex/failed"); failed != 0 {
		t.Fatalf("an interrupted retry was recorded as failed: %d", failed)
	}
}

// Run keeps serving through failures -- each is logged and the loop goes on -- and returns only
// when its context ends. A store whose pool is already closed makes every pass fail.
func TestRunLogsEachFailedPassAndStopsWithItsContext(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1 to run PostgreSQL Coordinator integration tests")
	}
	database, err := store.Open(context.Background(), coordinatorURL())
	if err != nil {
		t.Fatal(err)
	}
	database.Close()
	var logged bytes.Buffer
	service := New(database, &recordingAdapter{}, Config{WorkerID: "run-loop-worker", LeaseDuration: time.Minute, PollInterval: time.Millisecond, SweepInterval: time.Millisecond},
		slog.New(slog.NewTextHandler(&logged, nil)))
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := service.Run(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run returned %v, want the context's deadline", err)
	}
	for _, message := range []string{"work processing failed", "orphan sweep failed"} {
		if !strings.Contains(logged.String(), message) {
			t.Fatalf("no %q in the log:\n%s", message, logged.String())
		}
	}
}

func TestNewFallsBackToTheDefaultLogger(t *testing.T) {
	if service := New(nil, &recordingAdapter{}, Config{}, nil); service.logger == nil {
		t.Fatal("a service was built without a logger")
	}
}
