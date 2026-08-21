#!/usr/bin/env bash
# Render the root TLA+ module after run-tlc.sh has verified every S1 model.
set -euo pipefail

spec_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# run-tlc.sh supplies the already checksum-verified official tool jar. Keeping
# this script dependent on that runner prevents publishing an unverified model.
jar_path="${TLA_TOOLS_JAR:-}"
if [[ -z "${jar_path}" ]] || [[ ! -f "${jar_path}" ]]; then
    echo "export-pdf.sh must be invoked by run-tlc.sh after TLC succeeds" >&2
    exit 1
fi

for required_command in java pdflatex; do
    if ! command -v "${required_command}" >/dev/null 2>&1; then
        echo "PDF export requires ${required_command}" >&2
        exit 1
    fi
done

output_dir="${spec_dir}/output"
output_path="${output_dir}/FloryTxn.pdf"
build_dir="$(mktemp -d "${spec_dir}/.tlc/pdf.XXXXXX")"

cleanup() {
    rm -rf "${build_dir}"
}
trap cleanup EXIT

mkdir -p "${output_dir}"
cp "${spec_dir}/FloryTxn.tla" "${build_dir}/FloryTxn.tla"

# TLA2TeX is bundled with the same pinned jar as TLC. It invokes pdflatex
# directly, while `true` intentionally suppresses the legacy dvips conversion.
(
    cd "${build_dir}"
    java -cp "${jar_path}" tla2tex.TLA \
        -metadir "${build_dir}" \
        -out "FloryTxn" \
        -latexCommand "pdflatex -interaction=nonstopmode -halt-on-error" \
        -latexOutputExt "pdf" \
        -psCommand "true" \
        "FloryTxn.tla"
) >"${build_dir}/tla2tex.log" 2>&1

if [[ ! -s "${build_dir}/FloryTxn.pdf" ]]; then
    cat "${build_dir}/tla2tex.log" >&2
    echo "TLA2TeX did not produce FloryTxn.pdf" >&2
    exit 1
fi

cp "${build_dir}/FloryTxn.pdf" "${output_path}"
echo "TLA+ PDF: ${output_path}"
