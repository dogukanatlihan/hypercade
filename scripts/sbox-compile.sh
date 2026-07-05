#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TIMEOUT_SEC=120

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)
            PROJECT_DIR="$(cd "$2" && pwd)"
            shift 2
            ;;
        --timeout)
            TIMEOUT_SEC="$2"
            shift 2
            ;;
        --timeout=*)
            TIMEOUT_SEC="${1#--timeout=}"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

source "$SCRIPT_DIR/sbox-common.sh"
source "$SCRIPT_DIR/qq-runtime.sh"

if ! qq_is_sbox_project "$PROJECT_DIR"; then
    echo "Error: $PROJECT_DIR is not a valid S&box project (.sbproj not found)" >&2
    exit 1
fi

DOTNET_BIN="$(qq_find_sbox_dotnet || true)"
if [[ -z "$DOTNET_BIN" ]]; then
    echo "Error: dotnet not found. Install dotnet or set DOTNET_BIN before running S&box compile." >&2
    exit 1
fi

RUN_ID="$(qq_run_record_start "compile" "sbox-compile" "dotnet-cli" "dotnet-build" "S&box compile/check started" | $QQ_PY -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"
TMP_OUTPUT="$(mktemp)"
trap 'rm -f "$TMP_OUTPUT"' EXIT

TARGETS=()
while IFS= read -r target; do
    [[ -n "$target" ]] && TARGETS+=("$target")
done < <(qq_list_sbox_compile_targets "$PROJECT_DIR")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
    printf 'No .sln or .csproj build target found for this S&box project.\nOpen the project in s&box once or generate project files before running qq compile.\n' | tee -a "$TMP_OUTPUT"
    qq_run_record_finish "$RUN_ID" "failed" "compile_target_missing" "S&box compile target not found" >/dev/null
    exit 1
fi

set +e
for target in "${TARGETS[@]}"; do
    printf '[sbox-compile] dotnet build %s\n' "$target" >>"$TMP_OUTPUT"
    "$DOTNET_BIN" build "$target" -nologo >>"$TMP_OUTPUT" 2>&1
    if [[ $? -ne 0 ]]; then
        set -e
        cat "$TMP_OUTPUT"
        qq_run_record_finish "$RUN_ID" "failed" "compile_failed" "dotnet build failed for S&box target" >/dev/null
        exit 1
    fi
done
set -e

cat "$TMP_OUTPUT"
qq_run_record_finish "$RUN_ID" "passed" "" "S&box compile/check passed" >/dev/null
echo "S&box compile/check passed (${TIMEOUT_SEC}s budget)"
