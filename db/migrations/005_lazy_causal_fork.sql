-- Lazy causal fork storage (ADR-005): inherited copies preserve source stream_seq and carry
-- provenance; a fork run numbers its own events above eval_up_to_seq; inherited-try locking
-- keys on provenance instead of run/end-seed position.

ALTER TABLE run ADD COLUMN IF NOT EXISTS seed_floor BIGINT CHECK (seed_floor IS NULL OR seed_floor >= 1);
ALTER TABLE event_log ADD COLUMN IF NOT EXISTS inherited BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION create_fork_run(p_run_id UUID, p_eval_up_to_seq BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may create fork runs'; END IF;
    IF p_eval_up_to_seq IS NULL OR p_eval_up_to_seq < 1 THEN RAISE EXCEPTION 'fork run requires a positive evaluation boundary'; END IF;
    INSERT INTO run(run_id, next_seq, seed_floor) VALUES (p_run_id, p_eval_up_to_seq + 1, p_eval_up_to_seq);
END;
$$;

-- Serializes lazy merges into one fork and returns its seed floor (eval_up_to_seq).
CREATE OR REPLACE FUNCTION lock_fork_run(p_run_id UUID) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE floor_seq BIGINT;
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may lock a fork run'; END IF;
    SELECT seed_floor INTO floor_seq FROM run WHERE run_id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'run % does not exist', p_run_id; END IF;
    IF floor_seq IS NULL THEN RAISE EXCEPTION 'run % is not a fork', p_run_id; END IF;
    RETURN floor_seq;
END;
$$;

-- Inherited copies keep their source stream_seq (never allocated from next_seq) and are marked
-- with inherited provenance. They must sit at or below the fork's seed floor so an inherited seq
-- and an own seq can never collide. The transaction-local marker bypasses ownership and skips
-- side-effect projections only while reproducing source history; it is reset before returning.
CREATE OR REPLACE FUNCTION copy_inherited_events(p_run_id UUID, p_events JSONB)
RETURNS TABLE(stream_seq BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item JSONB; floor_seq BIGINT; item_seq BIGINT;
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may copy inherited events'; END IF;
    IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) = 0 THEN
        RAISE EXCEPTION 'copy_inherited_events requires a non-empty event array';
    END IF;
    SELECT seed_floor INTO floor_seq FROM run WHERE run_id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'run % does not exist', p_run_id; END IF;
    IF floor_seq IS NULL THEN RAISE EXCEPTION 'run % is not a fork; inherited copies require a seed floor', p_run_id; END IF;
    PERFORM set_config('flory.inherit_copy', 'on', true);
    FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
        item_seq := (item->>'stream_seq')::BIGINT;
        IF item_seq IS NULL OR item_seq < 1 OR item_seq > floor_seq THEN
            RAISE EXCEPTION 'inherited stream_seq % must lie within the seed floor %', item_seq, floor_seq;
        END IF;
        INSERT INTO event_log (run_id, stream_seq, event_type, vertex_id, parent_refs, planner_id, scope_id, pin_version, ignorable, inherited, payload)
        VALUES (
            p_run_id, item_seq, item->>'event_type', NULLIF(item->>'vertex_id', '')::UUID,
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(item->'parent_refs', '[]'::JSONB))::UUID), '{}'),
            NULLIF(item->>'planner_id', '')::UUID, NULLIF(item->>'scope_id', '')::UUID,
            NULLIF(item->>'pin_version', ''), COALESCE((item->>'ignorable')::BOOLEAN, false), true, COALESCE(item->'payload', '{}'::JSONB)
        );
        stream_seq := item_seq; RETURN NEXT;
    END LOOP;
    PERFORM set_config('flory.inherit_copy', 'off', true);
END;
$$;

-- Inherited-try locking keys on provenance: a txn/confirm or txn/cancel is rejected whenever the
-- scope's txn/try is an inherited copy, wherever that copy sits (seeded before run/end-seed or
-- merged later as a causally independent event). Reproducing inherited history itself is exempt.
CREATE OR REPLACE FUNCTION check_no_cancel_after_pivot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE scope_state TEXT;
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type = 'txn/cancel' THEN
        SELECT state INTO scope_state FROM txn_scope WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id FOR UPDATE;
        IF scope_state IN ('pivot-inflight', 'pivot-passed', 'committed', 'suspended') THEN
            RAISE EXCEPTION 'cannot cancel scope % in state %', NEW.scope_id, scope_state;
        END IF;
    END IF;
    IF NEW.event_type IN ('txn/confirm', 'txn/cancel') AND EXISTS (
        SELECT 1 FROM event_log WHERE run_id = NEW.run_id AND event_type = 'txn/try' AND scope_id = NEW.scope_id AND inherited
    ) THEN
        RAISE EXCEPTION 'fork cannot mutate inherited transaction bracket for scope %', NEW.scope_id;
    END IF;
    RETURN NEW;
END;
$$;

-- An inherited vertex copy is read-only history for offline evaluation; it must never surface as
-- live coordinator work in the fork run.
CREATE OR REPLACE FUNCTION enqueue_vertex_work() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type = 'vertex/created' AND NEW.payload->>'role' IN ('tool', 'confirmation-barrier') THEN
        INSERT INTO work_queue (vertex_id, run_id, ready_at, parent_refs, payload, scope_id)
        VALUES (NEW.vertex_id, NEW.run_id, now(), NEW.parent_refs, NEW.payload, NEW.scope_id) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION create_fork_run(UUID, BIGINT), lock_fork_run(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_fork_run(UUID, BIGINT) TO engine_role;
GRANT EXECUTE ON FUNCTION lock_fork_run(UUID) TO engine_role;
