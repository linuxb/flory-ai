CREATE TABLE IF NOT EXISTS schema_migration (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run (
    run_id UUID PRIMARY KEY,
    next_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_log (
    run_id UUID NOT NULL REFERENCES run(run_id),
    stream_seq BIGINT NOT NULL CHECK (stream_seq >= 1),
    global_seq BIGINT GENERATED ALWAYS AS IDENTITY,
    event_type TEXT NOT NULL,
    vertex_id UUID,
    parent_refs UUID[] NOT NULL DEFAULT '{}',
    planner_id UUID,
    scope_id UUID,
    pin_version TEXT,
    ignorable BOOLEAN NOT NULL DEFAULT false,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, stream_seq)
) PARTITION BY HASH (run_id);

CREATE TABLE event_log_p0 PARTITION OF event_log FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE event_log_p1 PARTITION OF event_log FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE event_log_p2 PARTITION OF event_log FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE event_log_p3 PARTITION OF event_log FOR VALUES WITH (MODULUS 4, REMAINDER 3);
CREATE INDEX event_log_run_type_idx ON event_log (run_id, event_type, stream_seq);
CREATE INDEX event_log_scope_idx ON event_log (run_id, scope_id, stream_seq) WHERE scope_id IS NOT NULL;

CREATE TABLE txn_scope (
    scope_id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES run(run_id),
    state TEXT NOT NULL,
    pivot_vertex_id UUID,
    savepoint_seq BIGINT,
    opened_seq BIGINT NOT NULL,
    closed_seq BIGINT,
    is_pivot BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX txn_scope_one_pivot_idx ON txn_scope (run_id, scope_id) WHERE is_pivot;

CREATE TABLE txn_bracket (
    idempotency_key TEXT PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES run(run_id),
    scope_id UUID NOT NULL REFERENCES txn_scope(scope_id),
    state TEXT NOT NULL,
    deadline_at TIMESTAMPTZ,
    try_vertex_id UUID NOT NULL,
    try_seq BIGINT NOT NULL
);
CREATE INDEX txn_bracket_open_idx ON txn_bracket (deadline_at) WHERE state = 'tried';

CREATE TABLE work_queue (
    vertex_id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES run(run_id),
    ready_at TIMESTAMPTZ NOT NULL,
    claimed_by TEXT
);

CREATE OR REPLACE FUNCTION flory_event_owner(p_event_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('run/start', 'run/end', 'run/end-seed', 'replan/boundary', 'fork/created', 'budget/charged', 'vertex/created')
          OR p_event_type LIKE 'subgraph/%' THEN 'engine'
        WHEN p_event_type IN ('vertex/started', 'vertex/succeeded', 'vertex/failed', 'vertex/retried')
          OR p_event_type LIKE 'txn/%' THEN 'coordinator'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION check_event_ownership() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE owner_name TEXT;
BEGIN
    owner_name := flory_event_owner(NEW.event_type);
    IF owner_name IS NULL AND NOT NEW.ignorable THEN
        RAISE EXCEPTION 'unknown non-ignorable event type %', NEW.event_type;
    END IF;
    IF current_setting('flory.inherit_copy', true) = 'on' THEN
        RETURN NEW;
    ELSIF session_user = 'engine_role' AND owner_name IS DISTINCT FROM 'engine' THEN
        RAISE EXCEPTION 'engine_role cannot append event type %', NEW.event_type;
    ELSIF session_user = 'coordinator_role' AND owner_name IS DISTINCT FROM 'coordinator' THEN
        RAISE EXCEPTION 'coordinator_role cannot append event type %', NEW.event_type;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION check_no_cancel_after_pivot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE seed_seq BIGINT;
BEGIN
    IF NEW.event_type = 'txn/cancel' AND EXISTS (
        SELECT 1 FROM txn_scope WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND state = 'pivot-passed'
    ) THEN
        RAISE EXCEPTION 'cannot cancel after pivot passed for scope %', NEW.scope_id;
    END IF;
    IF NEW.event_type IN ('txn/confirm', 'txn/cancel') THEN
        SELECT stream_seq INTO seed_seq FROM event_log
        WHERE run_id = NEW.run_id AND event_type = 'run/end-seed' ORDER BY stream_seq LIMIT 1;
        IF seed_seq IS NOT NULL AND EXISTS (
            SELECT 1 FROM event_log
            WHERE run_id = NEW.run_id AND event_type = 'txn/try' AND scope_id = NEW.scope_id AND stream_seq < seed_seq
        ) THEN
            RAISE EXCEPTION 'fork cannot mutate inherited transaction bracket for scope %', NEW.scope_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION apply_txn_projection() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE bracket_key TEXT;
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type = 'txn/scope' THEN
        INSERT INTO txn_scope (scope_id, run_id, state, savepoint_seq, opened_seq)
        VALUES (NEW.scope_id, NEW.run_id, COALESCE(NEW.payload->>'state', 'opened'),
                NULLIF(NEW.payload->>'savepoint_seq', '')::BIGINT, NEW.stream_seq)
        ON CONFLICT (scope_id) DO UPDATE SET state = EXCLUDED.state, closed_seq = NEW.stream_seq;
    ELSIF NEW.event_type = 'txn/try' THEN
        bracket_key := NEW.payload->>'idempotency_key';
        IF bracket_key IS NULL THEN RAISE EXCEPTION 'txn/try requires payload.idempotency_key'; END IF;
        INSERT INTO txn_bracket (idempotency_key, run_id, scope_id, state, deadline_at, try_vertex_id, try_seq)
        VALUES (bracket_key, NEW.run_id, NEW.scope_id, 'tried',
                NULLIF(NEW.payload->>'deadline_at', '')::TIMESTAMPTZ, NEW.vertex_id, NEW.stream_seq);
    ELSIF NEW.event_type = 'txn/pivot-passed' THEN
        UPDATE txn_scope SET state = 'pivot-passed', is_pivot = true, pivot_vertex_id = NEW.vertex_id
        WHERE scope_id = NEW.scope_id AND run_id = NEW.run_id AND pivot_vertex_id IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'pivot requires open non-pivot scope %', NEW.scope_id; END IF;
    ELSIF NEW.event_type IN ('txn/confirm', 'txn/cancel') THEN
        bracket_key := NEW.payload->>'idempotency_key';
        UPDATE txn_bracket SET state = CASE WHEN NEW.event_type = 'txn/confirm' THEN 'confirmed' ELSE 'cancelled' END
        WHERE idempotency_key = bracket_key AND run_id = NEW.run_id AND scope_id = NEW.scope_id AND state = 'tried';
        IF NOT FOUND THEN RAISE EXCEPTION '% requires open matching txn/try', NEW.event_type; END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER event_log_ownership BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION check_event_ownership();
CREATE TRIGGER event_log_cancel_guard BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION check_no_cancel_after_pivot();
CREATE TRIGGER event_log_txn_projection AFTER INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION apply_txn_projection();

CREATE OR REPLACE FUNCTION create_run(p_run_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may create runs'; END IF;
    INSERT INTO run(run_id) VALUES (p_run_id);
END;
$$;

CREATE OR REPLACE FUNCTION append_events(p_run_id UUID, p_events JSONB)
RETURNS TABLE(stream_seq BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item JSONB; allocated_seq BIGINT;
BEGIN
    IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) = 0 THEN
        RAISE EXCEPTION 'append_events requires a non-empty event array';
    END IF;
    PERFORM 1 FROM run WHERE run_id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'run % does not exist', p_run_id; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
        UPDATE run SET next_seq = next_seq + 1 WHERE run_id = p_run_id RETURNING next_seq - 1 INTO allocated_seq;
        INSERT INTO event_log (run_id, stream_seq, event_type, vertex_id, parent_refs, planner_id, scope_id, pin_version, ignorable, payload)
        VALUES (
            p_run_id, allocated_seq, item->>'event_type', NULLIF(item->>'vertex_id', '')::UUID,
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(item->'parent_refs', '[]'::JSONB))::UUID), '{}'),
            NULLIF(item->>'planner_id', '')::UUID, NULLIF(item->>'scope_id', '')::UUID,
            NULLIF(item->>'pin_version', ''), COALESCE((item->>'ignorable')::BOOLEAN, false), COALESCE(item->'payload', '{}'::JSONB)
        );
        stream_seq := allocated_seq; RETURN NEXT;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION copy_inherited_events(p_run_id UUID, p_events JSONB)
RETURNS TABLE(stream_seq BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may copy inherited events'; END IF;
    PERFORM set_config('flory.inherit_copy', 'on', true);
    RETURN QUERY SELECT * FROM append_events(p_run_id, p_events);
END;
$$;

REVOKE ALL ON event_log, run, txn_scope, txn_bracket, work_queue FROM PUBLIC;
REVOKE ALL ON FUNCTION create_run(UUID), append_events(UUID, JSONB) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO engine_role, coordinator_role;
GRANT SELECT ON event_log, run, txn_scope, txn_bracket, work_queue TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION create_run(UUID) TO engine_role;
GRANT EXECUTE ON FUNCTION append_events(UUID, JSONB) TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION copy_inherited_events(UUID, JSONB) TO engine_role;
