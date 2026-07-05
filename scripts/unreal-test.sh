#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MODE="all"
FILTER=""
TIMEOUT_SEC=600

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

source "$SCRIPT_DIR/unreal-common.sh"
source "$SCRIPT_DIR/qq-runtime.sh"

if ! qq_is_unreal_project "$PROJECT_DIR"; then
    echo "Error: $PROJECT_DIR is not a valid Unreal project (*.uproject not found)" >&2
    exit 1
fi

UPROJECT="$(qq_find_unreal_project_file "$PROJECT_DIR")"
EDITOR_CMD="$(qq_find_unreal_editor_cmd || true)"
if [[ -z "$EDITOR_CMD" ]]; then
    echo "Error: UnrealEditor command not found. Set UNREAL_EDITOR_CMD or UE_EDITOR_CMD." >&2
    exit 1
fi

RUN_ID="$(qq_run_record_start "test" "unreal-test" "automation" "unreal-editor-cmd" "Unreal automation test run started" | $QQ_PY -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"
TMP_OUTPUT="$(mktemp)"
trap 'rm -f "$TMP_OUTPUT"' EXIT

TEST_FILTER="$FILTER"
case "$MODE" in
    editmode|editor)
        [[ -n "$TEST_FILTER" ]] || TEST_FILTER="Project.Editor"
        ;;
    playmode)
        [[ -n "$TEST_FILTER" ]] || TEST_FILTER="Project"
        ;;
    smoke)
        [[ -n "$TEST_FILTER" ]] || TEST_FILTER="Project.Smoke"
        ;;
    all)
        [[ -n "$TEST_FILTER" ]] || TEST_FILTER="Project"
        ;;
    *)
        [[ -n "$TEST_FILTER" ]] || TEST_FILTER="$MODE"
        ;;
esac

set +e
"$EDITOR_CMD" "$UPROJECT" -unattended -nop4 -nosplash -nullrhi -stdout -FullStdOutLogOutput \
    "-ExecCmds=Automation RunTests ${TEST_FILTER}; Quit" \
    "-TestExit=Automation Test Queue Empty" >>"$TMP_OUTPUT" 2>&1
STATUS=$?
set -e

cat "$TMP_OUTPUT"

if [[ $STATUS -eq 0 ]] && grep -Eq "No automation tests matched|No automation tests were found" "$TMP_OUTPUT"; then
    qq_run_record_finish "$RUN_ID" "failed" "test_failed" "Unreal automation did not discover any tests" >/dev/null
    echo "Unreal automation did not discover any tests (${TIMEOUT_SEC}s budget)" >&2
    exit 1
fi

if [[ $STATUS -ne 0 ]]; then
    qq_run_record_finish "$RUN_ID" "failed" "test_failed" "Unreal automation tests failed" >/dev/null
    echo "Unreal automation tests failed (${TIMEOUT_SEC}s budget)" >&2
    exit 1
fi

qq_run_record_finish "$RUN_ID" "passed" "" "Unreal automation tests passed" >/dev/null
echo "Unreal automation tests passed (${TIMEOUT_SEC}s budget)"
