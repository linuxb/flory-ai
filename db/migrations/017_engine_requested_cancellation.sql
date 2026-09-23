-- The Engine initiates every failure-driven scope cancellation; the Coordinator executes it.
--
-- Until now the Coordinator cancelled a scope on its own the moment one of its members failed,
-- and the Engine's recovery ladder read the log without waiting for that to finish. Two readers
-- each decided *when*, and neither waited for the other:
--
--   * reading before the cancel was requested, the ladder found every planner inside an open
--     bracket, escalated, and recorded the escalation as the failure's answer -- so once the
--     cancellation completed and a boundary became legal, nothing ever asked again;
--   * reading after `txn/cancel {requested}` but before `{completed}`, it treated the bracket as
--     closed and replanned across a try whose inverse had not run yet.
--
-- The Engine is the party that decides a replan and checks it, so it is also the one that decides
-- a cancellation is needed. This migration gives it the channel to say so and makes the database
-- refuse every other way in:
--
--   1. A scoped failure fences its scope in the same transaction. A fence is not a cancellation --
--      it has no external effect -- it only stops the scope handing out work and refuses pivot
--      admission, so nothing new lands between the failure and the Engine's request.
--   2. The Engine appends `replan/cancel-requested`, which records a pending request on each named
--      scope. The Coordinator polls pending requests and runs them through `request_scope_cancel`.
--   3. `request_scope_cancel` now takes an origin. `engine` requires a recorded request; `timeout`
--      (the orphan sweep, which stays with the Coordinator) requires an expired sealed try,
--      re-verified under the lock. Both use the scope's one cancel key, so they converge.
--   4. `txn/cancel {requested}` itself is refused unless one of those two authorizations exists,
--      and a shadow into a scope that is not yet cancelled or committed is refused, which is
--      cancel-before-replan enforced where no caller can skip it.
--
-- Lock order. `append_events` locks `run` and its triggers then touch `txn_scope`, while
-- `request_scope_cancel`, `admit_pivot` and `lock_run_scopes` lock `txn_scope` first. With a
-- second process now requesting cancellations, that inversion is a real deadlock pair, so every
-- scoped Coordinator append goes through `append_scope_events`, which takes the scope row first.
-- The one order is txn_scope (opened_seq order) -> run -> work_queue.

-- ---------------------------------------------------------------------------------------------
-- 1. Fence and request state, on the scope row that is already the lock
-- ---------------------------------------------------------------------------------------------

ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS fenced_at TIMESTAMPTZ;
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS fence_seq BIGINT;
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS fence_vertex_id UUID;
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS fence_reason TEXT;
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS cancel_requested_seq BIGINT;
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS cancel_request_outcome TEXT
    CHECK (cancel_request_outcome IN ('pending', 'deferred', 'requested', 'duplicate', 'suspended'));
ALTER TABLE txn_scope ADD COLUMN IF NOT EXISTS cancel_request_next_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS txn_scope_cancel_request_idx ON txn_scope (cancel_request_next_at)
    WHERE cancel_request_outcome IN ('pending', 'deferred');

-- ---------------------------------------------------------------------------------------------
-- 2. Ownership: the request is the Engine's
-- ---------------------------------------------------------------------------------------------
--
-- An exact name rather than `replan/%`: a prefix would hand the Engine every future event under
-- it, and ownership is the one decision here that should never be made by accident.
CREATE OR REPLACE FUNCTION flory_event_owner(p_event_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('run/start', 'run/end', 'run/end-seed', 'replan/boundary', 'replan/cancel-requested', 'fork/created', 'budget/charged', 'vertex/created')
          OR p_event_type LIKE 'subgraph/%' THEN 'engine'
        WHEN p_event_type IN ('vertex/started', 'vertex/succeeded', 'vertex/failed', 'vertex/retried') THEN 'executor'
        WHEN p_event_type LIKE 'txn/%' THEN 'coordinator'
        ELSE NULL
    END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The fence
-- ---------------------------------------------------------------------------------------------
--
-- Only an `open` scope fences. A failure after the pivot is forward recovery and must not stop
-- the confirms that close the scope; a failure while the pivot is in flight is the pivot's own
-- unknown outcome, which suspends. The fence is one-way: it ends in `cancelling` or `suspended`
-- and is kept afterwards as history.
CREATE OR REPLACE FUNCTION fence_on_scoped_failure() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type <> 'vertex/failed' OR NEW.scope_id IS NULL THEN RETURN NEW; END IF;
    UPDATE txn_scope
       SET fenced_at = COALESCE(fenced_at, now()),
           fence_seq = COALESCE(fence_seq, NEW.run_seq),
           fence_vertex_id = COALESCE(fence_vertex_id, NEW.vertex_id),
           fence_reason = COALESCE(fence_reason, 'pre-pivot vertex failure'),
           updated_at = now()
     WHERE run_id = NEW.run_id AND scope_id = NEW.scope_id AND state = 'open';
    RETURN NEW;
END;
$$;

CREATE TRIGGER run_event_log_scope_fence
    AFTER INSERT ON run_event_log
    FOR EACH ROW EXECUTE FUNCTION fence_on_scoped_failure();

-- ---------------------------------------------------------------------------------------------
-- 4. The Engine's request
-- ---------------------------------------------------------------------------------------------
--
-- The Engine decides under the run's scope locks with a fresh log, so it never has a reason to
-- request a scope that is already cancelling, cancelled, suspended, past its pivot, or already
-- requested. Each of those is refused, which turns an Engine bug into a failed append rather than
-- a silent race. The request also fences: a healthy scope the ladder must cancel only because it
-- sits in the discard set would otherwise race pivot admission before the Coordinator picks the
-- request up, and could then never be cancelled at all.
CREATE OR REPLACE FUNCTION register_engine_cancel_request() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE requested UUID;
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type <> 'replan/cancel-requested' THEN RETURN NEW; END IF;
    FOR requested IN SELECT value::UUID FROM jsonb_array_elements_text(COALESCE(NEW.payload->'scope_ids', '[]'::jsonb)) AS value LOOP
        UPDATE txn_scope
           SET cancel_requested_seq = NEW.run_seq,
               cancel_request_outcome = 'pending',
               cancel_request_next_at = now(),
               fenced_at = COALESCE(fenced_at, now()),
               fence_seq = COALESCE(fence_seq, NEW.run_seq),
               fence_reason = COALESCE(fence_reason, 'engine cancel request'),
               updated_at = now()
         WHERE run_id = NEW.run_id AND scope_id = requested AND state = 'open' AND cancel_requested_seq IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'engine may request cancellation only of an open, unrequested scope %', requested;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER run_event_log_engine_cancel_request
    AFTER INSERT ON run_event_log
    FOR EACH ROW EXECUTE FUNCTION register_engine_cancel_request();

-- ---------------------------------------------------------------------------------------------
-- 5. The transaction projection: a cancellation needs an authorization
-- ---------------------------------------------------------------------------------------------
--
-- Identical to migration 013 except in two ways. The `requested` branch now refuses a
-- cancellation that neither the Engine asked for nor an expired try justifies; `request_scope_cancel`
-- checks the same thing first and says why, and this is the guard behind it, for any append that
-- goes around the function. And a pending Engine request is resolved here, by the state change
-- itself, whichever path made it: a request left `pending` on a scope that has already cancelled or
-- suspended would be picked up on every poll, fail, and starve every request behind it.
CREATE OR REPLACE FUNCTION apply_txn_projection() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE bracket_key TEXT; cancel_phase TEXT;
BEGIN
    IF current_setting('flory.inherit_copy', true) = 'on' THEN RETURN NEW; END IF;
    IF NEW.event_type = 'txn/scope' THEN
        INSERT INTO txn_scope (scope_id, run_id, state, savepoint_seq, opened_seq, member_vertices, required_try_vertices, updated_at)
        VALUES (NEW.scope_id, NEW.run_id, COALESCE(NEW.payload->>'state', 'open'), NULLIF(NEW.payload->>'savepoint_seq', '')::BIGINT,
                NEW.run_seq, COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.payload->'member_vertices', '[]'::JSONB))::UUID), '{}'),
                COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.payload->'required_try_vertices', '[]'::JSONB))::UUID), '{}'), now())
        ON CONFLICT (scope_id) DO UPDATE SET state = EXCLUDED.state, closed_seq = CASE WHEN EXCLUDED.state IN ('committed', 'cancelled', 'suspended') THEN NEW.run_seq ELSE txn_scope.closed_seq END,
            updated_at = now();
        IF NEW.payload->>'state' IN ('suspended', 'cancelled') THEN
            UPDATE txn_scope SET cancel_request_outcome = CASE WHEN NEW.payload->>'state' = 'suspended' THEN 'suspended' ELSE 'requested' END
            WHERE scope_id = NEW.scope_id AND run_id = NEW.run_id AND cancel_request_outcome IN ('pending', 'deferred');
        END IF;
    ELSIF NEW.event_type = 'txn/try' THEN
        bracket_key := NEW.payload->>'idempotency_key';
        INSERT INTO txn_bracket (idempotency_key, run_id, scope_id, state, deadline_at, try_vertex_id, try_seq, confirm_tool, cancel_tool, compensate_tool, input, retry_policy, tool_view_digest,
                                 confirm_input, cancel_input)
        VALUES (bracket_key, NEW.run_id, NEW.scope_id, 'sealed', (NEW.payload->>'deadline_at')::TIMESTAMPTZ, NEW.vertex_id, NEW.run_seq,
                NEW.payload->>'confirm_tool', NEW.payload->>'cancel_tool', NEW.payload->>'compensate_tool', COALESCE(NEW.payload->'input', '{}'::JSONB),
                COALESCE(NEW.payload->'retry_policy', '{"max_attempts":1,"initial_backoff_ms":0,"multiplier":1,"max_backoff_ms":0}'::JSONB),
                NULLIF(NEW.payload->>'tool_view_digest', ''),
                NEW.payload->'confirm_input',
                COALESCE(NEW.payload->'cancel_input', NEW.payload->'compensate_input'));
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
            IF NOT EXISTS (
                SELECT 1 FROM txn_scope s
                WHERE s.scope_id = NEW.scope_id AND s.run_id = NEW.run_id
                  AND (s.cancel_requested_seq IS NOT NULL
                       OR EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = s.scope_id AND b.state = 'sealed' AND b.deadline_at < now()))
            ) THEN
                RAISE EXCEPTION 'scope % cancellation needs an engine request or an expired try', NEW.scope_id
                    USING HINT = 'failure-driven cancellation is initiated by the Engine with replan/cancel-requested';
            END IF;
            UPDATE txn_scope SET state = 'cancelling', cancel_idempotency_key = NEW.payload->>'idempotency_key', updated_at = now(),
                   cancel_request_outcome = CASE WHEN cancel_request_outcome IN ('pending', 'deferred') THEN 'requested' ELSE cancel_request_outcome END
            WHERE scope_id = NEW.scope_id AND run_id = NEW.run_id AND state = 'open';
            IF NOT FOUND THEN RAISE EXCEPTION 'scope cancel requires an open scope %', NEW.scope_id; END IF;
            INSERT INTO scope_cancel_member (run_id, scope_id, vertex_id, idempotency_key, inverse_tool, input, retry_policy, try_seq, dependency_depth, tool_view_digest)
            WITH RECURSIVE members AS (
                SELECT b.try_vertex_id AS vertex_id, b.idempotency_key, COALESCE(b.cancel_tool, b.compensate_tool) AS inverse_tool,
                       COALESCE(b.cancel_input, b.input) AS input, b.retry_policy, b.try_seq, b.tool_view_digest
                FROM txn_bracket b WHERE b.run_id = NEW.run_id AND b.scope_id = NEW.scope_id AND b.state = 'sealed'
                  AND COALESCE(b.cancel_tool, b.compensate_tool) IS NOT NULL
            ), paths(vertex_id, depth) AS (
                SELECT vertex_id, 0 FROM members
                UNION ALL
                SELECT child.vertex_id, paths.depth + 1 FROM paths
                JOIN run_event_log child ON child.run_id = NEW.run_id AND child.event_type = 'vertex/created' AND paths.vertex_id = ANY(child.parent_refs)
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
            UPDATE txn_scope SET state = 'cancelled', closed_seq = NEW.run_seq, updated_at = now()
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

-- ---------------------------------------------------------------------------------------------
-- 6. Shadowing waits for the cancellation, in the database
-- ---------------------------------------------------------------------------------------------
--
-- Identical to migration 016, plus the scope check. A replan that discards members of a scope the
-- Coordinator has materialized is resuming planning across whatever that scope still holds unless
-- the scope has closed -- cancelled, or committed. The ladder waits for exactly that; this is the
-- guard for a ladder that does not. A scope with no row never handed out work, so there is
-- nothing in it to undo.
CREATE OR REPLACE FUNCTION dequeue_shadowed_work() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    shadowed UUID[];
    leased UUID[];
    unclosed RECORD;
BEGIN
    IF NEW.event_type <> 'subgraph/shadowed' THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(array_agg(value::UUID), '{}')
      INTO shadowed
      FROM jsonb_array_elements_text(COALESCE(NEW.payload->'vertex_ids', '[]'::jsonb)) AS value;

    IF array_length(shadowed, 1) IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.scope_id, s.state INTO unclosed
      FROM txn_scope s
     WHERE s.run_id = NEW.run_id
       AND s.state NOT IN ('cancelled', 'committed')
       AND s.scope_id IN (
           SELECT e.scope_id FROM run_event_log e
            WHERE e.run_id = NEW.run_id AND e.event_type = 'vertex/created' AND e.vertex_id = ANY(shadowed) AND e.scope_id IS NOT NULL
       )
     ORDER BY s.opened_seq
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot shadow members of scope % while it is %', unclosed.scope_id, unclosed.state
            USING HINT = 'request the cancellation and wait for txn/cancel completed before replanning (design document 03 section 2.4)';
    END IF;

    -- Locked before the check so a claim cannot land between reading and
    -- deleting: `claim_work` takes the same rows FOR UPDATE SKIP LOCKED.
    PERFORM 1 FROM work_queue WHERE vertex_id = ANY(shadowed) FOR UPDATE;

    SELECT COALESCE(array_agg(vertex_id), '{}')
      INTO leased
      FROM work_queue
     WHERE vertex_id = ANY(shadowed) AND claimed_by IS NOT NULL;

    IF array_length(leased, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'cannot shadow % while its work is leased: %', NEW.run_id, leased
            USING HINT = 'cancel or let the in-flight attempt resolve before replanning (design document 03 section 2.4)';
    END IF;

    DELETE FROM work_queue WHERE vertex_id = ANY(shadowed);
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Scoped appends take the scope row first
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION append_scope_events(p_run_id UUID, p_scope_id UUID, p_events JSONB)
RETURNS TABLE(run_seq BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may append scoped events'; END IF;
    -- A scope with no row yet has nothing to serialize against; the append that creates it does.
    PERFORM 1 FROM txn_scope s WHERE s.run_id = p_run_id AND s.scope_id = p_scope_id FOR UPDATE;
    RETURN QUERY SELECT a.run_seq FROM append_events(p_run_id, p_events) a;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. A pivot proven absent reopens the scope already fenced
-- ---------------------------------------------------------------------------------------------
--
-- The `vertex/failed` that follows would fence it too, but that is a separate transaction, and in
-- between the scope would be open, unfenced, and claimable.
CREATE OR REPLACE FUNCTION resolve_pivot_absent(p_run_id UUID, p_scope_id UUID, p_vertex_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may resolve a pivot'; END IF;
    UPDATE txn_scope
       SET state = 'open', pivot_vertex_id = NULL, updated_at = now(),
           fenced_at = COALESCE(fenced_at, now()),
           fence_vertex_id = COALESCE(fence_vertex_id, p_vertex_id),
           fence_reason = COALESCE(fence_reason, 'pivot confirmed absent')
    WHERE run_id = p_run_id AND scope_id = p_scope_id AND state = 'pivot-inflight' AND pivot_vertex_id = p_vertex_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope % has no matching pivot-inflight action', p_scope_id; END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 9. A fenced scope hands out nothing and admits no pivot
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION flory_scope_claim_state(p_state TEXT, p_fenced_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_state = 'open' AND p_fenced_at IS NOT NULL THEN 'fenced' ELSE p_state END;
$$;

CREATE OR REPLACE FUNCTION claim_ready_work(p_worker TEXT, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, run_id UUID, scope_id UUID, parent_refs UUID[], payload JSONB, attempt INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE candidate RECORD; scope_state TEXT; scope_fenced TIMESTAMPTZ; claimed RECORD;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may claim work'; END IF;
    FOR candidate IN
        SELECT q.vertex_id, q.run_id, q.scope_id, q.payload FROM work_queue q
        WHERE q.executor_class = 'coordinator' AND q.ready_at <= now() AND (q.lease_until IS NULL OR q.lease_until < now())
          AND NOT EXISTS (
              SELECT 1 FROM unnest(q.parent_refs) parent_id
              WHERE NOT EXISTS (SELECT 1 FROM run_event_log e WHERE e.run_id = q.run_id AND e.vertex_id = parent_id AND e.event_type = 'vertex/succeeded')
          )
          AND flory_claim_admissible((SELECT flory_scope_claim_state(s.state, s.fenced_at) FROM txn_scope s WHERE s.scope_id = q.scope_id), q.payload)
        ORDER BY q.ready_at, q.vertex_id
        LIMIT 8
    LOOP
        IF candidate.scope_id IS NOT NULL THEN
            SELECT s.state, s.fenced_at INTO scope_state, scope_fenced FROM txn_scope s
            WHERE s.run_id = candidate.run_id AND s.scope_id = candidate.scope_id FOR UPDATE;
            IF FOUND AND NOT flory_claim_admissible(flory_scope_claim_state(scope_state, scope_fenced), candidate.payload) THEN CONTINUE; END IF;
        END IF;
        UPDATE work_queue q
           SET claimed_by = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds), attempt = q.attempt + 1
         WHERE q.vertex_id = (
             SELECT w.vertex_id FROM work_queue w
             WHERE w.vertex_id = candidate.vertex_id AND (w.lease_until IS NULL OR w.lease_until < now())
             FOR UPDATE SKIP LOCKED
         )
        RETURNING q.vertex_id, q.run_id, q.scope_id, q.parent_refs, q.payload, q.attempt INTO claimed;
        IF FOUND THEN
            vertex_id := claimed.vertex_id;
            run_id := claimed.run_id;
            scope_id := claimed.scope_id;
            parent_refs := claimed.parent_refs;
            payload := claimed.payload;
            attempt := claimed.attempt;
            RETURN NEXT;
            RETURN;
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION admit_pivot(p_run_id UUID, p_scope_id UUID, p_vertex_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE required_count INTEGER; sealed_count INTEGER;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may admit a pivot'; END IF;
    PERFORM 1 FROM txn_scope WHERE run_id = p_run_id AND scope_id = p_scope_id AND state = 'open' AND fenced_at IS NULL FOR UPDATE;
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

-- The Engine's freeze and recovery both read this under the lock; the fence is part of what they
-- must see, because a fenced scope refuses a freeze exactly as a cancelling one does.
DROP FUNCTION IF EXISTS lock_run_scopes(UUID);

CREATE FUNCTION lock_run_scopes(p_run_id UUID)
RETURNS TABLE(scope_id UUID, state TEXT, pivot_count INTEGER, has_sealed_try BOOLEAN, has_expired_try BOOLEAN, fenced BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user NOT IN ('engine_role', 'coordinator_role') THEN RAISE EXCEPTION 'only an executor role may lock run scopes'; END IF;
    RETURN QUERY
    WITH locked AS (
        SELECT s.scope_id, s.state, (s.pivot_vertex_id IS NOT NULL)::INTEGER AS pivots, s.fenced_at IS NOT NULL AS is_fenced
        FROM txn_scope s WHERE s.run_id = p_run_id ORDER BY s.opened_seq FOR UPDATE
    )
    SELECT l.scope_id, l.state, l.pivots,
           EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = l.scope_id AND b.state = 'sealed'),
           EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = l.scope_id AND b.state = 'sealed' AND b.deadline_at < now()),
           l.is_fenced
    FROM locked l;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 10. The cancellation decision, now with an origin
-- ---------------------------------------------------------------------------------------------
--
--   duplicate  -- already cancelling or cancelled under the scope's one key; the caller resumes
--   suspended  -- an attempt is unresolved (the scope escalates to L4 with its evidence and its
--                reservations intact), or an engine request found the scope already suspended
--   ineligible -- a timeout candidate whose expired try is no longer there under the lock
--   deferred   -- a live lease exists; an engine request stays pending and is retried
--   requested  -- clean: `txn/cancel {requested}` is appended and pending work goes with it
--
-- No lease is excluded any more. The worker that recorded a failure used to ask inline, holding
-- its own row; neither the engine-request path nor the sweep holds one, so the exclusion could
-- only hide two processes sharing a worker id.
DROP FUNCTION IF EXISTS request_scope_cancel(TEXT, UUID, UUID, TEXT, TEXT);

CREATE FUNCTION request_scope_cancel(p_worker TEXT, p_run_id UUID, p_scope_id UUID, p_key TEXT, p_reason TEXT, p_origin TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE scope_state TEXT; existing_key TEXT; requested_seq BIGINT;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may request cancellation'; END IF;
    IF p_origin NOT IN ('engine', 'timeout') THEN RAISE EXCEPTION 'unknown cancellation origin %', p_origin; END IF;
    SELECT s.state, s.cancel_idempotency_key, s.cancel_requested_seq INTO scope_state, existing_key, requested_seq FROM txn_scope s
    WHERE s.run_id = p_run_id AND s.scope_id = p_scope_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown transaction scope %', p_scope_id; END IF;

    IF scope_state IN ('cancelling', 'cancelled') THEN
        IF existing_key IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'scope % has a different cancel idempotency key', p_scope_id; END IF;
        UPDATE txn_scope SET cancel_request_outcome = 'duplicate', updated_at = now()
        WHERE scope_id = p_scope_id AND cancel_request_outcome IN ('pending', 'deferred');
        RETURN 'duplicate';
    END IF;
    IF scope_state = 'suspended' AND p_origin = 'engine' AND requested_seq IS NOT NULL THEN
        UPDATE txn_scope SET cancel_request_outcome = 'suspended', updated_at = now()
        WHERE scope_id = p_scope_id AND cancel_request_outcome IN ('pending', 'deferred');
        RETURN 'suspended';
    END IF;
    IF scope_state <> 'open' THEN RAISE EXCEPTION 'cannot cancel scope % in state %', p_scope_id, scope_state; END IF;
    IF p_origin = 'engine' AND requested_seq IS NULL THEN
        RAISE EXCEPTION 'failure-driven cancellation of scope % requires an engine request', p_scope_id;
    END IF;
    IF p_origin = 'timeout' AND NOT EXISTS (
        SELECT 1 FROM txn_bracket b WHERE b.run_id = p_run_id AND b.scope_id = p_scope_id AND b.state = 'sealed' AND b.deadline_at < now()
    ) THEN
        RETURN 'ineligible';
    END IF;

    IF EXISTS (SELECT 1 FROM work_queue q WHERE q.run_id = p_run_id AND q.scope_id = p_scope_id AND q.lease_until > now()) THEN
        UPDATE txn_scope SET cancel_request_outcome = 'deferred', cancel_request_next_at = now() + interval '1 second', updated_at = now()
        WHERE scope_id = p_scope_id AND cancel_request_outcome IN ('pending', 'deferred');
        RETURN 'deferred';
    END IF;

    IF EXISTS (SELECT 1 FROM txn_attempt a WHERE a.run_id = p_run_id AND a.scope_id = p_scope_id AND a.outcome IS NULL) THEN
        PERFORM append_events(p_run_id, jsonb_build_array(jsonb_build_object(
            'event_type', 'txn/scope', 'scope_id', p_scope_id,
            'payload', jsonb_build_object('state', 'suspended', 'reason', 'unresolved attempt', 'detail', p_reason))));
        RETURN 'suspended';
    END IF;

    PERFORM append_events(p_run_id, jsonb_build_array(jsonb_build_object(
        'event_type', 'txn/cancel', 'scope_id', p_scope_id,
        'payload', jsonb_build_object('idempotency_key', p_key, 'phase', 'requested', 'reason', p_reason))));
    -- Pending ordinary work goes with the fence, in this same transaction, so nothing queued
    -- before the cancellation can be claimed after it. A live lease was refused above, so every
    -- row left in the scope is unclaimed or expired.
    DELETE FROM work_queue q WHERE q.vertex_id IN (
        SELECT w.vertex_id FROM work_queue w
        WHERE w.run_id = p_run_id AND w.scope_id = p_scope_id AND (w.lease_until IS NULL OR w.lease_until <= now())
        FOR UPDATE SKIP LOCKED
    );
    -- Whichever origin got here first, the append above has already answered a pending engine
    -- request: the projection resolves it on the state change.
    RETURN 'requested';
END;
$$;

GRANT EXECUTE ON FUNCTION append_scope_events(UUID, UUID, JSONB), request_scope_cancel(TEXT, UUID, UUID, TEXT, TEXT, TEXT) TO coordinator_role;
GRANT EXECUTE ON FUNCTION lock_run_scopes(UUID) TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION flory_scope_claim_state(TEXT, TIMESTAMPTZ) TO engine_role, coordinator_role;
