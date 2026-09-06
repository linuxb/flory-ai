#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cache_dir="$repo_dir/.cache/rbac-e2e"
gateway_url="https://127.0.0.1:18092"
gateway_grpc_url="http://127.0.0.1:18093"
sandbox_url="http://127.0.0.1:18090"
issuer="http://127.0.0.1:8180/realms/flory"
alice_subject="11111111-1111-4111-8111-111111111111"
rbac_database_url="${GATEWAYD_DATABASE_URL:-postgresql://gateway_role:gateway-dev-password@127.0.0.1:5432/flory}"
gateway_pid=""
sandbox_pid=""

stop_process() {
    local pid="$1"
    kill "$pid" 2>/dev/null || return 0
    for _attempt in $(seq 1 20); do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null || true
            return 0
        fi
        sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    if [[ -n "$sandbox_pid" ]]; then stop_process "$sandbox_pid"; fi
    if [[ -n "$gateway_pid" ]]; then stop_process "$gateway_pid"; fi
    docker compose -f "$repo_dir/docker/compose.oidc.yml" down >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_for() {
    local description="$1"
    shift
    for _attempt in $(seq 1 180); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 0.25
    done
    printf '%s did not become ready\n' "$description" >&2
    return 1
}

admin_curl() {
    curl --fail --silent --show-error --cacert "$cache_dir/ca.pem" \
        --cert "$cache_dir/rbac-admin.pem" --key "$cache_dir/rbac-admin.key" "$@"
}

internal_curl() {
    curl --fail --silent --show-error --cacert "$cache_dir/ca.pem" \
        --cert "$cache_dir/coordinator.pem" --key "$cache_dir/coordinator.key" "$@"
}

cd "$repo_dir"
if [[ "${RBAC_E2E_USE_EXISTING_POSTGRES:-false}" != "true" ]]; then npm run db:up; fi
npm run db:setup
npm run rbac:pki
npm run oidc:up
wait_for Keycloak curl --fail --silent "$issuer/.well-known/openid-configuration"
go -C gatewayd build -o "$cache_dir/gatewayd" ./cmd/gatewayd

GATEWAYD_RBAC_ENABLED=true \
GATEWAYD_BLOB_BACKEND=memory \
GATEWAYD_HTTP_ADDR=127.0.0.1:18092 \
GATEWAYD_GRPC_ADDR=127.0.0.1:18093 \
GATEWAYD_DATABASE_URL="$rbac_database_url" \
GATEWAYD_OIDC_ISSUER="$issuer" \
GATEWAYD_OIDC_AUDIENCE=flory-gateway \
GATEWAYD_OIDC_ALLOWED_ALGS=RS256 \
GATEWAYD_OIDC_ALLOW_INSECURE_HTTP=true \
GATEWAYD_IDENTITY_KEY_ID=local-key \
GATEWAYD_IDENTITY_PRIVATE_KEY_FILE="$cache_dir/identity-private.pem" \
GATEWAYD_IDENTITY_KEYRING_DIR="$cache_dir/keyring" \
GATEWAYD_ORCHESTRATOR_SPIFFE_IDS=spiffe://flory.local/orchestrator \
GATEWAYD_INTERNAL_SPIFFE_IDS=spiffe://flory.local/orchestrator,spiffe://flory.local/coordinator \
GATEWAYD_ADMIN_SPIFFE_IDS=spiffe://flory.local/rbac-admin \
GATEWAYD_CLIENT_CA_FILE="$cache_dir/ca.pem" \
GATEWAYD_TLS_CERT_FILE="$cache_dir/gateway.pem" \
GATEWAYD_TLS_KEY_FILE="$cache_dir/gateway.key" \
"$cache_dir/gatewayd" >"$cache_dir/gateway.log" 2>&1 &
gateway_pid="$!"
wait_for gatewayd curl --fail --silent --cacert "$cache_dir/ca.pem" "$gateway_url/healthz"

admin_curl -X PUT "$gateway_url/admin/v1/roles/order-operator" \
    -H 'Content-Type: application/json' -H 'X-Request-ID: local-role' -H 'Idempotency-Key: local-role' \
    --data '{"description":"Operate local orders","enabled":true,"expected_revision":0}' >"$cache_dir/role.json"

admin_curl "$gateway_url/admin/v1/subjects/roles?issuer=$issuer&subject=$alice_subject" >"$cache_dir/subject-before.json"
subject_revision="$(node -e 'const fs=require("fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision))' "$cache_dir/subject-before.json")"
run_suffix="$(date +%s)-$$"
admin_curl -X PUT "$gateway_url/admin/v1/subjects/roles" \
    -H 'Content-Type: application/json' -H "X-Request-ID: bind-$run_suffix" -H "Idempotency-Key: bind-$run_suffix" \
    --data "{\"issuer\":\"$issuer\",\"subject\":\"$alice_subject\",\"roles\":[\"order-operator\"],\"enabled\":true,\"expected_revision\":$subject_revision}" \
    >"$cache_dir/bound.json"
bound_revision="$(node -e 'const fs=require("fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision))' "$cache_dir/bound.json")"

GATEWAYD_BASE_URL="$gateway_grpc_url" GATEWAYD_HEARTBEAT_MS=1000 SANDBOX_PORT=18090 \
    node --import tsx test/sandbox/server.ts >"$cache_dir/sandbox.log" 2>&1 &
sandbox_pid="$!"
wait_for sandbox curl --fail --silent "$sandbox_url/healthz"
wait_for tool-view curl --fail --silent --cacert "$cache_dir/ca.pem" "$gateway_url/v1/tool-view"

curl --fail --silent --show-error -X POST "$issuer/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=password' --data-urlencode 'client_id=flory-test' \
    --data-urlencode 'client_secret=flory-test-secret' --data-urlencode 'username=alice' \
    --data-urlencode 'password=alice-local-password' >"$cache_dir/token.json"
access_token="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).access_token)' "$cache_dir/token.json")"

curl --fail --silent --show-error --cacert "$cache_dir/ca.pem" \
    --cert "$cache_dir/orchestrator.pem" --key "$cache_dir/orchestrator.key" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $access_token" \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"run_id":"00000000-0000-4000-8000-000000000001"}}' \
    "$gateway_url/mcp" >"$cache_dir/original-run.json"
view_digest="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).result._meta.tool_view_digest)' "$cache_dir/original-run.json")"
identity_header="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).result._meta.authorization_identity; process.stdout.write(Buffer.from(JSON.stringify(x)).toString("base64url"))' "$cache_dir/original-run.json")"

internal_curl -H 'Content-Type: application/json' -H "X-Flory-Workflow-Identity: $identity_header" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"inventory.reserve\",\"arguments\":{\"order_id\":\"rbac-e2e\",\"sku\":\"SKU-1\",\"quantity\":1},\"_meta\":{\"run_id\":\"00000000-0000-4000-8000-000000000001\",\"vertex_id\":\"try\",\"scope_id\":\"scope\",\"tool_version\":\"1.0.0\",\"tool_view_digest\":\"$view_digest\",\"attempt\":1,\"idempotency_key\":\"rbac-e2e\"}}}" \
    "$gateway_url/mcp" >"$cache_dir/try.json"

admin_curl -X PUT "$gateway_url/admin/v1/subjects/roles" \
    -H 'Content-Type: application/json' -H "X-Request-ID: revoke-$run_suffix" -H "Idempotency-Key: revoke-$run_suffix" \
    --data "{\"issuer\":\"$issuer\",\"subject\":\"$alice_subject\",\"roles\":[],\"enabled\":true,\"expected_revision\":$bound_revision}" \
    >"$cache_dir/revoked.json"

curl --fail --silent --show-error --cacert "$cache_dir/ca.pem" \
    --cert "$cache_dir/orchestrator.pem" --key "$cache_dir/orchestrator.key" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $access_token" \
    --data '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"run_id":"00000000-0000-4000-8000-000000000002"}}' \
    "$gateway_url/mcp" >"$cache_dir/new-run.json"
node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(x.result.tools.length!==0||x.result._meta.authorization_identity.roles.length!==0) process.exit(1)' "$cache_dir/new-run.json"

internal_curl -H 'Content-Type: application/json' -H "X-Flory-Workflow-Identity: $identity_header" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"inventory.release\",\"arguments\":{\"order_id\":\"rbac-e2e\"},\"_meta\":{\"run_id\":\"00000000-0000-4000-8000-000000000001\",\"vertex_id\":\"cancel\",\"scope_id\":\"scope\",\"tool_version\":\"1.0.0\",\"tool_view_digest\":\"$view_digest\",\"attempt\":1,\"idempotency_key\":\"rbac-e2e-cancel\"}}}" \
    "$gateway_url/mcp" >"$cache_dir/cancel.json"

node -e 'const fs=require("fs"); for(const f of process.argv.slice(1)){const x=JSON.parse(fs.readFileSync(f,"utf8")); if(x.error||x.result?.structuredContent?.outcome!=="succeeded") process.exit(1)}' "$cache_dir/try.json" "$cache_dir/cancel.json"
curl --fail --silent "$sandbox_url/test/snapshot" >"$cache_dir/snapshot.json"
node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(x.inventory.open_holds!==0) process.exit(1)' "$cache_dir/snapshot.json"
printf 'RBAC E2E passed: new work lost revoked access and the original run completed its cancel\n'
