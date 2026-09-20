-- The Console reads the run event log and nothing else.
--
-- Design document 11 section 5 says the Console writes nothing. That is stated
-- here as a grant rather than left to the type system: a narrow interface is
-- widened by whoever needs it next, and a missing privilege is not.
--
-- The grant list is the whole of what the observability projection touches.
-- `readStream` and `readStreamAfter` read `run_event_log`; `run` supplies the
-- run list its created_at and its counterfactual flag. It has no rights on the
-- business plane, on the transaction projections, or on the work queue --
-- deliberately, because the projection derives scope and pivot state from the
-- log rather than reading those tables, and a privilege it does not need is a
-- privilege that outlives the reason it was granted.
GRANT USAGE ON SCHEMA public TO console_role;
GRANT SELECT ON run_event_log TO console_role;
GRANT SELECT ON run TO console_role;

-- Partitions do not inherit a grant made on the partitioned table in every
-- PostgreSQL path, so name them. A missed partition would read as an empty run
-- for exactly the hash bucket it covers, which is the worst kind of wrong: it
-- looks like a run with nothing in it.
GRANT SELECT ON run_event_log_p0, run_event_log_p1, run_event_log_p2, run_event_log_p3 TO console_role;
