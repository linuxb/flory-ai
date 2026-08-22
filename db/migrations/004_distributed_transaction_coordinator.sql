ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS member_vertices UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS required_try_vertices UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS cancel_idempotency_key TEXT;
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE txn_bracket ADD COLUMN IF NOT EXISTS confirm_tool TEXT;
ALTER TABLE txn_bracket ADD COLUMN IF NOT EXISTS cancel_tool TEXT;
ALTER TABLE txn_bracket ADD COLUMN IF NOT EXISTS compensate_tool TEXT;
ALTER TABLE txn_bracket ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT '{}';
ALTER TABLE txn_bracket ADD COLUMN IF NOT EXISTS retry_policy JSONB NOT NULL DEFAULT '{"max_attempts":1,"initial_backoff_ms":0,"multiplier":1,"max_backoff_ms":0}';

ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS parent_refs UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS scope_id UUID;

CREATE TABLE scope_cancel_member (
    run_id UUID NOT NULL REFERENCES run(run_id),
    scope_id UUID NOT NULL REFERENCES txn_scope(scope_id),
    vertex_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    inverse_tool TEXT NOT NULL,
    input JSONB NOT NULL,
    retry_policy JSONB NOT NULL,
    try_seq BIGINT NOT NULL,
    dependency_depth INTEGER NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT false,
    claimed_by TEXT,
    lease_until TIMESTAMPTZ,
    PRIMARY KEY (run_id, scope_id, vertex_id)
);
CREATE INDEX scope_cancel_member_ready_idx ON scope_cancel_member (run_id, scope_id, dependency_depth DESC, vertex_id) WHERE NOT completed;

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
        INSERT INTO txn_bracket (idempotency_key, run_id, scope_id, state, deadline_at, try_vertex_id, try_seq, confirm_tool, cancel_tool, compensate_tool, input, retry_policy)
        VALUES (bracket_key, NEW.run_id, NEW.scope_id, 'sealed', (NEW.payload->>'deadline_at')::TIMESTAMPTZ, NEW.vertex_id, NEW.stream_seq,
                NEW.payload->>'confirm_tool', NEW.payload->>'cancel_tool', NEW.payload->>'compensate_tool', COALESCE(NEW.payload->'input', '{}'::JSONB),
                COALESCE(NEW.payload->'retry_policy', '{"max_attempts":1,"initial_backoff_ms":0,"multiplier":1,"max_backoff_ms":0}'::JSONB));
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
            INSERT INTO scope_cancel_member (run_id, scope_id, vertex_id, idempotency_key, inverse_tool, input, retry_policy, try_seq, dependency_depth)
            WITH RECURSIVE members AS (
                SELECT b.try_vertex_id AS vertex_id, b.idempotency_key, COALESCE(b.cancel_tool, b.compensate_tool) AS inverse_tool,
                       b.input, b.retry_policy, b.try_seq
                FROM txn_bracket b WHERE b.run_id = NEW.run_id AND b.scope_id = NEW.scope_id AND b.state = 'sealed'
                  AND COALESCE(b.cancel_tool, b.compensate_tool) IS NOT NULL
            ), paths(vertex_id, depth) AS (
                SELECT vertex_id, 0 FROM members
                UNION ALL
                SELECT child.vertex_id, paths.depth + 1 FROM paths
                JOIN event_log child ON child.run_id = NEW.run_id AND child.event_type = 'vertex/created' AND paths.vertex_id = ANY(child.parent_refs)
                JOIN members member_child ON member_child.vertex_id = child.vertex_id
            )
            SELECT NEW.run_id, NEW.scope_id, m.vertex_id, m.idempotency_key, m.inverse_tool, m.input, m.retry_policy, m.try_seq, max(paths.depth)
            FROM members m JOIN paths ON paths.vertex_id = m.vertex_id
            GROUP BY m.vertex_id, m.idempotency_key, m.inverse_tool, m.input, m.retry_policy, m.try_seq
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

CREATE OR REPLACE FUNCTION check_no_cancel_after_pivot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE seed_seq BIGINT; scope_state TEXT;
BEGIN
    IF NEW.event_type = 'txn/cancel' THEN
        SELECT state INTO scope_state FROM txn_scope WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id FOR UPDATE;
        IF scope_state IN ('pivot-inflight', 'pivot-passed', 'committed', 'suspended') THEN
            RAISE EXCEPTION 'cannot cancel scope % in state %', NEW.scope_id, scope_state;
        END IF;
    END IF;
    IF NEW.event_type IN ('txn/confirm', 'txn/cancel') THEN
        SELECT stream_seq INTO seed_seq FROM event_log WHERE run_id = NEW.run_id AND event_type = 'run/end-seed' ORDER BY stream_seq LIMIT 1;
        IF seed_seq IS NOT NULL AND EXISTS (SELECT 1 FROM event_log WHERE run_id = NEW.run_id AND event_type = 'txn/try' AND scope_id = NEW.scope_id AND stream_seq < seed_seq) THEN
            RAISE EXCEPTION 'fork cannot mutate inherited transaction bracket for scope %', NEW.scope_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_vertex_work() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.event_type = 'vertex/created' AND NEW.payload->>'role' IN ('tool', 'confirmation-barrier') THEN
        INSERT INTO work_queue (vertex_id, run_id, ready_at, parent_refs, payload, scope_id)
        VALUES (NEW.vertex_id, NEW.run_id, now(), NEW.parent_refs, NEW.payload, NEW.scope_id) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER event_log_enqueue_work AFTER INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION enqueue_vertex_work();

CREATE OR REPLACE FUNCTION ensure_txn_scope(p_run_id UUID, p_scope_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE scope_payload JSONB;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may initialize a scope'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id::TEXT || ':' || p_scope_id::TEXT, 0));
    IF EXISTS (SELECT 1 FROM txn_scope WHERE run_id = p_run_id AND scope_id = p_scope_id) THEN RETURN false; END IF;
    SELECT jsonb_build_object(
        'state', 'open',
        'member_vertices', COALESCE(jsonb_agg(vertex_id ORDER BY stream_seq), '[]'::JSONB),
        'required_try_vertices', COALESCE(jsonb_agg(vertex_id ORDER BY stream_seq) FILTER (WHERE payload->'txn'->>'mode' IN ('tcc', 'saga')), '[]'::JSONB)
    ) INTO scope_payload
    FROM event_log WHERE run_id = p_run_id AND scope_id = p_scope_id AND event_type = 'vertex/created';
    PERFORM append_events(p_run_id, jsonb_build_array(jsonb_build_object('event_type', 'txn/scope', 'scope_id', p_scope_id, 'payload', scope_payload)));
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION claim_ready_work(p_worker TEXT, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, run_id UUID, scope_id UUID, parent_refs UUID[], payload JSONB, attempt INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may claim work'; END IF;
    RETURN QUERY
    WITH candidate AS (
        SELECT q.vertex_id FROM work_queue q
        WHERE q.ready_at <= now() AND (q.lease_until IS NULL OR q.lease_until < now())
          AND NOT EXISTS (
              SELECT 1 FROM unnest(q.parent_refs) parent_id
              WHERE NOT EXISTS (SELECT 1 FROM event_log e WHERE e.run_id = q.run_id AND e.vertex_id = parent_id AND e.event_type = 'vertex/succeeded')
          )
        ORDER BY q.ready_at, q.vertex_id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE work_queue q SET claimed_by = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds), attempt = q.attempt + 1
    FROM candidate c WHERE q.vertex_id = c.vertex_id
    RETURNING q.vertex_id, q.run_id, q.scope_id, q.parent_refs, q.payload, q.attempt;
END;
$$;

CREATE OR REPLACE FUNCTION complete_work(p_worker TEXT, p_vertex_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may complete work'; END IF;
    DELETE FROM work_queue WHERE vertex_id = p_vertex_id AND claimed_by = p_worker;
    IF NOT FOUND THEN RAISE EXCEPTION 'work % is not claimed by %', p_vertex_id, p_worker; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION release_work(p_worker TEXT, p_vertex_id UUID, p_delay_ms BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may release work'; END IF;
    UPDATE work_queue SET claimed_by = NULL, lease_until = NULL, ready_at = now() + make_interval(secs => p_delay_ms / 1000.0)
    WHERE vertex_id = p_vertex_id AND claimed_by = p_worker;
    IF NOT FOUND THEN RAISE EXCEPTION 'work % is not claimed by %', p_vertex_id, p_worker; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admit_pivot(p_run_id UUID, p_scope_id UUID, p_vertex_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE required_count INTEGER; sealed_count INTEGER;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may admit a pivot'; END IF;
    PERFORM 1 FROM txn_scope WHERE run_id = p_run_id AND scope_id = p_scope_id AND state = 'open' FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT cardinality(required_try_vertices) INTO required_count FROM txn_scope WHERE scope_id = p_scope_id;
    SELECT count(*) INTO sealed_count FROM txn_bracket b JOIN txn_scope s ON s.scope_id = b.scope_id
    WHERE b.run_id = p_run_id AND b.scope_id = p_scope_id AND b.state = 'sealed' AND b.try_vertex_id = ANY(s.required_try_vertices);
    IF sealed_count <> required_count THEN RETURN false; END IF;
    UPDATE txn_scope SET state = 'pivot-inflight', pivot_vertex_id = p_vertex_id, updated_at = now() WHERE scope_id = p_scope_id;
    PERFORM append_events(p_run_id, jsonb_build_array(jsonb_build_object(
        'event_type', 'vertex/started', 'vertex_id', p_vertex_id, 'scope_id', p_scope_id,
        'payload', jsonb_build_object('phase', 'pivot'))));
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_pivot_absent(p_run_id UUID, p_scope_id UUID, p_vertex_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may resolve a pivot'; END IF;
    UPDATE txn_scope SET state = 'open', pivot_vertex_id = NULL, updated_at = now()
    WHERE run_id = p_run_id AND scope_id = p_scope_id AND state = 'pivot-inflight' AND pivot_vertex_id = p_vertex_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope % has no matching pivot-inflight action', p_scope_id; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION request_scope_cancel(p_run_id UUID, p_scope_id UUID, p_key TEXT, p_reason TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE scope_state TEXT; existing_key TEXT;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may request cancellation'; END IF;
    SELECT state, cancel_idempotency_key INTO scope_state, existing_key FROM txn_scope
    WHERE run_id = p_run_id AND scope_id = p_scope_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown transaction scope %', p_scope_id; END IF;
    IF scope_state IN ('cancelling', 'cancelled') THEN
        IF existing_key IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'scope % has a different cancel idempotency key', p_scope_id; END IF;
        RETURN false;
    END IF;
    IF scope_state <> 'open' THEN RAISE EXCEPTION 'cannot cancel scope % in state %', p_scope_id, scope_state; END IF;
    PERFORM append_events(p_run_id, jsonb_build_array(jsonb_build_object(
        'event_type', 'txn/cancel', 'scope_id', p_scope_id,
        'payload', jsonb_build_object('idempotency_key', p_key, 'phase', 'requested', 'reason', p_reason))));
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION claim_cancel_member(p_worker TEXT, p_run_id UUID, p_scope_id UUID, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, idempotency_key TEXT, inverse_tool TEXT, input JSONB, retry_policy JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may claim cancellation'; END IF;
    RETURN QUERY WITH candidate AS (
        SELECT m.vertex_id FROM scope_cancel_member m WHERE m.run_id = p_run_id AND m.scope_id = p_scope_id AND NOT m.completed
          AND (m.lease_until IS NULL OR m.lease_until < now()) ORDER BY m.dependency_depth DESC, m.vertex_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE scope_cancel_member m SET claimed_by = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds)
      FROM candidate c WHERE m.run_id = p_run_id AND m.scope_id = p_scope_id AND m.vertex_id = c.vertex_id
      RETURNING m.vertex_id, m.idempotency_key, m.inverse_tool, m.input, m.retry_policy;
END;
$$;

CREATE OR REPLACE FUNCTION complete_cancel_member(p_worker TEXT, p_run_id UUID, p_scope_id UUID, p_vertex_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may complete cancellation'; END IF;
    UPDATE scope_cancel_member SET completed = true, claimed_by = NULL, lease_until = NULL
    WHERE run_id = p_run_id AND scope_id = p_scope_id AND vertex_id = p_vertex_id AND claimed_by = p_worker;
    IF NOT FOUND THEN RAISE EXCEPTION 'cancel member % is not claimed by %', p_vertex_id, p_worker; END IF;
END;
$$;

REVOKE ALL ON scope_cancel_member FROM PUBLIC;
GRANT SELECT ON scope_cancel_member TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION ensure_txn_scope(UUID, UUID), claim_ready_work(TEXT, INTEGER), complete_work(TEXT, UUID), release_work(TEXT, UUID, BIGINT), admit_pivot(UUID, UUID, UUID),
    resolve_pivot_absent(UUID, UUID, UUID),
    request_scope_cancel(UUID, UUID, TEXT, TEXT),
    claim_cancel_member(TEXT, UUID, UUID, INTEGER), complete_cancel_member(TEXT, UUID, UUID, UUID) TO coordinator_role;
