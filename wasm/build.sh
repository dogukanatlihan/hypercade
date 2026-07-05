#!/usr/bin/env bash
# Build both physics engines to WASM: separate .wasm files (streamed, cacheable),
# ES6 glue modules into client/sdk/gen/. Requires emsdk.
set -euo pipefail

cd "$(dirname "$0")/.."

EMCC="${EMCC:-emcc}"
if ! command -v "$EMCC" >/dev/null 2>&1; then
  EMCC="$HOME/emsdk/upstream/emscripten/emcc.exe"
fi

OUT=client/sdk/gen
mkdir -p "$OUT"

COMMON_FLAGS=(
  -O2 -msimd128 -msse2
  -sMODULARIZE=1 -sEXPORT_ES6=1
  -sALLOW_MEMORY_GROWTH=1
  -sENVIRONMENT=web,worker,node
  -sEXPORTED_RUNTIME_METHODS=HEAPF32
  -sFILESYSTEM=0
)

echo "== Box3D (w3_) =="
"$EMCC" wasm/shim3d.c wasm/vendor/box3d/src/*.c \
  -I wasm/vendor/box3d/include -I wasm/vendor/box3d/src \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createBox3d \
  -o "$OUT/box3d.mjs"

echo "== Box2D v3 (w2_) =="
"$EMCC" wasm/shim2d.c wasm/vendor/box2d/src/*.c \
  -I wasm/vendor/box2d/include -I wasm/vendor/box2d/src -I wasm/vendor/box2d/extern/simde \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createBox2d \
  -o "$OUT/box2d.mjs"

echo "== sizes =="
ls -la "$OUT"/*.wasm | awk '{printf "%s %.0f KB\n", $NF, $5/1024}'
for f in "$OUT"/*.wasm; do
  kb=$(( $(stat -c%s "$f") / 1024 ))
  if [ "$kb" -gt 500 ]; then
    echo "BUDGET FAIL: $f is ${kb}KB (limit 500KB)"; exit 1
  fi
done
echo "OK — both engines within budget"
