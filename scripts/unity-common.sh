#!/usr/bin/env bash
# unity-common.sh — Unity 脚本公共函数
# 被 unity-compile-smart.sh, unity-check.sh, unity-test.sh, unity-compile.sh 共享
#
# 使用方式: source "$(dirname "$0")/unity-common.sh"
# 前提: 调用方必须先设置 PROJECT_DIR 变量

# ── 加载平台检测层 ──
source "$(dirname "${BASH_SOURCE[0]}")/platform/detect.sh"

# ── 检测 Unity Editor 是否为当前项目打开 ──
#
# Preferred signal: tykit.json exists + /ping responds. Definitive proof that
# Unity is up and tykit is listening. No dependency on wmic/tasklist which are
# unreliable on Windows 11 (wmic deprecated) and Git Bash (PATH issues in hooks).
#
# Fallback: qq_is_unity_running (lockfile + process check + compile_status mtime).
is_editor_open_for_project() {
    local tykit_json="$PROJECT_DIR/Temp/tykit.json"
    if [ -f "$tykit_json" ]; then
        local port
        local py_cmd="python3"
        python3 --version >/dev/null 2>&1 || py_cmd="python"
        port=$($py_cmd -c "import json; print(json.load(open('$tykit_json'))['port'])" 2>/dev/null)
        if [ -n "$port" ]; then
            # /ping responds on the listener thread, works even when main thread is blocked.
            if curl -s --connect-timeout 2 --max-time 3 "http://localhost:$port/ping" >/dev/null 2>&1; then
                return 0
            fi
        fi
    fi
    # Fallback to process-based detection
    qq_is_unity_running "$PROJECT_DIR"
}

# ── 查找 Unity Editor 可执行文件路径 ──
find_unity() {
    qq_find_unity_binary "$PROJECT_DIR"
}

# ── 查找 tykit 的 unity-eval.sh（兼容 PackageCache 和嵌入包） ──
find_unity_eval() {
    # 优先搜嵌入包
    local embedded="$PROJECT_DIR/Packages/com.tyk.tykit/Scripts~/unity-eval.sh"
    if [ -f "$embedded" ]; then
        echo "$embedded"
        return
    fi

    # 回退搜 PackageCache
    find "$PROJECT_DIR/Library/PackageCache" -name "unity-eval.sh" -path "*/com.tyk.tykit*" 2>/dev/null | head -1
}

# ── 获取 tykit 端口 ──
get_tykit_port() {
    local json_file="$PROJECT_DIR/Temp/tykit.json"
    if [ -f "$json_file" ]; then
        local py_cmd="python3"
        python3 --version >/dev/null 2>&1 || py_cmd="python"
        $py_cmd -c "import json; print(json.load(open('$json_file'))['port'])" 2>/dev/null
    fi
}
