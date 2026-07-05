#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Python compatibility (Windows Store python3 alias is on PATH but broken;
# use --version to detect a working interpreter, not command -v)
: "${QQ_PY:=python3}"
"$QQ_PY" --version >/dev/null 2>&1 || QQ_PY="python"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
    if [[ "${ARGS[$i]}" == "--project" && $((i + 1)) -lt ${#ARGS[@]} ]]; then
        PROJECT_DIR="$(cd "${ARGS[$((i + 1))]}" && pwd)"
        break
    fi
done

ENGINE="$($QQ_PY "$SCRIPT_DIR/qq_engine.py" detect --project "$PROJECT_DIR" | $QQ_PY -c 'import json,sys; print(json.load(sys.stdin).get("engine",""))' 2>/dev/null || true)"

if [[ "$ENGINE" == "godot" && ${#ARGS[@]} -gt 0 ]]; then
    case "${ARGS[0]}" in
        editmode|playmode)
            ARGS=("all" "${ARGS[@]:1}")
            ;;
    esac
fi

if [[ "$ENGINE" == "unreal" && ${#ARGS[@]} -gt 0 ]]; then
    case "${ARGS[0]}" in
        editmode)
            ARGS=("editor" "${ARGS[@]:1}")
            ;;
        playmode)
            ARGS=("all" "${ARGS[@]:1}")
            ;;
    esac
fi

if [[ "$ENGINE" == "sbox" && ${#ARGS[@]} -gt 0 ]]; then
    case "${ARGS[0]}" in
        editmode|playmode|all)
            ARGS=("unit" "${ARGS[@]:1}")
            ;;
    esac
fi

case "$ENGINE" in
    unity)
        exec "$SCRIPT_DIR/unity-test.sh" "${ARGS[@]}"
        ;;
    godot)
        exec "$SCRIPT_DIR/godot-test.sh" "${ARGS[@]}"
        ;;
    unreal)
        exec "$SCRIPT_DIR/unreal-test.sh" "${ARGS[@]}"
        ;;
    sbox)
        exec "$SCRIPT_DIR/sbox-test.sh" "${ARGS[@]}"
        ;;
    *)
        echo "Error: no supported engine detected for project: $PROJECT_DIR" >&2
        exit 1
        ;;
esac
