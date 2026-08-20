#!/usr/bin/env bash
# Run all S1 TLC checks. The two negative models must fail at their named
# invariant; the discovery model must fail L2 with the alternating-planner lasso.
set -euo pipefail

spec_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${spec_dir}/.." && pwd)"

# shellcheck source=toolchain.env
source "${spec_dir}/toolchain.env"

cache_dir="${spec_dir}/.tlc"
jar_path="${cache_dir}/tla2tools-${TLA_TOOLS_VERSION}.jar"
workers="${TLC_WORKERS:-1}"
mkdir -p "${cache_dir}"

cleanup_traces() {
    # TLC writes trace-exploration modules next to the root module on failures.
    # They are diagnostic scratch files, never source artifacts.
    rm -f "${spec_dir}"/*_TTrace_*
}

trap cleanup_traces EXIT

actual_sha() {
    shasum -a 256 "$1" | awk '{print $1}'
}

download_tools() {
    local temporary_path
    temporary_path="${jar_path}.download"
    rm -f "${temporary_path}"
    curl -fsSL --retry 3 --retry-all-errors "${TLA_TOOLS_URL}" -o "${temporary_path}"
    if [[ "$(actual_sha "${temporary_path}")" != "${TLA_TOOLS_SHA256}" ]]; then
        rm -f "${temporary_path}"
        echo "tla2tools.jar checksum mismatch" >&2
        exit 1
    fi
    mv "${temporary_path}" "${jar_path}"
}

if [[ ! -f "${jar_path}" ]] || [[ "$(actual_sha "${jar_path}")" != "${TLA_TOOLS_SHA256}" ]]; then
    download_tools
fi

run_case() {
    local name="$1"
    local module="$2"
    local config="$3"
    local expected_exit="$4"
    local required_text="$5"
    local work_dir log_path status

    work_dir="$(mktemp -d "${cache_dir}/${name}.XXXXXX")"
    log_path="${work_dir}/tlc.log"

    set +e
    (
        cd "${work_dir}"
        java -XX:+UseParallelGC -cp "${jar_path}" tlc2.TLC \
            -workers "${workers}" \
            -metadir "${work_dir}/states" \
            -config "${spec_dir}/${config}" \
            "${spec_dir}/${module}"
    ) >"${log_path}" 2>&1
    status=$?
    set -e

    if [[ "${expected_exit}" == "success" ]]; then
        if [[ "${status}" -ne 0 ]] || ! rg -Fq "Model checking completed. No error has been found." "${log_path}"; then
            cat "${log_path}" >&2
            rm -rf "${work_dir}"
            echo "${name}: expected TLC success" >&2
            exit 1
        fi
    else
        if [[ "${status}" -eq 0 ]] || ! rg -Fq "${required_text}" "${log_path}"; then
            cat "${log_path}" >&2
            rm -rf "${work_dir}"
            echo "${name}: expected failure containing: ${required_text}" >&2
            exit 1
        fi
    fi

    rm -rf "${work_dir}"
    echo "${name}: passed"
}

run_case "small-safety" "MCSmall.tla" "MCSmallSafety.cfg" success ""
run_case "three-safety" "MCThree.tla" "MCThreeSafety.cfg" success ""
run_case "small-liveness" "MCSmall.tla" "MCSmall.cfg" success ""
run_case "three-liveness" "MCThree.tla" "MCThree.cfg" success ""
run_case "oscillation-discovery" "MCDiscovery.tla" "MCDiscovery.cfg" failure "Temporal property L2EpisodeTerminates was violated."
run_case "no-barrier-negative" "MCNoBarrier.tla" "MCNoBarrier.cfg" failure "Invariant I1PivotBarrier is violated."
run_case "post-pivot-cancel-negative" "MCPostPivotCancel.tla" "MCPostPivotCancel.cfg" failure "Invariant I3NoCancelAfterPivot is violated."
run_case "unscoped-effect-negative" "MCUnscopedEffect.tla" "MCUnscopedEffect.cfg" failure "Invariant AdmissionAllEffectsScoped is violated."
run_case "narrow-scope-negative" "MCNarrowScope.tla" "MCNarrowScope.cfg" failure "Invariant AdmissionMinimumScope is violated."

echo "All S1 TLC checks passed."
