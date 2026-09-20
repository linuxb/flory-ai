-- Durable attempt evidence, one lock order, and claim eligibility by scope state.
--
-- Three changes that only make sense together. A lease expiry proves that a worker stopped
-- renewing; it proves nothing about the external request. Until there is a durable record of a
-- request having started, the sweeper cannot tell "the worker died before sending" from "the
-- effect happened and nobody wrote it down", so it either cancels reservations that may still be
-- backing a real effect or never cancels anything. txn_attempt is that record; claim eligibility
-- and the single lock order are what make the sweeper's decision race-free once it can be taken
-- at all (02 4.4, 07 3.1, 07 3.4, 08 3).

-- ---------------------------------------------------------------------------------------------
-- 1. Attempt evidence
-- ---------------------------------------------------------------------------------------------
--
-- A row with a start and no outcome is UNRESOLVED. Nothing else resolves it: not queue deletion,
-- not lease expiry, not a transport timeout. 'unknown' is deliberately absent from the outcome
-- vocabulary -- an unknown answer is the absence of an answer, and recording it as one would be
-- exactly the mistake the table exists to prevent.

CREATE TABLE txn_attempt (
    attempt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES run(run_id),
    scope_id UUID REFERENCES txn_scope(scope_id),
    vertex_id UUID NOT NULL,
    -- Which leg of the protocol this request is. The scope states each one may start in differ,
    -- so the operation is what record_attempt_start validates against.
    operation TEXT NOT NULL CHECK (operation IN ('call', 'pivot', 'status', 'confirm', 'inverse')),
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    tool TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    worker TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome TEXT CHECK (outcome IN ('succeeded', 'retryable-failure', 'permanent-failure', 'confirmed-absent')),
    detail TEXT,
    resolved_at TIMESTAMPTZ,
    CONSTRAINT txn_attempt_resolution_chk CHECK ((outcome IS NULL) = (resolved_at IS NULL))
);

CREATE INDEX txn_attempt_unresolved_idx ON txn_attempt (run_id, scope_id) WHERE outcome IS NULL;
CREATE INDEX txn_attempt_vertex_idx ON txn_attempt (run_id, vertex_id, started_at);

-- work_queue is now read by scope on the cancellation path.
CREATE INDEX work_queue_scope_idx ON work_queue (run_id, scope_id) WHERE scope_id IS NOT NULL;

-- Records one side-effecting request before it leaves the executor.
--
-- The scope state and the executor's lease are validated in the same transaction that writes the
-- evidence, so a worker whose lease has already been taken over cannot add a start the sweeper
-- would then have to respect. The lock order is the schema's: txn_scope first, the queue row
-- second.
CREATE OR REPLACE FUNCTION record_attempt_start(
    p_worker TEXT, p_run_id UUID, p_scope_id UUID, p_vertex_id UUID, p_operation TEXT, p_attempt_no INTEGER,
    p_tool TEXT, p_idempotency_key TEXT, p_lease_vertex_id UUID, p_lease_source TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE admissible TEXT[]; scope_state TEXT; leased BOOLEAN; recorded BIGINT;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may record an attempt'; END IF;
    admissible := CASE p_operation
        WHEN 'call' THEN ARRAY['open', 'pivot-passed', 'committed']
        WHEN 'pivot' THEN ARRAY['pivot-inflight']
        WHEN 'status' THEN ARRAY['pivot-inflight']
        WHEN 'confirm' THEN ARRAY['pivot-passed']
        WHEN 'inverse' THEN ARRAY['cancelling']
        ELSE NULL
    END;
    IF admissible IS NULL THEN RAISE EXCEPTION 'unknown attempt operation %', p_operation; END IF;

    IF p_scope_id IS NOT NULL THEN
        SELECT s.state INTO scope_state FROM txn_scope s WHERE s.run_id = p_run_id AND s.scope_id = p_scope_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'unknown transaction scope %', p_scope_id; END IF;
        IF NOT (scope_state = ANY(admissible)) THEN
            RAISE EXCEPTION 'a % attempt requires scope % in one of %, not %', p_operation, p_scope_id, admissible, scope_state;
        END IF;
    END IF;

    IF p_lease_source = 'work_queue' THEN
        SELECT true INTO leased FROM work_queue q
        WHERE q.vertex_id = p_lease_vertex_id AND q.claimed_by = p_worker AND q.lease_until > now() FOR UPDATE;
    ELSIF p_lease_source = 'cancel_member' THEN
        SELECT true INTO leased FROM scope_cancel_member m
        WHERE m.run_id = p_run_id AND m.scope_id = p_scope_id AND m.vertex_id = p_lease_vertex_id
          AND m.claimed_by = p_worker AND m.lease_until > now() FOR UPDATE;
    ELSE
        RAISE EXCEPTION 'unknown attempt lease source %', p_lease_source;
    END IF;
    IF NOT COALESCE(leased, false) THEN
        RAISE EXCEPTION 'worker % holds no live % lease for vertex %', p_worker, p_lease_source, p_lease_vertex_id;
    END IF;

    INSERT INTO txn_attempt (run_id, scope_id, vertex_id, operation, attempt_no, tool, idempotency_key, worker)
    VALUES (p_run_id, p_scope_id, p_vertex_id, p_operation, p_attempt_no, p_tool, p_idempotency_key, p_worker)
    RETURNING attempt_id INTO recorded;
    RETURN recorded;
END;
$$;

-- Writes the definitive outcome of one recorded attempt.
--
-- Only a definitive answer is passed here; an unknown one leaves the row unresolved on purpose. A
-- late outcome for an attempt whose scope already suspended is still recorded, because it is
-- evidence an operator needs -- and it authorizes nothing, since a suspended scope is neither
-- cancellable nor claimable.
CREATE OR REPLACE FUNCTION resolve_attempt(p_worker TEXT, p_attempt_id BIGINT, p_outcome TEXT, p_detail TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may resolve an attempt'; END IF;
    UPDATE txn_attempt SET outcome = p_outcome, detail = NULLIF(p_detail, ''), resolved_at = now()
    WHERE attempt_id = p_attempt_id AND outcome IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. One lock order, and claim eligibility by scope state
-- ---------------------------------------------------------------------------------------------
--
-- The previous definition locked work_queue and never touched txn_scope, which is the reverse of
-- the order admit_pivot and request_scope_cancel take and of the order the documents state. Two
-- changes fix it. Candidate discovery reads without locking anything, and the authoritative
-- decision is taken under txn_scope FOR UPDATE before the queue row is locked at all. Eligibility
-- then follows the operation's frozen phase: 'open' carries new pre-pivot member work, while
-- 'pivot-passed' and 'committed' carry forward work already admitted at freeze. 'pivot-inflight'
-- belongs to the admitted pivot, 'suspended' waits for a person, and ordinary work never runs in
-- 'cancelling' or 'cancelled'.
--
-- The loop exists because eligibility cannot be settled by the discovery query: the unlocked
-- prefilter below may see a scope state that changes before the lock is taken, so it is an
-- optimization and never the decision.
-- Eligibility as one expression, so the unlocked prefilter and the decision under the lock cannot
-- drift apart. 'open' carries new pre-pivot member work. A post-pivot scope carries only forward
-- work that was already admitted at freeze: a fresh try would seal a bracket the pivot has already
-- passed, and a second irreversible call would be a second pivot, so both are refused by phase
-- even though their scope still exists. Everything else -- 'pivot-inflight' reserved for the
-- admitted pivot, 'suspended' waiting for a person, 'cancelling' and 'cancelled' -- carries no
-- ordinary work at all.
CREATE OR REPLACE FUNCTION flory_claim_admissible(p_scope_state TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_scope_state IS NULL THEN true
        WHEN p_scope_state = 'open' THEN true
        WHEN p_scope_state IN ('pivot-passed', 'committed')
            THEN COALESCE(p_payload->'txn'->>'mode', 'plain') NOT IN ('tcc', 'saga')
             AND COALESCE(p_payload->'txn'->>'effect_class', 'none') <> 'irreversible'
        ELSE false
    END;
$$;

DROP FUNCTION IF EXISTS claim_ready_work(TEXT, INTEGER);

CREATE FUNCTION claim_ready_work(p_worker TEXT, p_lease_seconds INTEGER DEFAULT 30)
RETURNS TABLE(vertex_id UUID, run_id UUID, scope_id UUID, parent_refs UUID[], payload JSONB, attempt INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE candidate RECORD; scope_state TEXT; claimed RECORD;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may claim work'; END IF;
    FOR candidate IN
        SELECT q.vertex_id, q.run_id, q.scope_id, q.payload FROM work_queue q
        WHERE q.executor_class = 'coordinator' AND q.ready_at <= now() AND (q.lease_until IS NULL OR q.lease_until < now())
          AND NOT EXISTS (
              SELECT 1 FROM unnest(q.parent_refs) parent_id
              WHERE NOT EXISTS (SELECT 1 FROM run_event_log e WHERE e.run_id = q.run_id AND e.vertex_id = parent_id AND e.event_type = 'vertex/succeeded')
          )
          AND flory_claim_admissible((SELECT s.state FROM txn_scope s WHERE s.scope_id = q.scope_id), q.payload)
        ORDER BY q.ready_at, q.vertex_id
        LIMIT 8
    LOOP
        IF candidate.scope_id IS NOT NULL THEN
            -- A scope with no row yet is a vertex whose first claim will create it; there is
            -- nothing to serialize against until then.
            SELECT s.state INTO scope_state FROM txn_scope s
            WHERE s.run_id = candidate.run_id AND s.scope_id = candidate.scope_id FOR UPDATE;
            IF FOUND AND NOT flory_claim_admissible(scope_state, candidate.payload) THEN CONTINUE; END IF;
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

-- ---------------------------------------------------------------------------------------------
-- 3. The sweeper's decision, taken under the scope lock
-- ---------------------------------------------------------------------------------------------
--
-- A candidate is not a decision. The earlier query result is never trusted: under txn_scope FOR
-- UPDATE this function re-verifies the state, the live leases and the unresolved attempts, and
-- returns which of the three paths it took, so the caller cannot take a fourth.
--
--   deferred  -- a live execution lease exists; progress is defined by a lease, not by queue
--               occupancy, and the holder may still be making progress
--   suspended -- an attempt is unresolved; the queue and the evidence are preserved and the scope
--               escalates to L4 rather than releasing reservations that may back a real effect
--   requested -- an expired sealed try, no live lease and no unresolved attempt: the only
--               configuration that may cancel on its own
--   duplicate -- already fenced under this same idempotency key; the caller resumes the loop
--
-- The caller's own lease is excluded, because the worker that just recorded a terminal failure is
-- the one asking: its lease is evidence that it is here, not that someone else is still running.
DROP FUNCTION IF EXISTS request_scope_cancel(UUID, UUID, TEXT, TEXT);

CREATE FUNCTION request_scope_cancel(p_worker TEXT, p_run_id UUID, p_scope_id UUID, p_key TEXT, p_reason TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE scope_state TEXT; existing_key TEXT;
BEGIN
    IF session_user <> 'coordinator_role' THEN RAISE EXCEPTION 'only coordinator_role may request cancellation'; END IF;
    SELECT s.state, s.cancel_idempotency_key INTO scope_state, existing_key FROM txn_scope s
    WHERE s.run_id = p_run_id AND s.scope_id = p_scope_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown transaction scope %', p_scope_id; END IF;
    IF scope_state IN ('cancelling', 'cancelled') THEN
        IF existing_key IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'scope % has a different cancel idempotency key', p_scope_id; END IF;
        RETURN 'duplicate';
    END IF;
    IF scope_state <> 'open' THEN RAISE EXCEPTION 'cannot cancel scope % in state %', p_scope_id, scope_state; END IF;

    IF EXISTS (
        SELECT 1 FROM work_queue q
        WHERE q.run_id = p_run_id AND q.scope_id = p_scope_id AND q.lease_until > now() AND q.claimed_by IS DISTINCT FROM p_worker
    ) THEN
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
    -- before the cancellation can be claimed after it. Attempt history and every recorded effect
    -- the inverse operations will need stay untouched. The caller's own row is left for its
    -- ordinary completion.
    DELETE FROM work_queue q WHERE q.vertex_id IN (
        SELECT w.vertex_id FROM work_queue w
        WHERE w.run_id = p_run_id AND w.scope_id = p_scope_id
          AND (w.claimed_by IS DISTINCT FROM p_worker OR w.lease_until IS NULL OR w.lease_until <= now())
        FOR UPDATE SKIP LOCKED
    );
    RETURN 'requested';
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The same lock order for branch admission
-- ---------------------------------------------------------------------------------------------
--
-- The Engine freezes a router-emitted branch into a run whose scopes the Coordinator is
-- concurrently claiming and cancelling. Reading the scope state without a lock and appending
-- afterwards lets a branch be admitted into a scope that is already fencing, so admission takes
-- the same txn_scope FOR UPDATE first and appends -- which queues the branch's work through the
-- enqueue trigger -- inside that one transaction.
--
-- Rows are locked in opened_seq order, the same order every caller uses, so two concurrent
-- freezes cannot build a cycle between them.
CREATE OR REPLACE FUNCTION lock_run_scopes(p_run_id UUID)
RETURNS TABLE(scope_id UUID, state TEXT, pivot_count INTEGER, has_sealed_try BOOLEAN, has_expired_try BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user NOT IN ('engine_role', 'coordinator_role') THEN RAISE EXCEPTION 'only an executor role may lock run scopes'; END IF;
    RETURN QUERY
    WITH locked AS (
        SELECT s.scope_id, s.state, (s.pivot_vertex_id IS NOT NULL)::INTEGER AS pivots
        FROM txn_scope s WHERE s.run_id = p_run_id ORDER BY s.opened_seq FOR UPDATE
    )
    SELECT l.scope_id, l.state, l.pivots,
           EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = l.scope_id AND b.state = 'sealed'),
           EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = l.scope_id AND b.state = 'sealed' AND b.deadline_at < now())
    FROM locked l;
END;
$$;

-- These follow migration 004's convention rather than 001's: the session_user guard inside each
-- function is the boundary, and it is left reachable so that a wrong-role call is refused by name
-- instead of by a generic permission error.
REVOKE ALL ON txn_attempt FROM PUBLIC;
GRANT SELECT ON txn_attempt TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION record_attempt_start(TEXT, UUID, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, UUID, TEXT),
    resolve_attempt(TEXT, BIGINT, TEXT, TEXT), claim_ready_work(TEXT, INTEGER),
    request_scope_cancel(TEXT, UUID, UUID, TEXT, TEXT) TO coordinator_role;
GRANT EXECUTE ON FUNCTION lock_run_scopes(UUID) TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION flory_claim_admissible(TEXT, JSONB) TO engine_role, coordinator_role;
