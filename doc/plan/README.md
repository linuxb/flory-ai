# Planning Documents

This directory holds one document: [`outstanding-work.md`](./outstanding-work.md), the backlog of work that is specified but not yet delivered.

A plan says *how and when* something gets built. An architecture change begins as a proposal in [`doc/adr/`](../adr/) and, once accepted, its authoritative requirements live only in the [design documents](../design/) — so a plan must never restate a requirement, only schedule it.

Each work stream records its trigger, scope, delivery increments, exit criteria, and exclusions, and names the design documents it implements. A trigger is an objective event, never "when we have time".

When a work stream is delivered, its section is deleted rather than marked done. The requirements survive in the design documents and the delivery record survives in Git history, so a completed section would be a third copy that can only drift. Accepting a new ADR adds a section here instead of creating another file.

All planning documents are written in English.
