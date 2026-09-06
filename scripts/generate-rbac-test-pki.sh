#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$root_dir/.cache/rbac-e2e"
mkdir -p "$output_dir/keyring"

openssl genrsa -out "$output_dir/ca.key" 2048 >/dev/null 2>&1
openssl req -x509 -new -key "$output_dir/ca.key" -sha256 -days 7 -subj '/CN=Flory local test CA' -out "$output_dir/ca.pem"

issue_certificate() {
    local name="$1"
    local extension="$2"
    openssl genrsa -out "$output_dir/$name.key" 2048 >/dev/null 2>&1
    openssl req -new -key "$output_dir/$name.key" -subj "/CN=$name" -out "$output_dir/$name.csr"
    printf '%s\n' "$extension" >"$output_dir/$name.ext"
    openssl x509 -req -in "$output_dir/$name.csr" -CA "$output_dir/ca.pem" -CAkey "$output_dir/ca.key" \
        -CAcreateserial -out "$output_dir/$name.pem" -days 7 -sha256 -extfile "$output_dir/$name.ext" >/dev/null 2>&1
}

issue_certificate gateway 'subjectAltName=DNS:localhost,IP:127.0.0.1'
issue_certificate orchestrator 'subjectAltName=URI:spiffe://flory.local/orchestrator'
issue_certificate coordinator 'subjectAltName=URI:spiffe://flory.local/coordinator'
issue_certificate rbac-admin 'subjectAltName=URI:spiffe://flory.local/rbac-admin'

openssl genpkey -algorithm ED25519 -out "$output_dir/identity-private.pem"
openssl pkey -in "$output_dir/identity-private.pem" -pubout -out "$output_dir/keyring/local-key"
printf 'generated local RBAC test keys in %s\n' "$output_dir"
