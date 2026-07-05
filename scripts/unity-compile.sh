#!/bin/bash
# Unity 离线编译检查脚本
# 用法:
#   ./scripts/unity-compile.sh                    # 编译当前项目
#   ./scripts/unity-compile.sh /path/to/project   # 编译指定项目
#
# 在不启动 Unity 编辑器 UI 的情况下，使用 batch mode 编译项目并报告结果。
# 注意：如果 Unity Editor 已经打开了该项目，batch mode 无法同时访问，
# 此时请先关闭 Unity 或使用不同的项目路径（如 worktree）。

set -euo pipefail

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# 项目路径（先设好再 source）
PROJECT_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# 公共函数（find_unity 等）
source "$(dirname "$0")/unity-common.sh"

LOG_FILE="$QQ_TEMP_DIR/unity-compile-$(date +%s).log"

# 验证项目路径
if [ ! -f "$PROJECT_DIR/ProjectSettings/ProjectVersion.txt" ]; then
    echo -e "${RED}Error: $PROJECT_DIR is not a valid Unity project${NC}"
    exit 1
fi

# 查找 Unity
UNITY_BIN=$(find_unity)
if [ -z "$UNITY_BIN" ]; then
    echo -e "${RED}Error: Unity installation not found${NC}"
    echo "Set the UNITY_PATH environment variable or ensure Unity is installed in the standard path"
    exit 1
fi

echo -e "${CYAN}Unity:${NC}   $UNITY_BIN"
echo -e "${CYAN}Project:${NC} $PROJECT_DIR"
echo -e "${CYAN}Log:${NC}     $LOG_FILE"
echo ""

# 检查 Unity 是否已锁定该项目
LOCK_FILE="$PROJECT_DIR/Temp/UnityLockfile"
if [ -f "$LOCK_FILE" ]; then
    echo -e "${YELLOW}⚠️ Unity lock file detected — a Unity instance may already be using this project${NC}"
    echo -e "${YELLOW}   If compilation fails, close the Unity instance holding this project first${NC}"
    echo ""
fi

# 运行编译
echo -e "${CYAN}Starting compilation...${NC}"
START_TIME=$(date +%s)

# -batchmode: 无 UI
# -nographics: 不初始化图形设备
# -projectPath: 项目路径
# -logFile: 日志文件
# -quit: 完成后退出
# -buildTarget: 保持当前平台（不触发平台切换）
# Windows Unity.exe needs Windows-style paths
PROJ_PATH="$PROJECT_DIR"
LOG_PATH="$LOG_FILE"
if [[ "$QQ_PLATFORM" == "windows" ]]; then
    PROJ_PATH=$(cygpath -w "$PROJECT_DIR")
    LOG_PATH=$(cygpath -w "$LOG_FILE")
fi

"$UNITY_BIN" \
    -batchmode \
    -nographics \
    -projectPath "$PROJ_PATH" \
    -logFile "$LOG_PATH" \
    -quit \
    2>&1 || true

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""

# 分析日志
if [ ! -f "$LOG_FILE" ]; then
    echo -e "${RED}❌ Compilation log not generated${NC}"
    exit 1
fi

# 检查 batch mode 是否因锁文件等原因中止
ABORT_MSG=$(grep "Aborting batchmode" "$LOG_FILE" 2>/dev/null || true)
LOCKED_MSG=$(grep -E "another Unity instance is running with this project open|Multiple Unity instances cannot open the same project" "$LOG_FILE" 2>/dev/null || true)
if [ -n "$ABORT_MSG" ]; then
    # 即使 batch mode 中止，也可能已经完成了编译检查
    # 需要同时检查是否有 "Compilation" 相关的成功信息
    :
fi

# 检查是否有编译错误（多种模式匹配）
ERRORS=$(grep -E "error CS[0-9]+" "$LOG_FILE" 2>/dev/null | sort -u || true)
WARNING_COUNT=$(grep -cE "warning CS[0-9]+" "$LOG_FILE" 2>/dev/null || true)
if ! [[ "$WARNING_COUNT" =~ ^[0-9]+$ ]]; then
    WARNING_COUNT=0
fi

if [ -n "$ERRORS" ]; then
    ERROR_COUNT=$(echo "$ERRORS" | wc -l | tr -d ' ')
    echo -e "${RED}❌ Compilation failed${NC} (${DURATION}s, ${ERROR_COUNT} error(s), ${WARNING_COUNT} warning(s))"
    echo ""
    echo -e "${RED}Error list:${NC}"
    echo "$ERRORS" | head -30 | while IFS= read -r line; do
        echo -e "  ${RED}$line${NC}"
    done
    if [ "$ERROR_COUNT" -gt 30 ]; then
        echo -e "  ... and $((ERROR_COUNT - 30)) more error(s)"
    fi
    echo ""
    echo -e "Full log: $LOG_FILE"
    exit 1
elif [ -n "$LOCKED_MSG" ]; then
    echo -e "${YELLOW}⚠️ Unity project is locked, batch mode cannot access it${NC} (${DURATION}s)"
    echo -e "${YELLOW}Reason:${NC} Another Unity instance has this project open"
    echo -e "Full log: $LOG_FILE"
    exit 2
elif [ -n "$ABORT_MSG" ] && ! grep -q "Refresh completed" "$LOG_FILE" 2>/dev/null; then
    echo -e "${YELLOW}⚠️ Unity batch mode aborted${NC} (${DURATION}s)"
    echo -e "${YELLOW}Reason:${NC} $ABORT_MSG"
    echo -e "Full log: $LOG_FILE"
    exit 2
else
    echo -e "${GREEN}✅ Compilation successful${NC} (${DURATION}s, ${WARNING_COUNT} warning(s))"
    rm -f "$LOG_FILE"
    exit 0
fi
