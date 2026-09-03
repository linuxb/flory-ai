DROP INDEX IF EXISTS txn_bracket_open_idx;
CREATE INDEX txn_bracket_sealed_deadline_idx ON txn_bracket (deadline_at, run_id, scope_id) WHERE state = 'sealed';

CREATE INDEX txn_scope_cancelling_idx ON txn_scope (run_id, scope_id) WHERE state = 'cancelling';
CREATE INDEX scope_cancel_member_live_lease_idx ON scope_cancel_member (run_id, scope_id, lease_until)
    WHERE NOT completed;
