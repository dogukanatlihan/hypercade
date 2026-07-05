#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MODE="unit"
FILTER=""
TIMEOUT_SEC=300

if [[ $# -gt 0 && "$1" != --* ]]; then
    MODE="$1"
    shift
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)
            PROJECT_DIR="$(cd "$2" && pwd)"
            shift 2
            ;;
        --filter)
            FILTER="$2"
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
    echo "Error: dotnet not found. Install dotnet or set DOTNET_BIN before running S&box tests." >&2
    exit 1
fi

case "$MODE" in
    unit|all|editmode|playmode) ;;
    *)
        MODE="unit"
        ;;
esac

RUN_ID="$(qq_run_record_start "test" "sbox-test" "dotnet-test" "dotnet-cli" "S&box test run started" | $QQ_PY -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"
TMP_OUTPUT="$(mktemp)"
trap 'rm -f "$TMP_OUTPUT"' EXIT

if ! qq_sbox_has_unit_tests "$PROJECT_DIR"; then
    printf 'S&box UnitTests/ directory not found.\n' | tee -a "$TMP_OUTPUT"
    qq_run_record_finish "$RUN_ID" "not_run" "no_tests_found" "S&box UnitTests directory not found" >/dev/null
    exit 1
fi

TARGETS=()
while IFS= read -r target; do
    [[ -n "$target" ]] && TARGETS+=("$target")
done < <(qq_list_sbox_test_targets "$PROJECT_DIR")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
    printf 'No S&box test target found.\nOpen the project in s&box once or generate the UnitTests project before running qq test.\n' | tee -a "$TMP_OUTPUT"
    qq_run_record_finish "$RUN_ID" "not_run" "no_test_project_generated" "S&box test target not found" >/dev/null
    exit 1
fi

set +e
for target in "${TARGETS[@]}"; do
    printf '[sbox-test] dotnet test %s\n' "$target" >>"$TMP_OUTPUT"
    if [[ -n "$FILTER" ]]; then
        "$DOTNET_BIN" test "$target" -nologo --filter "$FILTER" >>"$TMP_OUTPUT" 2>&1
    else
        "$DOTNET_BIN" test "$target" -nologo >>"$TMP_OUTPUT" 2>&1
    fi
    if [[ $? -ne 0 ]]; then
        set -e
        cat "$TMP_OUTPUT"
        qq_run_record_finish "$RUN_ID" "failed" "test_failed" "S&box tests failed" >/dev/null
        exit 1
    fi
done
set -e

cat "$TMP_OUTPUT"
qq_run_record_finish "$RUN_ID" "passed" "" "S&box tests passed" >/dev/null
echo "S&box tests passed (${TIMEOUT_SEC}s budget)"
