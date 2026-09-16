-- The business plane: what one entity experienced, across all of its runs.
--
-- A run and a business entity are different lifetimes. An order is placed, paid, returned and
-- refunded across four separate runs, so folding its history out of the run plane means
-- correlating runs by hand in every domain reducer. The data plane orders those facts by
-- stream_seq instead, and each row carries the (run_id, run_seq) that produced it.
--
-- Partitioning by stream_id is what makes PRIMARY KEY (stream_id, stream_seq) expressible at all:
-- PostgreSQL requires every partition-key column to appear in a unique constraint, so the same key
-- on a run_id-partitioned table would have to include run_id and would stop being unique per
-- entity, which is the whole point.
--
-- Lock order, extending the chain the rest of the schema already keeps:
--     run -> stream -> txn_scope -> work_queue
-- append_domain_events reaches the run lock through append_events before it touches stream, so the
-- order holds by construction rather than by convention.

CREATE TABLE stream (
    stream_id TEXT PRIMARY KEY CHECK (stream_id <> ''),
    next_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_event_stream (
    stream_id TEXT NOT NULL REFERENCES stream(stream_id),
    stream_seq BIGINT NOT NULL CHECK (stream_seq >= 1),
    global_seq BIGINT GENERATED ALWAYS AS IDENTITY,
    run_id UUID NOT NULL REFERENCES run(run_id),
    run_seq BIGINT NOT NULL CHECK (run_seq >= 1),
    event_type TEXT NOT NULL,
    is_counterfactual BOOLEAN NOT NULL DEFAULT false,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (stream_id, stream_seq)
) PARTITION BY HASH (stream_id);

CREATE TABLE business_event_stream_p0 PARTITION OF business_event_stream FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE business_event_stream_p1 PARTITION OF business_event_stream FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE business_event_stream_p2 PARTITION OF business_event_stream FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE business_event_stream_p3 PARTITION OF business_event_stream FOR VALUES WITH (MODULUS 4, REMAINDER 3);
CREATE INDEX business_event_stream_type_idx ON business_event_stream (stream_id, event_type, stream_seq);
CREATE INDEX business_event_stream_provenance_idx ON business_event_stream (run_id, run_seq);

-- No composite foreign key to (run_id, run_seq): it would install cross-partition constraint
-- triggers on every domain append to re-validate a row the same function inserted one statement
-- earlier. REFERENCES run(run_id) plus the CHECK above buys the useful half at a fraction of the
-- cost.
--
-- No ownership trigger on business_event_stream yet. flory_event_owner maps orchestration event
-- types, and no domain vocabulary exists to check against; a permissive stub would be read as
-- enforcement. The one specified data-plane rule -- the configuration stream carries only
-- rule_template/published, from engine_role alone -- lands with the router work that introduces
-- that event type.

CREATE OR REPLACE FUNCTION create_stream(p_stream_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may create streams'; END IF;
    IF COALESCE(p_stream_id, '') = '' THEN RAISE EXCEPTION 'stream id must be non-empty'; END IF;
    INSERT INTO stream (stream_id) VALUES (p_stream_id) ON CONFLICT (stream_id) DO NOTHING;
END;
$$;

-- One orchestration event and the business facts it caused, in one transaction. The pair is
-- deliberate: a fact's provenance is the step that produced it, so taking an event array would
-- leave "which event caused this fact" to a positional convention nothing checks. An
-- orchestration-only append keeps using append_events and never touches a stream row.
CREATE OR REPLACE FUNCTION append_domain_events(p_run_id UUID, p_stream_id TEXT, p_event JSONB, p_facts JSONB)
RETURNS TABLE(run_seq BIGINT, stream_seq BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE fact JSONB; caused_by BIGINT; allocated BIGINT; fork_run BOOLEAN;
BEGIN
    IF session_user NOT IN ('engine_role', 'coordinator_role') THEN
        RAISE EXCEPTION 'only engine_role or coordinator_role may append domain events';
    END IF;
    IF COALESCE(p_stream_id, '') = '' THEN RAISE EXCEPTION 'append_domain_events requires a stream id'; END IF;
    IF jsonb_typeof(p_facts) <> 'array' OR jsonb_array_length(p_facts) = 0 THEN
        RAISE EXCEPTION 'append_domain_events requires at least one business fact; use append_events for orchestration-only appends';
    END IF;

    -- Counterfactual isolation has two halves, and both are derived rather than declared: the
    -- synthetic namespace keeps the sequences apart, and the flag keeps a query that forgets the
    -- namespace honest. seed_floor is the authoritative record that this run is a fork, so a
    -- caller can neither launder a counterfactual into a live entity nor mark a real fact simulated.
    SELECT seed_floor IS NOT NULL INTO fork_run FROM run WHERE run_id = p_run_id;
    IF fork_run IS NULL THEN RAISE EXCEPTION 'run % does not exist', p_run_id; END IF;
    IF fork_run AND p_stream_id NOT LIKE 'fork:%' THEN
        RAISE EXCEPTION 'fork run % may only write a fork: stream, not %', p_run_id, p_stream_id;
    END IF;
    IF NOT fork_run AND p_stream_id LIKE 'fork:%' THEN
        RAISE EXCEPTION 'only a fork run may write the fork: namespace';
    END IF;

    -- Orchestration plane first: append_events takes run FOR UPDATE, which fixes the lock order.
    SELECT a.run_seq INTO caused_by FROM append_events(p_run_id, jsonb_build_array(p_event)) AS a;

    -- ON CONFLICT DO UPDATE, never DO NOTHING: DO NOTHING does not block on a concurrent
    -- uncommitted insert of the same key, so the allocation below could match zero rows and
    -- allocate NULL on first use of a busy stream.
    INSERT INTO stream (stream_id) VALUES (p_stream_id)
    ON CONFLICT (stream_id) DO UPDATE SET next_seq = stream.next_seq;

    FOR fact IN SELECT value FROM jsonb_array_elements(p_facts) LOOP
        IF COALESCE(fact->>'event_type', '') = '' THEN
            RAISE EXCEPTION 'every business fact requires an event_type';
        END IF;
        UPDATE stream SET next_seq = next_seq + 1 WHERE stream_id = p_stream_id RETURNING next_seq - 1 INTO allocated;
        INSERT INTO business_event_stream (stream_id, stream_seq, run_id, run_seq, event_type, is_counterfactual, payload)
        VALUES (p_stream_id, allocated, p_run_id, caused_by, fact->>'event_type', fork_run, COALESCE(fact->'payload', '{}'::JSONB));
        run_seq := caused_by; stream_seq := allocated; RETURN NEXT;
    END LOOP;
END;
$$;

REVOKE ALL ON stream, business_event_stream FROM PUBLIC;
REVOKE ALL ON FUNCTION create_stream(TEXT), append_domain_events(UUID, TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT SELECT ON stream, business_event_stream TO engine_role, coordinator_role;
GRANT EXECUTE ON FUNCTION create_stream(TEXT) TO engine_role;
GRANT EXECUTE ON FUNCTION append_domain_events(UUID, TEXT, JSONB, JSONB) TO engine_role, coordinator_role;
