# Plan 005: Gateway-Owned RBAC

- **Status:** Done
- **Date:** 2026-09-06
- **Implements:** [09 §3.3 Role-Based Access Control](../design/09-tool-registry-gateway.md#33-role-based-access-control-rbac)
- **Specifies:** [09 gatewayd Tool Registry Gateway](../design/09-tool-registry-gateway.md), [08 Database Schema](../design/08-database-schema.md), [01 Event Log §3.2](../design/01-jit-dag-and-event-log.md#32-event-types)

## 1. Objective

Make `gatewayd` the only authority that maps an OIDC identity to business roles. Keep identity proof in the OIDC provider, tool policy in immutable registry contracts, and role administration in a Gateway-owned PostgreSQL schema.

## 2. Delivery Increments

1. Add identity-only OIDC Discovery, JWT verification, bounded JWKS caching, unknown-key refresh, and a strict algorithm allowlist.
2. Add revisioned roles, `(issuer, subject)` bindings, grant/revoke history, append-only audit, idempotent security-definer mutations, and a dedicated database role.
3. Protect the administrative API with CA-verified client certificates and allowlisted SPIFFE URI SANs.
4. Add non-empty `allowed_roles` to the shared tool contract, Tool View v2, both SDKs, admission, companion-closure checks, and cross-language fixtures.
5. Return role-scoped views and reject unauthorized execution before argument validation or route dispatch.
6. Issue Ed25519-signed, run-bound role snapshots only to an authenticated user plus an allowlisted Orchestrator mTLS identity.
7. Record the signed identity in `run/start`, project it for executor recovery, and propagate it through every normal and transaction-recovery Gateway call.
8. Add fake-provider tests and a local Keycloak, PKI, PostgreSQL, and Gateway scenario proving immediate revoke for new work and uninterrupted recovery for an existing run.

## 3. Exit Criteria

- JWT role-like claims never affect authorization, and identical subjects from different issuers never share bindings.
- Role mutation is CAS-protected, idempotent, and audited atomically; active binding lookup never uses a local role cache.
- Tool permissions are canonical across Go and TypeScript, and every recovery companion covers its initiating tool's roles.
- Authentication and authorization rejection occurs before schema validation and dispatch.
- Revocation blocks the next external request and every new run while a valid retained signing key lets an existing run complete after JWT expiry or Gateway restart.
- Local fake-OIDC, PostgreSQL integration, and real-Keycloak scenarios pass alongside the existing TypeScript, Go, and formal verification suites.

## 4. Exclusions

Emergency termination of already admitted runs, a workflow-identity denylist, multi-issuer routing, registry gRPC mTLS, and production inventory, payment, logistics, or channel integrations remain separate work.
