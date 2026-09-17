#!/bin/sh

set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
codegraph_command="$(command -v codegraph)"
poll_seconds="${CODEGRAPH_POLL_SECONDS:-2}"
parent_pid="$$"
lock_dir="$project_root/.codegraph/poll-sync.lock"

cd "$project_root"

poll_index() {
    while kill -0 "$parent_pid" 2>/dev/null; do
        sleep "$poll_seconds"
        if mkdir "$lock_dir" 2>/dev/null; then
            "$codegraph_command" sync "$project_root" --quiet || true
            rmdir "$lock_dir" 2>/dev/null || true
        fi
    done
}

poll_index &
exec env CODEGRAPH_NO_WATCH=1 "$codegraph_command" serve --mcp
