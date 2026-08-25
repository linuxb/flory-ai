-- Carry the frozen tool-view digest through the bracket projection.
--
-- A companion call -- confirm, cancel, compensate -- must resolve inside the same
-- frozen view as the try it reverses. Registration admission already guarantees a
-- companion exists in that view, so the digest is all an executor has to carry:
-- the companion resolves by name, and no separate version has to be threaded for
-- it through the projection.
--
-- Additive and nullable, so brackets recorded before this migration stay valid.
-- An executor reads a null digest as the direct-adapter path.

ALTER TABLE txn_bracket ADD COLUMN IF NOT EXISTS tool_view_digest TEXT;
ALTER TABLE scope_cancel_member ADD COLUMN IF NOT EXISTS tool_view_digest TEXT;

-- The projection and the cancellation claim are replaced whole rather than
-- patched, so the current definition reads as one piece instead of as migration
-- 004 plus a diff a reader has to apply in their head.

CREATE OR REPLACE FUNCTION apply_txn_projection() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE bracket_key TEXT; cancel_phase TEXT;
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type = 'txn/scope' THEN
        INSERT INTO txn_scope (scope_id, run_id, state, savepoint_seq, opened_seq, member_vertices, required_try_vertices, updated_at)
        VALUES (NEW.scope_id, NEW.run_id, COALESCE(NEW.payload->>'state', 'open'), NULLIF(NEW.payload->>'savepoint_seq', '')::BIGINT,
                NEW.stream_seq, COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.payload->'member_vertices', '[]'::JSONB))::UUID), '{}'),
                COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.payload->'required_try_vertices', '[]'::JSONB))::UUID), '{}'), now())
        ON CONFLICT (scope_id) DO UPDATE SET state = EXCLUDED.state, closed_seq = CASE WHEN EXCLUDED.state IN ('committed', 'cancelled', 'suspended') THEN NEW.stream_seq ELSE txn_scope.closed_seq END,
            updated_at = now();
    ELSIF NEW.event_type = 'txn/try' THEN
        bracket_key := NEW.payload->>'idempotency_key';
        INSERT INTO txn_bracket (idempotency_key, run_id, scope_id, state, deadline_at, try_vertex_id, try_seq, confirm_tool, cancel_tool, compensate_tool, input, retry_policy, tool_view_digest)
        VALUES (bracket_key, NEW.run_id, NEW.scope_id, 'sealed', (NEW.payload->>'deadline_at')::TIMESTAMPTZ, NEW.vertex_id, NEW.stream_seq,
                NEW.payload->>'confirm_tool', NEW.payload->>'cancel_tool', NEW.payload->>'compensate_tool', COALESCE(NEW.payload->'input', '{}'::JSONB),
                COALESCE(NEW.payload->'retry_policy', '{"max_attempts":1,"initial_backoff_ms":0,"multiplier":1,"max_backoff_ms":0}'::JSONB),
                NULLIF(NEW.payload->>'tool_view_digest', ''));
    ELSIF NEW.event_type = 'txn/pivot-passed' THEN
        UPDATE txn_scope SET state = 'pivot-passed', is_pivot = true, pivot_vertex_id = NEW.vertex_id, updated_at = now()
        WHERE scope_id = NEW.scope_id AND run_id = NEW.run_id AND state = 'pivot-inflight' AND pivot_vertex_id = NEW.vertex_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'pivot requires an admitted pivot-inflight scope %', NEW.scope_id; END IF;
    ELSIF NEW.event_type = 'txn/confirm' THEN
        bracket_key := NEW.payload->>'idempotency_key';
        UPDATE txn_bracket SET state = 'confirmed' WHERE idempotency_key = bracket_key AND run_id = NEW.run_id AND scope_id = NEW.scope_id AND state = 'sealed';
        IF NOT FOUND THEN RAISE EXCEPTION 'txn/confirm requires a sealed matching txn/try'; END IF;
    ELSIF NEW.event_type = 'txn/cancel' THEN
        cancel_phase := NEW.payload->>'phase';
        IF cancel_phase = 'requested' THEN
            UPDATE txn_scope SET state = 'cancelling', cancel_idempotency_key = NEW.payload->>'idempotency_key', updated_at = now()
            WHERE scope_id = NEW.scope_id AND run_id = NEW.run_id AND state = 'open';
            IF NOT FOUND THEN RAISE EXCEPTION 'scope cancel requires an open scope %', NEW.scope_id; END IF;
            INSERT INTO scope_cancel_member (run_id, scope_id, vertex_id, idempotency_key, inverse_tool, input, retry_policy, try_seq, dependency_depth, tool_view_digest)
            WITH RECURSIVE members AS (
                SELECT b.try_vertex_id AS vertex_id, b.idempotency_key, COALESCE(b.cancel_tool, b.compensate_tool) AS inverse_tool,
                       b.input, b.retry_policy, b.try_seq, b.tool_view_digest
                FROM txn_bracket b WHERE b.run_id = NEW.run_id AND b.scope_id = NEW.scope_id AND b.state = 'sealed'
                  AND COALESCE(b.cancel_tool, b.compensate_tool) IS NOT NULL
            ), paths(vertex_id, depth) AS (
                SELECT vertex_id, 0 FROM members
                UNION ALL
                SELECT child.vertex_id, paths.depth + 1 FROM paths
                JOIN event_log child ON child.run_id = NEW.run_id AND child.event_type = 'vertex/created' AND paths.vertex_id = ANY(child.parent_refs)
                JOIN members member_child ON member_child.vertex_id = child.vertex_id
            )
            SELECT NEW.run_id, NEW.scope_id, m.vertex_id, m.idempotency_key, m.inverse_tool, m.input, m.retry_policy, m.try_seq, max(paths.depth), m.tool_view_digest
            FROM members m JOIN paths ON paths.vertex_id = m.vertex_id
            GROUP BY m.vertex_id, m.idempotency_key, m.inverse_tool, m.input, m.retry_policy, m.try_seq, m.tool_view_digest
            ON CONFLICT DO NOTHING;
        ELSIF cancel_phase = 'completed' THEN
            IF EXISTS (SELECT 1 FROM scope_cancel_member WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND NOT completed) THEN
                RAISE EXCEPTION 'scope % still has incomplete cancel members', NEW.scope_id;
            END IF;
            UPDATE txn_scope SET state = 'cancelled', closed_seq = NEW.stream_seq, updated_at = now()
            WHERE scope_id = NEW.scope_id AND run_id = NEW.run_id AND state = 'cancelling' AND cancel_idempotency_key = NEW.payload->>'idempotency_key';
            IF NOT FOUND THEN RAISE EXCEPTION 'scope cancel completion requires matching cancelling scope %', NEW.scope_id; END IF;
            UPDATE txn_bracket SET state = 'cancelled' WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND state = 'sealed';
        ELSE
            RAISE EXCEPTION 'unknown txn/cancel phase %', cancel_phase;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- PostgreSQL cannot widen a function's result row in place, so this one is
-- dropped and recreated rather than replaced.
DROP FUNCTION IF EXISTS claim_cancel_member(TEXT, UUID, UUID, INTEGER);

CREATE OR REPLACE FUNCTION claim_cancel_member(p_worker TEXT, p_run_id UUID, p_scope_id UUID, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, idempotency_key TEXT, inverse_tool TEXT, input JSONB, retry_policy JSONB, tool_view_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may claim cancellation'; END IF;
    RETURN QUERY WITH candidate AS (
        SELECT m.vertex_id FROM scope_cancel_member m WHERE m.run_id = p_run_id AND m.scope_id = p_scope_id AND NOT m.completed
          AND (m.lease_until IS NULL OR m.lease_until < now()) ORDER BY m.dependency_depth DESC, m.vertex_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE scope_cancel_member m SET claimed_by = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds)
      FROM candidate c WHERE m.run_id = p_run_id AND m.scope_id = p_scope_id AND m.vertex_id = c.vertex_id
      RETURNING m.vertex_id, m.idempotency_key, m.inverse_tool, m.input, m.retry_policy, m.tool_view_digest;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_cancel_member(TEXT, UUID, UUID, INTEGER) TO coordinator_role;
