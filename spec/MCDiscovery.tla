---------------------------- MODULE MCDiscovery ---------------------------
EXTENDS FloryTxn

\* The same protocol without its episode cap. TLC must find the alternating
\* planner liveness cycle; run-tlc.sh treats that counterexample as evidence.

=============================================================================
