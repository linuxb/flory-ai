#!/usr/bin/env bash
set -euo pipefail

readonly image="ghcr.io/apalache-mc/apalache@sha256:fde994fd109323934b9abb7ad169de37b29acf2141483367f2913cae30ff3795"
readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly model="CoordinatorS2"

run_check() {
    local config="$1"
    shift
    docker run --rm --platform=linux/amd64 -v "${root}/spec:/var/apalache" -w /var/apalache "${image}" check --config="${config}" "$@" "${model}.tla"
}

for config in CoordinatorS2Small.cfg CoordinatorS2.cfg; do
    run_check "${config}" --init=Init --inv=IndInv --length=0 --no-deadlock
    run_check "${config}" --init=IndInv --inv=IndInv --length=1 --no-deadlock
    run_check "${config}" --init=IndInv --inv=S2Safety --length=0 --no-deadlock
done

echo "All S2 Apalache inductive-invariant checks passed."
