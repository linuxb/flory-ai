CREATE OR REPLACE FUNCTION lock_fork_source(p_run_id UUID) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tail_end BIGINT;
BEGIN
    IF session_user <> 'engine_role' THEN RAISE EXCEPTION 'only engine_role may lock a fork source'; END IF;
    SELECT next_seq - 1 INTO tail_end FROM run WHERE run_id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source run % does not exist', p_run_id; END IF;
    RETURN tail_end;
END;
$$;

REVOKE ALL ON FUNCTION lock_fork_source(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_fork_source(UUID) TO engine_role;
