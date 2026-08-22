// Package store contains the Coordinator's PostgreSQL operational store.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/linuxb/flory-ai/coordinator/internal/eventlog/generated"
	"github.com/linuxb/flory-ai/coordinator/internal/model"
)

// PostgresStore accesses only Coordinator-owned events and operational projections.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// Open connects to PostgreSQL and verifies the connection.
func Open(ctx context.Context, connectionString string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, connectionString)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &PostgresStore{pool: pool}, nil
}

// Close releases the connection pool.
func (store *PostgresStore) Close() {
	store.pool.Close()
}

// ClaimWork leases one dependency-ready vertex.
func (store *PostgresStore) ClaimWork(ctx context.Context, worker string, lease time.Duration) (*model.WorkItem, error) {
	var item model.WorkItem
	var raw []byte
	seconds := max(1, int(lease/time.Second))
	err := store.pool.QueryRow(ctx, `SELECT vertex_id, run_id, COALESCE(scope_id::text, ''), parent_refs, payload, attempt FROM claim_ready_work($1, $2)`, worker, seconds).
		Scan(&item.VertexID, &item.RunID, &item.ScopeID, &item.ParentRefs, &raw, &item.Attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	payload, role, err := model.DecodeWorkPayload(raw)
	if err != nil {
		return nil, fmt.Errorf("decode work %s: %w", item.VertexID, err)
	}
	item.Payload = payload
	item.Role = role
	return &item, nil
}

// CompleteWork removes a successfully handled operational queue row.
func (store *PostgresStore) CompleteWork(ctx context.Context, worker, vertexID string) error {
	_, err := store.pool.Exec(ctx, `SELECT complete_work($1, $2)`, worker, vertexID)
	return err
}

// ReleaseWork makes a leased row available after the supplied deterministic delay.
func (store *PostgresStore) ReleaseWork(ctx context.Context, worker, vertexID string, delay time.Duration) error {
	_, err := store.pool.Exec(ctx, `SELECT release_work($1, $2, $3)`, worker, vertexID, delay.Milliseconds())
	return err
}

// Append appends one or more Coordinator-owned events.
func (store *PostgresStore) Append(ctx context.Context, runID string, events ...model.EventDraft) error {
	encoded, err := json.Marshal(events)
	if err != nil {
		return err
	}
	_, err = store.pool.Exec(ctx, `SELECT stream_seq FROM append_events($1, $2::jsonb)`, runID, encoded)
	return err
}

// EnsureScope creates the operational scope once, deriving members from frozen vertices.
func (store *PostgresStore) EnsureScope(ctx context.Context, runID, scopeID string) error {
	if scopeID == "" {
		return nil
	}
	_, err := store.pool.Exec(ctx, `SELECT ensure_txn_scope($1, $2)`, runID, scopeID)
	return err
}

// AdmitPivot atomically fences an open scope when all required tries are sealed.
func (store *PostgresStore) AdmitPivot(ctx context.Context, runID, scopeID, vertexID string) (bool, error) {
	var admitted bool
	err := store.pool.QueryRow(ctx, `SELECT admit_pivot($1, $2, $3)`, runID, scopeID, vertexID).Scan(&admitted)
	return admitted, err
}

// ResolvePivotAbsent removes the inflight fence after the status query proves that no irreversible effect occurred.
func (store *PostgresStore) ResolvePivotAbsent(ctx context.Context, runID, scopeID, vertexID string) error {
	_, err := store.pool.Exec(ctx, `SELECT resolve_pivot_absent($1, $2, $3)`, runID, scopeID, vertexID)
	return err
}

// RequestScopeCancel atomically fences a pre-pivot scope and materializes inverse work.
func (store *PostgresStore) RequestScopeCancel(ctx context.Context, runID, scopeID, key, reason string) error {
	_, err := store.pool.Exec(ctx, `SELECT request_scope_cancel($1, $2, $3, $4)`, runID, scopeID, key, reason)
	return err
}

// CancelMember is one inverse operation claimed as part of a scope cancellation.
type CancelMember struct {
	VertexID       string
	IdempotencyKey string
	InverseTool    string
	Input          map[string]any
	RetryPolicy    generated.RetryPolicy
}

// ClaimCancelMember claims the next inverse operation in reverse event order.
func (store *PostgresStore) ClaimCancelMember(ctx context.Context, worker, runID, scopeID string, lease time.Duration) (*CancelMember, error) {
	var member CancelMember
	var raw []byte
	var policyRaw []byte
	err := store.pool.QueryRow(ctx, `SELECT vertex_id, idempotency_key, inverse_tool, input, retry_policy FROM claim_cancel_member($1, $2, $3, $4)`,
		worker, runID, scopeID, max(1, int(lease/time.Second))).Scan(&member.VertexID, &member.IdempotencyKey, &member.InverseTool, &raw, &policyRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &member.Input); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(policyRaw, &member.RetryPolicy); err != nil {
		return nil, err
	}
	return &member, nil
}

// CompleteCancelMember records operational progress for a successfully reversed member.
func (store *PostgresStore) CompleteCancelMember(ctx context.Context, worker, runID, scopeID, vertexID string) error {
	_, err := store.pool.Exec(ctx, `SELECT complete_cancel_member($1, $2, $3, $4)`, worker, runID, scopeID, vertexID)
	return err
}

// CompleteScopeCancel appends the terminal scope cancellation after every inverse succeeds.
func (store *PostgresStore) CompleteScopeCancel(ctx context.Context, runID, scopeID, key string) error {
	payload := map[string]any{"idempotency_key": key, "phase": "completed"}
	return store.Append(ctx, runID, model.EventDraft{EventType: "txn/cancel", ScopeID: stringPointer(scopeID), Payload: payload})
}

// SealedBracket identifies post-pivot confirm work.
type SealedBracket struct {
	VertexID       string
	IdempotencyKey string
	ConfirmTool    string
	Input          map[string]any
	RetryPolicy    generated.RetryPolicy
}

// SealedBrackets returns the remaining confirm operations in stable order.
func (store *PostgresStore) SealedBrackets(ctx context.Context, runID, scopeID string) ([]SealedBracket, error) {
	rows, err := store.pool.Query(ctx, `SELECT try_vertex_id, idempotency_key, confirm_tool, input, retry_policy FROM txn_bracket
        WHERE run_id = $1 AND scope_id = $2 AND state = 'sealed' AND confirm_tool IS NOT NULL ORDER BY try_vertex_id`, runID, scopeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []SealedBracket{}
	for rows.Next() {
		var bracket SealedBracket
		var raw []byte
		var policyRaw []byte
		if err := rows.Scan(&bracket.VertexID, &bracket.IdempotencyKey, &bracket.ConfirmTool, &raw, &policyRaw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &bracket.Input); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(policyRaw, &bracket.RetryPolicy); err != nil {
			return nil, err
		}
		result = append(result, bracket)
	}
	return result, rows.Err()
}

// ExpiredScopes returns open scopes containing a sealed bracket past its deadline.
func (store *PostgresStore) ExpiredScopes(ctx context.Context) (map[string][]string, error) {
	rows, err := store.pool.Query(ctx, `SELECT DISTINCT b.run_id, b.scope_id FROM txn_bracket b JOIN txn_scope s ON s.scope_id = b.scope_id
        WHERE b.state = 'sealed' AND b.deadline_at < now() AND s.state = 'open'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string][]string{}
	for rows.Next() {
		var runID, scopeID string
		if err := rows.Scan(&runID, &scopeID); err != nil {
			return nil, err
		}
		result[runID] = append(result[runID], scopeID)
	}
	return result, rows.Err()
}

func stringPointer(value string) *string {
	return &value
}
