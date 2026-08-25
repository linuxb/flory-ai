-- Executor authority splits by effect class.
--
-- A tool-caller vertex with effect_class 'none' and no scope has no bracket, no
-- compensation, and no pivot interaction: there is nothing for a transaction
-- coordinator to own, and doc 05's reads-live fold mode already assumes the
-- Orchestrator executes exactly that class of tool live. Every other tool-caller
-- vertex stays with the Coordinator.
--
-- Check-rule R10 guarantees that every side-effecting node belongs to a scope, so
-- the two classes partition the queued vertices with no overlap and no gap. The
-- rule and the constraints below therefore state one fact in two places rather
-- than two facts that could drift.
--
-- Confirmation barriers and planner-role vertices are unchanged: barriers are
-- Coordinator-run, and a planner vertex is not queued at all.

-- The class is derived, never declared -- the same discipline as is_pivot. There
-- is no column a writer could set to disagree with the payload it came from.
--
-- A planner vertex is Orchestrator-executed because the Orchestrator is what runs
-- it: it calls a model, not a tool, and is never queued to the Coordinator at all.
-- Before this split the Coordinator had to record its outcome, which meant a
-- service writing execution events for work it did not do.
CREATE OR REPLACE FUNCTION flory_executor_class(p_payload JSONB, p_scope_id UUID) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_payload->>'role' = 'planner' THEN 'orchestrator'
        WHEN p_payload->>'role' = 'tool'
         AND p_payload->'txn'->>'effect_class' = 'none'
         AND p_scope_id IS NULL THEN 'orchestrator'
        ELSE 'coordinator'
    END;
$$;

ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS executor_class TEXT
    GENERATED ALWAYS AS (flory_executor_class(payload, scope_id)) STORED;

CREATE INDEX IF NOT EXISTS work_queue_class_ready_idx ON work_queue (executor_class, ready_at);

-- Resolves the class of an already-created vertex, for the ownership trigger.
CREATE OR REPLACE FUNCTION flory_vertex_executor_class(p_run_id UUID, p_vertex_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT flory_executor_class(e.payload, e.scope_id)
    FROM event_log e
    WHERE e.run_id = p_run_id AND e.vertex_id = p_vertex_id AND e.event_type = 'vertex/created'
    ORDER BY e.stream_seq
    LIMIT 1;
$$;

-- vertex/* execution events now belong to whichever executor owns that vertex,
-- rather than to the Coordinator unconditionally.
CREATE OR REPLACE FUNCTION flory_event_owner(p_event_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('run/start', 'run/end', 'run/end-seed', 'replan/boundary', 'fork/created', 'budget/charged', 'vertex/created')
          OR p_event_type LIKE 'subgraph/%' THEN 'engine'
        WHEN p_event_type IN ('vertex/started', 'vertex/succeeded', 'vertex/failed', 'vertex/retried') THEN 'executor'
        WHEN p_event_type LIKE 'txn/%' THEN 'coordinator'
        ELSE NULL
    END;
$$;

-- The split must not degrade into "whichever worker got there first", so the
-- database refuses an execution event from the service that does not own that
-- vertex. A guard in either service is advice; this is the boundary.
CREATE OR REPLACE FUNCTION check_event_ownership() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    owner_name TEXT;
    executor_class TEXT;
BEGIN
    owner_name := flory_event_owner(NEW.event_type);
    IF owner_name IS NULL AND NOT NEW.ignorable THEN
        RAISE EXCEPTION 'unknown non-ignorable event type %', NEW.event_type;
    END IF;
    IF current_setting('flory.inherit_copy', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF owner_name = 'executor' THEN
        executor_class := flory_vertex_executor_class(NEW.run_id, NEW.vertex_id);
        IF executor_class IS NULL THEN
            RAISE EXCEPTION 'cannot append % for vertex % before its vertex/created', NEW.event_type, NEW.vertex_id;
        END IF;
        IF session_user = 'engine_role' AND executor_class <> 'orchestrator' THEN
            RAISE EXCEPTION 'engine_role cannot append % for the coordinator-executed vertex %', NEW.event_type, NEW.vertex_id;
        ELSIF session_user = 'coordinator_role' AND executor_class <> 'coordinator' THEN
            RAISE EXCEPTION 'coordinator_role cannot append % for the orchestrator-executed vertex %', NEW.event_type, NEW.vertex_id;
        END IF;
        RETURN NEW;
    END IF;
    IF session_user = 'engine_role' AND owner_name IS DISTINCT FROM 'engine' THEN
        RAISE EXCEPTION 'engine_role cannot append event type %', NEW.event_type;
    ELSIF session_user = 'coordinator_role' AND owner_name IS DISTINCT FROM 'coordinator' THEN
        RAISE EXCEPTION 'coordinator_role cannot append event type %', NEW.event_type;
    END IF;
    RETURN NEW;
END;
$$;

-- The Coordinator now claims only its own class, so the two pollers cannot
-- contend for one row.
CREATE OR REPLACE FUNCTION claim_ready_work(p_worker TEXT, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, run_id UUID, scope_id UUID, parent_refs UUID[], payload JSONB, attempt INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may claim work'; END IF;
    RETURN QUERY
    WITH candidate AS (
        SELECT q.vertex_id FROM work_queue q
        WHERE q.executor_class = 'coordinator' AND q.ready_at <= now() AND (q.lease_until IS NULL OR q.lease_until < now())
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

-- The Orchestrator's counterpart. Readiness is the same predicate: a vertex is
-- executable once every parent has succeeded, whichever executor ran them.
CREATE OR REPLACE FUNCTION claim_ready_read(p_worker TEXT, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, run_id UUID, parent_refs UUID[], payload JSONB, attempt INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may claim reads'; END IF;
    RETURN QUERY
    WITH candidate AS (
        SELECT q.vertex_id FROM work_queue q
        WHERE q.executor_class = 'orchestrator' AND q.ready_at <= now() AND (q.lease_until IS NULL OR q.lease_until < now())
          AND NOT EXISTS (
              SELECT 1 FROM unnest(q.parent_refs) parent_id
              WHERE NOT EXISTS (SELECT 1 FROM event_log e WHERE e.run_id = q.run_id AND e.vertex_id = parent_id AND e.event_type = 'vertex/succeeded')
          )
        ORDER BY q.ready_at, q.vertex_id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE work_queue q SET claimed_by = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds), attempt = q.attempt + 1
    FROM candidate c WHERE q.vertex_id = c.vertex_id
    RETURNING q.vertex_id, q.run_id, q.parent_refs, q.payload, q.attempt;
END;
$$;

CREATE OR REPLACE FUNCTION complete_read(p_worker TEXT, p_vertex_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may complete reads'; END IF;
    DELETE FROM work_queue WHERE vertex_id = p_vertex_id AND claimed_by = p_worker AND executor_class = 'orchestrator';
    IF NOT FOUND THEN RAISE EXCEPTION 'read work % is not claimed by %', p_vertex_id, p_worker; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION release_read(p_worker TEXT, p_vertex_id UUID, p_delay_ms BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may release reads'; END IF;
    UPDATE work_queue SET claimed_by = NULL, lease_until = NULL, ready_at = now() + make_interval(secs => p_delay_ms / 1000.0)
    WHERE vertex_id = p_vertex_id AND claimed_by = p_worker AND executor_class = 'orchestrator';
END;
$$;

GRANT EXECUTE ON FUNCTION claim_ready_read(TEXT, INTEGER), complete_read(TEXT, UUID), release_read(TEXT, UUID, BIGINT) TO engine_role;
GRANT EXECUTE ON FUNCTION flory_executor_class(JSONB, UUID), flory_vertex_executor_class(UUID, UUID) TO engine_role, coordinator_role;
