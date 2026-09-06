// Package rbac owns gatewayd's business-role catalogue and subject bindings.
package rbac

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Subject is the current Gateway-owned authorization state for an OIDC identity.
type Subject struct {
	Issuer   string   `json:"issuer"`
	Subject  string   `json:"subject"`
	Roles    []string `json:"roles"`
	Enabled  bool     `json:"enabled"`
	Revision int64    `json:"revision"`
}

// Role is one business role administrators may bind to subjects and tools.
type Role struct {
	RoleID      string `json:"role_id"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Revision    int64  `json:"revision"`
}

// Mutation identifies one idempotent, audited administrative write.
type Mutation struct {
	ActorSPIFFEID    string
	RequestID        string
	IdempotencyKey   string
	ExpectedRevision int64
}

// Store is the PostgreSQL-backed RBAC authority. It has no event-log write API.
type Store struct{ pool *pgxpool.Pool }

// Open connects to the Gateway-owned RBAC projection.
func Open(ctx context.Context, connectionString string) (*Store, error) {
	pool, err := pgxpool.New(ctx, connectionString)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

// Close releases database connections.
func (store *Store) Close() { store.pool.Close() }

// Subject resolves live roles. Disabled or unknown identities deliberately return no roles.
func (store *Store) Subject(ctx context.Context, issuer, subject string) (Subject, error) {
	result := Subject{Issuer: issuer, Subject: subject, Roles: []string{}}
	err := store.pool.QueryRow(ctx, `SELECT enabled, revision FROM gateway_rbac_subject WHERE issuer=$1 AND subject=$2`, issuer, subject).Scan(&result.Enabled, &result.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return Subject{}, err
	}
	if !result.Enabled {
		return result, nil
	}
	rows, err := store.pool.Query(ctx, `SELECT sr.role_id FROM gateway_rbac_subject_role sr JOIN gateway_rbac_role r USING(role_id)
		WHERE sr.issuer=$1 AND sr.subject=$2 AND sr.revoked_at IS NULL AND r.enabled ORDER BY sr.role_id`, issuer, subject)
	if err != nil {
		return Subject{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return Subject{}, err
		}
		result.Roles = append(result.Roles, role)
	}
	return result, rows.Err()
}

// RoleEnabled reports whether a registry declaration names a current role.
func (store *Store) RoleEnabled(ctx context.Context, role string) (bool, error) {
	if role == "*" {
		return true, nil
	}
	var enabled bool
	err := store.pool.QueryRow(ctx, `SELECT enabled FROM gateway_rbac_role WHERE role_id=$1`, role).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return enabled, err
}

// PutRole creates or replaces one role through the audited CAS function.
func (store *Store) PutRole(ctx context.Context, mutation Mutation, role Role) (Role, error) {
	var raw []byte
	err := store.pool.QueryRow(ctx, `SELECT gateway_rbac_put_role($1,$2,$3,$4,$5,$6,$7)`, mutation.ActorSPIFFEID, mutation.RequestID,
		mutation.IdempotencyKey, role.RoleID, role.Description, role.Enabled, mutation.ExpectedRevision).Scan(&raw)
	if err != nil {
		return Role{}, err
	}
	var result Role
	if err := json.Unmarshal(raw, &result); err != nil {
		return Role{}, fmt.Errorf("decode role mutation: %w", err)
	}
	return result, nil
}

// ReplaceSubjectRoles atomically replaces a subject's complete binding set.
func (store *Store) ReplaceSubjectRoles(ctx context.Context, mutation Mutation, subject Subject) (Subject, error) {
	var raw []byte
	err := store.pool.QueryRow(ctx, `SELECT gateway_rbac_replace_subject_roles($1,$2,$3,$4,$5,$6,$7,$8)`, mutation.ActorSPIFFEID,
		mutation.RequestID, mutation.IdempotencyKey, subject.Issuer, subject.Subject, subject.Roles, subject.Enabled, mutation.ExpectedRevision).Scan(&raw)
	if err != nil {
		return Subject{}, err
	}
	var result Subject
	if err := json.Unmarshal(raw, &result); err != nil {
		return Subject{}, fmt.Errorf("decode subject mutation: %w", err)
	}
	return result, nil
}

// Audit returns the immutable audit rows for one subject.
func (store *Store) Audit(ctx context.Context, issuer, subject string) ([]json.RawMessage, error) {
	rows, err := store.pool.Query(ctx, `SELECT jsonb_build_object('audit_id',audit_id,'idempotency_key',idempotency_key,'request_id',request_id,
		'actor_spiffe_id',actor_spiffe_id,'operation',operation,'target',target,'before_revision',before_revision,
		'after_revision',after_revision,'created_at',created_at) FROM gateway_rbac_audit
		WHERE target->>'issuer'=$1 AND target->>'subject'=$2 ORDER BY audit_id`, issuer, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []json.RawMessage{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		result = append(result, raw)
	}
	return result, rows.Err()
}
