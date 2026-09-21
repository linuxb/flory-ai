-- Shadowing a subtree removes its unstarted work from the queue.
--
-- `enqueue_vertex_work` inserts a row for every tool and confirmation-barrier
-- `vertex/created`, and until now nothing ever took one out except the executor
-- that ran it. A replan shadows work precisely so it will not run, so without
-- this a discarded subtree stays claimable and the Coordinator executes it
-- minutes later -- against a plan the engine has already abandoned, with no
-- event anywhere saying why. The surface would not show the vertex and the
-- world would still change.
--
-- A leased row is a different matter and is refused rather than deleted.
-- Deleting one races the worker holding it: the lease is how the queue and the
-- executor agree on who owns a vertex, and removing the row underneath a worker
-- that is mid-call would let the call land with nothing recording that it did.
-- Design document 03 section 2.4 already requires cancel-before-replan, so a
-- caller reaching this state has skipped a step in the ladder, and the honest
-- answer is to refuse the shadow rather than to half-perform it.
CREATE OR REPLACE FUNCTION dequeue_shadowed_work() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    shadowed UUID[];
    leased UUID[];
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

CREATE TRIGGER run_event_log_dequeue_shadowed
    AFTER INSERT ON run_event_log
    FOR EACH ROW EXECUTE FUNCTION dequeue_shadowed_work();
