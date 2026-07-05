#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TIMEOUT_SEC=300

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

source "$SCRIPT_DIR/unreal-common.sh"
source "$SCRIPT_DIR/qq-runtime.sh"

if ! qq_is_unreal_project "$PROJECT_DIR"; then
    echo "Error: $PROJECT_DIR is not a valid Unreal project (*.uproject not found)" >&2
    exit 1
fi

UPROJECT="$(qq_find_unreal_project_file "$PROJECT_DIR")"
PROJECT_NAME="$(qq_unreal_project_name "$PROJECT_DIR")"
EDITOR_CMD="$(qq_find_unreal_editor_cmd || true)"
if [[ -z "$EDITOR_CMD" ]]; then
    echo "Error: UnrealEditor command not found. Set UNREAL_EDITOR_CMD or UE_EDITOR_CMD." >&2
    exit 1
fi

RUN_ID="$(qq_run_record_start "compile" "unreal-compile" "unreal-cli" "unreal-editor-cmd" "Unreal compile/check started" | $QQ_PY -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"
TMP_OUTPUT="$(mktemp)"
TMP_RESULT="$(mktemp)"
trap 'rm -f "$TMP_OUTPUT" "$TMP_RESULT"' EXIT

set +e

if qq_unreal_has_native_source "$PROJECT_DIR"; then
    UBT_PATH="$(qq_find_unreal_ubt || true)"
    DOTNET_BIN="$(qq_find_unreal_dotnet || true)"
    HOST_PLATFORM="$(qq_unreal_host_platform)"
    if [[ -z "$UBT_PATH" || -z "$DOTNET_BIN" || "$HOST_PLATFORM" == "Unknown" ]]; then
        printf 'Unreal native source detected but UnrealBuildTool or dotnet could not be resolved.\n' >>"$TMP_OUTPUT"
        cat "$TMP_OUTPUT"
        qq_run_record_finish "$RUN_ID" "failed" "toolchain_missing" "Unreal native toolchain not available" >/dev/null
        exit 1
    fi

    DOTNET_ROOT="$(cd "$(dirname "$DOTNET_BIN")" && pwd)"
    DOTNET_MULTILEVEL_LOOKUP=0 DOTNET_ROOT="$DOTNET_ROOT" "$DOTNET_BIN" "$UBT_PATH" "${PROJECT_NAME}Editor" "$HOST_PLATFORM" Development "-Project=$UPROJECT" -WaitMutex -NoHotReloadFromIDE >>"$TMP_OUTPUT" 2>&1
    if [[ $? -ne 0 ]]; then
        cat "$TMP_OUTPUT"
        qq_run_record_finish "$RUN_ID" "failed" "compile_failed" "UnrealBuildTool failed" >/dev/null
        exit 1
    fi
fi

QQ_UNREAL_OUTPUT_PATH="$TMP_RESULT" \
    "$EDITOR_CMD" "$UPROJECT" -unattended -nop4 -nosplash -nullrhi -stdout -FullStdOutLogOutput \
    "-ExecutePythonScript=$PROJECT_DIR/scripts/unreal-compile-check.py" >>"$TMP_OUTPUT" 2>&1
STATUS=$?

set -e

cat "$TMP_OUTPUT"

if [[ $STATUS -ne 0 ]]; then
    qq_run_record_finish "$RUN_ID" "failed" "compile_failed" "Unreal editor compile/check failed" >/dev/null
    exit 1
fi

if [[ ! -s "$TMP_RESULT" ]]; then
    qq_run_record_finish "$RUN_ID" "failed" "compile_failed" "Unreal compile check did not produce a result payload" >/dev/null
    exit 1
fi

if ! $QQ_PY - "$TMP_RESULT" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
raise SystemExit(0 if payload.get("ok") else 1)
PY
then
    qq_run_record_finish "$RUN_ID" "failed" "compile_failed" "Unreal compile check reported findings" >/dev/null
    exit 1
fi

qq_run_record_finish "$RUN_ID" "passed" "" "Unreal compile/check passed" >/dev/null
echo "Unreal compile/check passed (${TIMEOUT_SEC}s budget)"
