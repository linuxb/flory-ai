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
