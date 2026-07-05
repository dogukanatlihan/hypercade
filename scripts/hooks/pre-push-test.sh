#!/usr/bin/env bash
# pre-push-test.sh — PreToolUse(Bash) hook
# 检测 git push 命令，先跑 test.sh，失败则阻止推送
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/qq-runtime.sh"

REPO_ROOT="$(git rev-parse --show-toplevel)"

# 从 stdin 读取 tool_input，提取 command 字段（jq 优先，python3 fallback）
COMMAND="$(qq_hook_input tool_input.command)"

# 只拦截 git push
if [[ "$COMMAND" == *"git push"* ]]; then
  echo "🧪 Running tests before push..."
  if ! "$REPO_ROOT/test.sh"; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"❌ Tests failed — push blocked. Fix the issues and try again."}}'
    exit 2
  fi
  echo "✅ All tests passed, proceeding with push."
fi
