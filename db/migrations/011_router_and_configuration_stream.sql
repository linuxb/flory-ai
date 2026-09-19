-- A router is a third executor class, and rule templates get a stream of their own.
--
-- Two unrelated-looking changes share a migration because both exist to let the Engine own a
-- deterministic branch end to end: it evaluates the router itself, and it records the template the
-- router binds.

-- ---------------------------------------------------------------------------------------------
-- 1. The router executor class
-- ---------------------------------------------------------------------------------------------
--
-- A router performs no call, so there is nothing for a worker to claim and it is never enqueued.
-- enqueue_vertex_work already excludes it by allow-list, but the class still has to exist: without
-- it a router falls into the ELSE arm and is labelled coordinator work, which would then forbid the
-- Engine from appending the router's own lifecycle events.
--
-- flory_executor_class backs a STORED generated column, so PostgreSQL refuses to replace it while
-- that column exists. The column and its index are dropped and rebuilt around the replacement.

DROP INDEX IF EXISTS work_queue_class_ready_idx;
ALTER TABLE work_queue DROP COLUMN IF EXISTS executor_class;

CREATE OR REPLACE FUNCTION flory_executor_class(p_payload JSONB, p_scope_id UUID) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_payload->>'role' = 'router' THEN 'router'
        WHEN p_payload->>'role' = 'planner' THEN 'orchestrator'
        WHEN p_payload->>'role' = 'tool'
         AND p_payload->'txn'->>'effect_class' = 'none'
         AND p_scope_id IS NULL THEN 'orchestrator'
        ELSE 'coordinator'
    END;
$$;

ALTER TABLE work_queue ADD COLUMN executor_class TEXT
    GENERATED ALWAYS AS (flory_executor_class(payload, scope_id)) STORED;

CREATE INDEX work_queue_class_ready_idx ON work_queue (executor_class, ready_at);

-- The Engine evaluates a router, so it must be able to append that vertex's lifecycle events. The
-- executor branch was an exhaustive two-way test, and a third class turns "not orchestrator" into
-- the wrong question: what matters is whether this service owns that class.
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
        -- The Engine owns both classes it executes: reads it claims, and routers it evaluates
        -- synchronously without a queue.
        IF session_user = 'engine_role' AND executor_class NOT IN ('orchestrator', 'router') THEN
            RAISE EXCEPTION 'engine_role cannot append % for the coordinator-executed vertex %', NEW.event_type, NEW.vertex_id;
        ELSIF session_user = 'coordinator_role' AND executor_class <> 'coordinator' THEN
            RAISE EXCEPTION 'coordinator_role cannot append % for the %-executed vertex %', NEW.event_type, executor_class, NEW.vertex_id;
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

-- ---------------------------------------------------------------------------------------------
-- 2. The configuration stream
-- ---------------------------------------------------------------------------------------------
--
-- A rule template is planning structure, not a business fact and not a run: publishing one is
-- caused by a person, not by an orchestration step. It therefore lives in the data plane under a
-- reserved stream id, where it folds under the ordinary ordering rules, and it is the one kind of
-- row with no (run_id, run_seq) provenance to record.
--
-- The nullability is constrained rather than merely allowed: a configuration row must have no run,
-- and every other row must have one. Leaving it optional everywhere would quietly weaken the
-- provenance guarantee for domain facts, which is the reason the column exists.

ALTER TABLE business_event_stream ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE business_event_stream ALTER COLUMN run_seq DROP NOT NULL;
ALTER TABLE business_event_stream ADD CONSTRAINT business_event_stream_provenance_chk
    CHECK ((stream_id LIKE 'config:%') = (run_id IS NULL AND run_seq IS NULL));

CREATE OR REPLACE FUNCTION check_business_event_ownership() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.stream_id LIKE 'config:%' THEN
        IF NEW.event_type <> 'rule_template/published' THEN
            RAISE EXCEPTION 'the configuration stream carries only rule_template/published, not %', NEW.event_type;
        END IF;
        IF session_user <> 'engine_role' THEN
            RAISE EXCEPTION 'only engine_role may publish to the configuration stream';
        END IF;
    ELSIF NEW.event_type = 'rule_template/published' THEN
        RAISE EXCEPTION 'rule_template/published belongs to the configuration stream, not %', NEW.stream_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER business_event_stream_ownership BEFORE INSERT ON business_event_stream
FOR EACH ROW EXECUTE FUNCTION check_business_event_ownership();

-- Appends one configuration event. Separate from append_domain_events because that path requires a
-- causing orchestration event and derives counterfactual isolation from the run's fork provenance,
-- neither of which a publication has.
CREATE OR REPLACE FUNCTION append_config_event(p_stream_id TEXT, p_event_type TEXT, p_payload JSONB)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE allocated BIGINT;
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may append configuration events'; END IF;
    IF p_stream_id NOT LIKE 'config:%' THEN RAISE EXCEPTION 'append_config_event requires a config: stream, not %', p_stream_id; END IF;

    INSERT INTO stream (stream_id) VALUES (p_stream_id)
    ON CONFLICT (stream_id) DO UPDATE SET next_seq = stream.next_seq;
    UPDATE stream SET next_seq = next_seq + 1 WHERE stream_id = p_stream_id RETURNING next_seq - 1 INTO allocated;

    INSERT INTO business_event_stream (stream_id, stream_seq, event_type, payload)
    VALUES (p_stream_id, allocated, p_event_type, COALESCE(p_payload, '{}'::JSONB));
    RETURN allocated;
END;
$$;

REVOKE ALL ON FUNCTION append_config_event(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_config_event(TEXT, TEXT, JSONB) TO engine_role;
