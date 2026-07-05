#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from qq_engine import resolve_project_engine


SUPPORTED_LANGUAGES = {"en", "zh-CN", "ja", "ko"}
SUPPORTED_PRESETS = {"quickstart", "daily", "stabilize", "custom"}
SUPPORTED_HOST_SURFACES = {"claude", "codex", "both", "mcp"}
SUPPORTED_PROFILES = {"lightweight", "core", "feature", "hardening"}
SUPPORTED_TRUST_LEVELS = {"trusted", "balanced", "strict"}


TRANSLATIONS: dict[str, dict[str, str]] = {
    "en": {
        "wizard_title": "qq setup wizard",
        "detected_engine": "Detected engine",
        "detected_host": "Detected host tools",
        "pick_preset": "Pick a setup style",
        "preset_quickstart": "Quickstart — smallest useful setup, easiest first run",
        "preset_daily": "Daily — recommended for most teams and day-to-day feature work",
        "preset_stabilize": "Stabilize — safer defaults for risky changes and release prep",
        "preset_custom": "Custom — choose the pieces yourself",
        "pick_host": "Who will use qq most in this project?",
        "host_claude": "Claude",
        "host_codex": "Codex",
        "host_both": "Claude + Codex",
        "host_mcp": "MCP only",
        "pick_profile": "How heavy should the workflow feel?",
        "profile_lightweight": "lightweight — almost no ceremony",
        "profile_core": "core — light daily loop",
        "profile_feature": "feature — planning + review",
        "profile_hardening": "hardening — stronger checks before push",
        "pick_trust": "How much automatic helper behavior should qq allow?",
        "trust_trusted": "trusted — most automatic, best for your own day-to-day work",
        "trust_balanced": "balanced — safer middle ground",
        "trust_strict": "strict — explicit permissions only",
        "ask_pre_push": "Install the git pre-push gate too?",
        "yes": "yes",
        "no": "no",
        "preview_title": "qq will apply this setup",
        "summary_engine": "Engine",
        "summary_preset": "Preset",
        "summary_profile": "Profile",
        "summary_trust": "Trust level",
        "summary_hosts": "Install hosts",
        "summary_modules": "Extra install modules",
        "summary_sync": "Sync old managed files",
        "summary_file": "Config file",
        "confirm_apply": "Write this setup now?",
        "done_created": "qq.yaml created and configured.",
        "done_updated": "qq.yaml updated.",
        "invalid_choice": "Please pick one of the listed options.",
    },
    "zh-CN": {
        "wizard_title": "qq 安装向导",
        "detected_engine": "检测到的引擎",
        "detected_host": "检测到的宿主工具",
        "pick_preset": "先选一种安装方案",
        "preset_quickstart": "Quickstart — 最轻量，第一次上手最省事",
        "preset_daily": "Daily — 推荐，大多数团队日常开发都适合",
        "preset_stabilize": "Stabilize — 更稳，更适合高风险改动和发版前",
        "preset_custom": "Custom — 自己选",
        "pick_host": "这个项目里主要会用哪个宿主？",
        "host_claude": "Claude",
        "host_codex": "Codex",
        "host_both": "Claude + Codex",
        "host_mcp": "只要 MCP",
        "pick_profile": "流程想要多轻 / 多重？",
        "profile_lightweight": "lightweight — 几乎不讲流程，先跑起来",
        "profile_core": "core — 轻量日常循环",
        "profile_feature": "feature — 带规划和审阅",
        "profile_hardening": "hardening — push 前更严格",
        "pick_trust": "自动帮忙的力度要多大？",
        "trust_trusted": "trusted — 最顺手，适合你自己的日常开发",
        "trust_balanced": "balanced — 折中，更稳一点",
        "trust_strict": "strict — 尽量都显式确认",
        "ask_pre_push": "要不要顺手装 git pre-push 检查？",
        "yes": "要",
        "no": "不要",
        "preview_title": "qq 将会这样配置",
        "summary_engine": "引擎",
        "summary_preset": "方案",
        "summary_profile": "Profile",
        "summary_trust": "Trust level",
        "summary_hosts": "安装宿主",
        "summary_modules": "额外安装模块",
        "summary_sync": "同步清理旧的托管文件",
        "summary_file": "配置文件",
        "confirm_apply": "现在写入这套配置吗？",
        "done_created": "已创建并写入 qq.yaml。",
        "done_updated": "已更新 qq.yaml。",
        "invalid_choice": "请输入列表里的选项。",
    },
    "ja": {
        "wizard_title": "qq セットアップウィザード",
        "detected_engine": "検出したエンジン",
        "detected_host": "検出したホストツール",
        "pick_preset": "まずセットアップの種類を選んでください",
        "preset_quickstart": "Quickstart — 最小構成。最初の導入がいちばん簡単",
        "preset_daily": "Daily — 推奨。普段の開発ならこれで十分",
        "preset_stabilize": "Stabilize — より安全。大きな変更やリリース前向け",
        "preset_custom": "Custom — 自分で選ぶ",
        "pick_host": "このプロジェクトで主に使うホストは？",
        "host_claude": "Claude",
        "host_codex": "Codex",
        "host_both": "Claude + Codex",
        "host_mcp": "MCP のみ",
        "pick_profile": "ワークフローの重さはどれくらいにしますか？",
        "profile_lightweight": "lightweight — ほぼ儀式なし",
        "profile_core": "core — 軽い日常ループ",
        "profile_feature": "feature — 計画とレビュー付き",
        "profile_hardening": "hardening — push 前の検証を強める",
        "pick_trust": "自動補助の強さは？",
        "trust_trusted": "trusted — いちばん楽。普段の自分用に向く",
        "trust_balanced": "balanced — ほどよく安全",
        "trust_strict": "strict — 明示確認を優先",
        "ask_pre_push": "git pre-push チェックも入れますか？",
        "yes": "はい",
        "no": "いいえ",
        "preview_title": "qq は次の設定を書き込みます",
        "summary_engine": "エンジン",
        "summary_preset": "プリセット",
        "summary_profile": "Profile",
        "summary_trust": "Trust level",
        "summary_hosts": "インストールするホスト",
        "summary_modules": "追加インストールモジュール",
        "summary_sync": "古い managed files を同期削除",
        "summary_file": "設定ファイル",
        "confirm_apply": "この設定を書き込みますか？",
        "done_created": "qq.yaml を作成して設定しました。",
        "done_updated": "qq.yaml を更新しました。",
        "invalid_choice": "表示されている選択肢を入力してください。",
    },
    "ko": {
        "wizard_title": "qq 설치 마법사",
        "detected_engine": "감지된 엔진",
        "detected_host": "감지된 호스트 도구",
        "pick_preset": "먼저 설치 방식을 골라 주세요",
        "preset_quickstart": "Quickstart — 가장 가볍고 처음 쓰기 쉬움",
        "preset_daily": "Daily — 추천. 대부분의 팀 일상 개발에 적합",
        "preset_stabilize": "Stabilize — 더 안전함. 큰 변경이나 릴리스 직전에 적합",
        "preset_custom": "Custom — 직접 고르기",
        "pick_host": "이 프로젝트에서 주로 어떤 호스트를 쓰나요?",
        "host_claude": "Claude",
        "host_codex": "Codex",
        "host_both": "Claude + Codex",
        "host_mcp": "MCP만",
        "pick_profile": "워크플로를 얼마나 가볍게 / 무겁게 할까요?",
        "profile_lightweight": "lightweight — 거의 절차 없이 바로 시작",
        "profile_core": "core — 가벼운 일상 루프",
        "profile_feature": "feature — 계획 + 리뷰 포함",
        "profile_hardening": "hardening — push 전 검증 강화",
        "pick_trust": "자동 도우미 권한은 어느 정도로 할까요?",
        "trust_trusted": "trusted — 가장 편함. 개인 일상 작업용",
        "trust_balanced": "balanced — 적당히 안전한 기본값",
        "trust_strict": "strict — 명시적 허용 위주",
        "ask_pre_push": "git pre-push 검사도 같이 설치할까요?",
        "yes": "예",
        "no": "아니오",
        "preview_title": "qq가 다음 설정을 적용합니다",
        "summary_engine": "엔진",
        "summary_preset": "프리셋",
        "summary_profile": "Profile",
        "summary_trust": "Trust level",
        "summary_hosts": "설치할 호스트",
        "summary_modules": "추가 설치 모듈",
        "summary_sync": "오래된 managed files 동기화 삭제",
        "summary_file": "설정 파일",
        "confirm_apply": "이 설정을 지금 쓸까요?",
        "done_created": "qq.yaml을 만들고 설정했습니다.",
        "done_updated": "qq.yaml을 업데이트했습니다.",
        "invalid_choice": "표시된 항목 중에서 골라 주세요.",
    },
}


PRESET_DEFINITIONS: dict[str, dict[str, Any]] = {
    "quickstart": {
        "profile": "lightweight",
        "trust_level": "trusted",
        "pre_push": False,
        "sync": True,
    },
    "daily": {
        "profile": "feature",
        "trust_level": "trusted",
        "pre_push": False,
        "sync": True,
    },
    "stabilize": {
        "profile": "hardening",
        "trust_level": "balanced",
        "pre_push": True,
        "sync": True,
    },
}


def detect_language(explicit: str | None = None) -> str:
    candidate = (explicit or "").strip()
    if candidate in SUPPORTED_LANGUAGES:
        return candidate

    def map_locale(value: str) -> str | None:
        raw = (value or "").strip().lower()
        if raw.startswith("zh"):
            return "zh-CN"
        if raw.startswith("ja"):
            return "ja"
        if raw.startswith("ko"):
            return "ko"
        if raw.startswith("en"):
            return "en"
        return None

    detected = [map_locale(os.environ.get(name, "")) for name in ("LC_ALL", "LC_MESSAGES", "LANG")]
    for language in detected:
        if language and language != "en":
            return language
    for language in detected:
        if language:
            return language
    return "en"


def t(language: str, key: str) -> str:
    return TRANSLATIONS.get(language, TRANSLATIONS["en"]).get(key, key)


def detect_host_surface() -> str:
    has_claude = shutil.which("claude") is not None
    has_codex = shutil.which("codex") is not None
    if has_claude and has_codex:
        return "both"
    if has_claude:
        return "claude"
    if has_codex:
        return "codex"
    return "mcp"


def hosts_for_surface(host_surface: str) -> list[str]:
    if host_surface == "claude":
        return ["claude", "mcp"]
    if host_surface == "codex":
        return ["codex", "mcp"]
    if host_surface == "both":
        return ["claude", "codex", "mcp"]
    return ["mcp"]


def render_install_block(payload: dict[str, Any]) -> str:
    lines = ["install:"]
    hosts = list(payload.get("hosts") or [])
    lines.append("  hosts:")
    for host in hosts:
        lines.append(f"    - {host}")
    add_modules = list(payload.get("add_modules") or [])
    if add_modules:
        lines.append("  add_modules:")
        for module in add_modules:
            lines.append(f"    - {module}")
    else:
        lines.append("  add_modules: []")
    remove_modules = list(payload.get("remove_modules") or [])
    if remove_modules:
        lines.append("  remove_modules:")
        for module in remove_modules:
            lines.append(f"    - {module}")
    else:
        lines.append("  remove_modules: []")
    lines.append(f"  sync: {'true' if payload.get('sync') else 'false'}")
    return "\n".join(lines)


def replace_scalar(text: str, key: str, value: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(f"{key}:"):
            lines[index] = f"{key}: {value}"
            return "\n".join(lines) + "\n"
    insertion_index = 0
    if key == "trust_level":
        for index, line in enumerate(lines):
            if line.startswith("default_profile:"):
                insertion_index = index + 1
                break
    elif key == "default_profile":
        for index, line in enumerate(lines):
            if line.startswith("version:"):
                insertion_index = index + 1
                break
    lines.insert(insertion_index, f"{key}: {value}")
    return "\n".join(lines) + "\n"


def replace_install_block(text: str, install_payload: dict[str, Any]) -> str:
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.startswith("install:"):
            start = index
            break
    end = None
    if start is not None:
        end = len(lines)
        for index in range(start + 1, len(lines)):
            line = lines[index]
            if line and not line.startswith(" ") and line.endswith(":"):
                end = index
                break
        del lines[start:end]
        insert_at = start
    else:
        insert_at = len(lines)
        for index, line in enumerate(lines):
            if line.startswith("profiles:"):
                insert_at = index
                break
    block = render_install_block(install_payload).splitlines()
    lines[insert_at:insert_at] = block + [""]
    return "\n".join(lines).rstrip() + "\n"


def load_config_text(project_dir: Path, template_path: Path) -> tuple[str, Path, bool]:
    config_path = project_dir / "qq.yaml"
    if config_path.is_file():
        return config_path.read_text(encoding="utf-8"), config_path, False
    return template_path.read_text(encoding="utf-8"), config_path, True


def preset_payload(preset: str, host_surface: str) -> dict[str, Any]:
    base = dict(PRESET_DEFINITIONS[preset])
    install_payload = {
        "hosts": hosts_for_surface(host_surface),
        "add_modules": ["git-pre-push"] if base.get("pre_push") else [],
        "remove_modules": [],
        "sync": bool(base.get("sync")),
    }
    return {
        "preset": preset,
        "profile": base["profile"],
        "trust_level": base["trust_level"],
        "host_surface": host_surface,
        "install": install_payload,
    }


def build_custom_payload(
    *,
    profile: str,
    trust_level: str,
    host_surface: str,
    pre_push: bool,
) -> dict[str, Any]:
    return {
        "preset": "custom",
        "profile": profile,
        "trust_level": trust_level,
        "host_surface": host_surface,
        "install": {
            "hosts": hosts_for_surface(host_surface),
            "add_modules": ["git-pre-push"] if pre_push else [],
            "remove_modules": [],
            "sync": True,
        },
    }


def prompt_choice(language: str, label: str, options: list[tuple[str, str]], default: str) -> str:
    print(f"{label}:")
    for key, description in options:
        marker = " (default)" if key == default else ""
        print(f"  {key}: {description}{marker}")
    while True:
        raw = input("> ").strip()
        choice = raw or default
        if choice in {item[0] for item in options}:
            return choice
        print(t(language, "invalid_choice"))


def prompt_yes_no(language: str, label: str, default: bool) -> bool:
    default_label = t(language, "yes") if default else t(language, "no")
    yes_values = {"y", "yes", "1", "true", t(language, "yes").lower()}
    no_values = {"n", "no", "0", "false", t(language, "no").lower()}
    print(f"{label} [{default_label}]")
    while True:
        raw = input("> ").strip().lower()
        if not raw:
            return default
        if raw in yes_values:
            return True
        if raw in no_values:
            return False
        print(t(language, "invalid_choice"))


def run_interactive(language: str, detected_host_surface: str) -> dict[str, Any]:
    print(t(language, "wizard_title"))
    preset = prompt_choice(
        language,
        t(language, "pick_preset"),
        [
            ("quickstart", t(language, "preset_quickstart")),
            ("daily", t(language, "preset_daily")),
            ("stabilize", t(language, "preset_stabilize")),
            ("custom", t(language, "preset_custom")),
        ],
        "daily",
    )
    host_surface = prompt_choice(
        language,
        t(language, "pick_host"),
        [
            ("claude", t(language, "host_claude")),
            ("codex", t(language, "host_codex")),
            ("both", t(language, "host_both")),
            ("mcp", t(language, "host_mcp")),
        ],
        detected_host_surface,
    )
    if preset != "custom":
        return preset_payload(preset, host_surface)

    profile = prompt_choice(
        language,
        t(language, "pick_profile"),
        [
            ("lightweight", t(language, "profile_lightweight")),
            ("core", t(language, "profile_core")),
            ("feature", t(language, "profile_feature")),
            ("hardening", t(language, "profile_hardening")),
        ],
        "feature",
    )
    trust_level = prompt_choice(
        language,
        t(language, "pick_trust"),
        [
            ("trusted", t(language, "trust_trusted")),
            ("balanced", t(language, "trust_balanced")),
            ("strict", t(language, "trust_strict")),
        ],
        "trusted",
    )
    pre_push = prompt_yes_no(language, t(language, "ask_pre_push"), False)
    return build_custom_payload(
        profile=profile,
        trust_level=trust_level,
        host_surface=host_surface,
        pre_push=pre_push,
    )


def summary_payload(
    *,
    language: str,
    engine: str,
    config_path: Path,
    created: bool,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "language": language,
        "engine": engine,
        "preset": payload["preset"],
        "profile": payload["profile"],
        "trustLevel": payload["trust_level"],
        "hostSurface": payload["host_surface"],
        "installHosts": list(payload["install"]["hosts"]),
        "installAddModules": list(payload["install"].get("add_modules") or []),
        "installRemoveModules": list(payload["install"].get("remove_modules") or []),
        "installSync": bool(payload["install"].get("sync")),
        "configPath": str(config_path),
        "created": created,
    }


def print_summary(language: str, summary: dict[str, Any]) -> None:
    print(t(language, "preview_title"))
    print(f"- {t(language, 'summary_engine')}: {summary['engine']}")
    print(f"- {t(language, 'summary_preset')}: {summary['preset']}")
    print(f"- {t(language, 'summary_profile')}: {summary['profile']}")
    print(f"- {t(language, 'summary_trust')}: {summary['trustLevel']}")
    print(f"- {t(language, 'summary_hosts')}: {', '.join(summary['installHosts'])}")
    modules = summary["installAddModules"] or ["none"]
    print(f"- {t(language, 'summary_modules')}: {', '.join(modules)}")
    print(f"- {t(language, 'summary_sync')}: {'yes' if summary['installSync'] else 'no'}")
    print(f"- {t(language, 'summary_file')}: {summary['configPath']}")


def apply_payload(template_path: Path, project_dir: Path, engine: str, language: str, payload: dict[str, Any]) -> dict[str, Any]:
    text, config_path, created = load_config_text(project_dir, template_path)
    updated = replace_scalar(text, "default_profile", payload["profile"])
    updated = replace_scalar(updated, "trust_level", payload["trust_level"])
    updated = replace_install_block(updated, payload["install"])
    config_path.write_text(updated, encoding="utf-8")
    summary = summary_payload(
        language=language,
        engine=engine,
        config_path=config_path,
        created=created,
        payload=payload,
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Localized onboarding helper for qq project installs")
    subparsers = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--project", default=".", help="Supported engine project root")
    common.add_argument("--engine", help="Override detected engine id")
    common.add_argument("--template", default="templates/qq.yaml.example", help="qq.yaml template path")
    common.add_argument("--language", choices=sorted(SUPPORTED_LANGUAGES), help="Force UI language")
    common.add_argument("--host-surface", choices=sorted(SUPPORTED_HOST_SURFACES), help="Force host selection")
    common.add_argument("--preset", choices=sorted(SUPPORTED_PRESETS - {'custom'}), help="Apply a preset without asking questions")
    common.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable output")

    preview_parser = subparsers.add_parser("preview", parents=[common], help="Preview the setup without writing qq.yaml")
    preview_parser.add_argument("--profile", choices=sorted(SUPPORTED_PROFILES), help="Custom profile for preview")
    preview_parser.add_argument("--trust-level", choices=sorted(SUPPORTED_TRUST_LEVELS), help="Custom trust level for preview")
    preview_parser.add_argument("--with-pre-push", action="store_true", help="Include git-pre-push in custom preview")

    apply_parser = subparsers.add_parser("apply", parents=[common], help="Write the selected setup into qq.yaml")
    apply_parser.add_argument("--interactive", action="store_true", help="Run the interactive wizard")
    apply_parser.add_argument("--profile", choices=sorted(SUPPORTED_PROFILES), help="Custom profile when not using a preset")
    apply_parser.add_argument("--trust-level", choices=sorted(SUPPORTED_TRUST_LEVELS), help="Custom trust level when not using a preset")
    apply_parser.add_argument("--with-pre-push", action="store_true", help="Include git-pre-push in custom setup")
    return parser.parse_args()


def resolve_payload(args: argparse.Namespace, language: str, detected_host_surface: str) -> dict[str, Any]:
    host_surface = args.host_surface or detected_host_surface
    if args.command == "apply" and args.interactive:
        return run_interactive(language, host_surface)
    if args.preset:
        return preset_payload(args.preset, host_surface)
    profile = args.profile or "feature"
    trust_level = args.trust_level or "trusted"
    return build_custom_payload(
        profile=profile,
        trust_level=trust_level,
        host_surface=host_surface,
        pre_push=bool(args.with_pre_push),
    )


def emit(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return
    language = payload["language"]
    print_summary(language, payload)
    if payload.get("written"):
        print(t(language, "done_created") if payload.get("created") else t(language, "done_updated"))


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project).expanduser().resolve()
    template_path = Path(args.template).expanduser().resolve()
    engine = args.engine or resolve_project_engine(project_dir)
    if not engine:
        raise SystemExit(f"Error: {project_dir} is not a supported engine project")
    language = detect_language(args.language)
    detected_host_surface = detect_host_surface()
    payload = resolve_payload(args, language, detected_host_surface)

    if args.command == "preview":
        summary = summary_payload(
            language=language,
            engine=engine,
            config_path=(project_dir / "qq.yaml").resolve(),
            created=not (project_dir / "qq.yaml").is_file(),
            payload=payload,
        )
        emit(summary, args.json)
        return 0

    if args.interactive and not sys.stdin.isatty():
        raise SystemExit("Error: --interactive requires a TTY. Use --preset for non-interactive setup.")

    if args.interactive and not args.json:
        preview = summary_payload(
            language=language,
            engine=engine,
            config_path=(project_dir / "qq.yaml").resolve(),
            created=not (project_dir / "qq.yaml").is_file(),
            payload=payload,
        )
        print_summary(language, preview)
        confirmed = prompt_yes_no(language, t(language, "confirm_apply"), True)
        if not confirmed:
            raise SystemExit(1)
    summary = apply_payload(template_path, project_dir, engine, language, payload)
    summary["written"] = True
    emit(summary, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
