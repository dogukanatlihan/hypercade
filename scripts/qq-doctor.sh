#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Python compatibility (Windows Store python3 alias is on PATH but broken;
# use --version to detect a working interpreter, not command -v)
: "${QQ_PY:=python3}"
"$QQ_PY" --version >/dev/null 2>&1 || QQ_PY="python"

$QQ_PY "$SCRIPT_DIR/qq-doctor.py" "$@"
