package rbac

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
)

func integrationID(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw)
}

func TestPostgresRBACRoleBindingRevocationAndAudit(t *testing.T) {
	if os.Getenv("FLORY_INTEGRATION") != "1" {
		t.Skip("set FLORY_INTEGRATION=1")
	}
	ctx := context.Background()
	store, err := Open(ctx, environment("GATEWAYD_DATABASE_URL", "postgresql://gateway_role:gateway-dev-password@127.0.0.1:5432/flory"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	id := integrationID(t)
	actor := "spiffe://flory.local/rbac-admin"
	role, err := store.PutRole(ctx, Mutation{ActorSPIFFEID: actor, RequestID: "role-" + id, IdempotencyKey: "role-" + id, ExpectedRevision: 0},
		Role{RoleID: "test-" + id, Description: "integration role", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if role.Revision != 1 {
		t.Fatalf("role revision=%d", role.Revision)
	}
	replayed, err := store.PutRole(ctx, Mutation{ActorSPIFFEID: actor, RequestID: "role-" + id, IdempotencyKey: "role-" + id, ExpectedRevision: 0},
		Role{RoleID: role.RoleID, Description: "ignored replay body", Enabled: false})
	if err != nil || replayed != role {
		t.Fatalf("idempotent replay=%+v err=%v", replayed, err)
	}
	if _, err := store.PutRole(ctx, Mutation{ActorSPIFFEID: actor, RequestID: "conflict-" + id, IdempotencyKey: "conflict-" + id, ExpectedRevision: 0},
		Role{RoleID: role.RoleID, Description: "stale write", Enabled: false}); err == nil {
		t.Fatal("stale role revision was accepted")
	}
	subject := Subject{Issuer: "https://issuer.example/" + id, Subject: "alice", Roles: []string{role.RoleID}, Enabled: true}
	bound, err := store.ReplaceSubjectRoles(ctx, Mutation{ActorSPIFFEID: actor, RequestID: "bind-" + id, IdempotencyKey: "bind-" + id, ExpectedRevision: 0}, subject)
	if err != nil {
		t.Fatal(err)
	}
	if len(bound.Roles) != 1 || bound.Roles[0] != role.RoleID {
		t.Fatalf("bound roles=%v", bound.Roles)
	}
	current, err := store.Subject(ctx, subject.Issuer, subject.Subject)
	if err != nil || len(current.Roles) != 1 {
		t.Fatalf("current=%+v err=%v", current, err)
	}
	otherIssuer, err := store.Subject(ctx, "https://other-issuer.example/"+id, subject.Subject)
	if err != nil || len(otherIssuer.Roles) != 0 {
		t.Fatalf("roles leaked between issuers: %+v err=%v", otherIssuer, err)
	}
	badKey := "invalid-binding-" + id
	_, err = store.ReplaceSubjectRoles(ctx, Mutation{ActorSPIFFEID: actor, RequestID: badKey, IdempotencyKey: badKey, ExpectedRevision: 1},
		Subject{Issuer: subject.Issuer, Subject: subject.Subject, Roles: []string{"*"}, Enabled: true})
	if err == nil {
		t.Fatal("reserved public role was bound to a subject")
	}
	var invalidAudit int
	if err := store.pool.QueryRow(ctx, `SELECT count(*) FROM gateway_rbac_audit WHERE idempotency_key=$1`, badKey).Scan(&invalidAudit); err != nil || invalidAudit != 0 {
		t.Fatalf("failed mutation was audited separately from its rollback: count=%d err=%v", invalidAudit, err)
	}
	_, err = store.ReplaceSubjectRoles(ctx, Mutation{ActorSPIFFEID: actor, RequestID: "revoke-" + id, IdempotencyKey: "revoke-" + id, ExpectedRevision: 1},
		Subject{Issuer: subject.Issuer, Subject: subject.Subject, Roles: []string{}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	current, err = store.Subject(ctx, subject.Issuer, subject.Subject)
	if err != nil || len(current.Roles) != 0 || current.Revision != 2 {
		t.Fatalf("revoked=%+v err=%v", current, err)
	}
	var revoked bool
	if err := store.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM gateway_rbac_subject_role WHERE issuer=$1 AND subject=$2 AND role_id=$3`,
		subject.Issuer, subject.Subject, role.RoleID).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("binding history not revoked: revoked=%v err=%v", revoked, err)
	}
	audit, err := store.Audit(ctx, subject.Issuer, subject.Subject)
	if err != nil || len(audit) != 2 {
		t.Fatalf("audit entries=%d err=%v", len(audit), err)
	}
}

func environment(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
