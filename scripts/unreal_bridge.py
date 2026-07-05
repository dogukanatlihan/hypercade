#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from qq_bridge_common import (
    BridgeError,
    build_tool_result,
    latest_stage_record,
    load_json_file,
    normalize_run_status,
    pretty_json,
    run_command,
)
from qq_engine import bridge_server_name, engine_metadata, resolve_project_engine


CAPABILITIES_PATH = Path(__file__).resolve().with_name("unreal_capabilities.json")
PLUGIN_STATE_TTL_SEC = 5.0
REQUEST_POLL_INTERVAL_SEC = 0.1
DEFAULT_BRIDGE_TIMEOUT_SEC = 20
DEFAULT_EDITOR_BOOT_TIMEOUT_SEC = 120


TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "unreal_health": {
        "title": "Unreal Health",
        "description": "Check Unreal project discovery, editor bridge wiring, and qq prerequisites.",
        "inputSchema": {"type": "object", "properties": {"project_dir": {"type": "string"}}},
    },
    "unreal_doctor": {
        "title": "Unreal Doctor",
        "description": "Run qq-doctor for an Unreal project and return the normalized diagnosis.",
        "inputSchema": {"type": "object", "properties": {"project_dir": {"type": "string"}}},
    },
    "unreal_compile": {
        "title": "Unreal Compile",
        "description": "Run the Unreal compile workflow for this project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "timeout_sec": {"type": "integer", "minimum": 1},
            },
        },
    },
    "unreal_run_tests": {
        "title": "Unreal Run Tests",
        "description": "Run the Unreal automation test workflow for this project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "mode": {"type": "string"},
                "filter": {"type": "string"},
                "timeout_sec": {"type": "integer", "minimum": 1},
            },
        },
    },
    "unreal_console": {
        "title": "Unreal Console",
        "description": "Read or clear qq Unreal bridge console output.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {"type": "string", "enum": ["get", "clear"]},
                "count": {"type": "integer", "minimum": 1},
                "filter": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    "unreal_editor": {
        "title": "Unreal Editor",
        "description": "Control high-level Unreal editor actions such as play mode, map loading, and level saves.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {"type": "string", "enum": ["play", "stop", "open_map", "new_level", "save_all", "save_current_level"]},
                "path": {"type": "string"},
                "partitioned": {"type": "boolean"},
            },
            "required": ["action"],
        },
    },
    "unreal_query": {
        "title": "Unreal Query",
        "description": "Read Unreal editor state, hierarchy, actors, maps, and selection.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {"type": "string", "enum": ["status", "hierarchy", "find", "inspect", "get_selection", "list_maps"]},
                "depth": {"type": "integer", "minimum": 1},
                "filter": {"type": "string"},
                "name": {"type": "string"},
                "path": {"type": "string"},
                "class_name": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    "unreal_object": {
        "title": "Unreal Objects",
        "description": "Create and mutate actors, transforms, attachments, selection, and editable properties.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {"type": "string", "enum": ["create", "destroy", "duplicate", "set_transform", "set_parent", "set_property", "select"]},
                "path": {"type": "string"},
                "parent": {"type": "string"},
                "label": {"type": "string"},
                "class_path": {"type": "string"},
                "location": {"type": "array", "items": {"type": "number"}},
                "rotation": {"type": "array", "items": {"type": "number"}},
                "scale": {"type": "array", "items": {"type": "number"}},
                "offset": {"type": "array", "items": {"type": "number"}},
                "mode": {"type": "string", "enum": ["keep_world", "keep_relative", "snap_to_target"]},
                "name": {"type": "string"},
                "component": {"type": "string"},
                "property": {"type": "string"},
                "value": {},
                "select": {"type": "boolean"},
            },
            "required": ["action"],
        },
    },
    "unreal_assets": {
        "title": "Unreal Assets",
        "description": "Query and mutate Unreal assets, maps, and content folders.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {"type": "string", "enum": ["list_assets", "list_maps", "inspect_asset", "create_directory", "create_material", "duplicate_asset", "rename_asset", "delete_asset", "save_asset"]},
                "path": {"type": "string"},
                "source": {"type": "string"},
                "filter": {"type": "string"},
                "class_name": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    "unreal_batch": {
        "title": "Unreal Batch",
        "description": "Execute multiple Unreal bridge tool calls in one request.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string"},
                            "arguments": {"type": "object"},
                        },
                    },
                }
            },
            "required": ["operations"],
        },
    },
    "unreal_raw_command": {
        "title": "Unreal Raw Command",
        "description": "Send an arbitrary command to the Unreal editor helper script.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "command": {"type": "string"},
                "args": {"type": "object"},
                "timeout_sec": {"type": "integer", "minimum": 1},
            },
            "required": ["command"],
        },
    },
}


EDITOR_ACTIONS = {
    "play": "play",
    "stop": "stop",
    "open_map": "open-map",
    "new_level": "new-level",
    "save_all": "save-all",
    "save_current_level": "save-current-level",
}

QUERY_ACTIONS = {
    "status": "status",
    "hierarchy": "hierarchy",
    "find": "find-actors",
    "inspect": "inspect-actor",
    "get_selection": "get-selection",
    "list_maps": "list-maps",
}

OBJECT_ACTIONS = {
    "create": "create-actor",
    "destroy_actor": "destroy-actor",
    "destroy": "destroy-actor",
    "duplicate": "duplicate-actor",
    "set_transform": "set-actor-transform",
    "set_parent": "set-parent",
    "set_property": "set-property",
    "select": "select-actor",
}

ASSET_ACTIONS = {
    "list_assets": "list-assets",
    "list_maps": "list-maps",
    "inspect_asset": "inspect-asset",
    "create_directory": "create-directory",
    "create_material": "create-material",
    "duplicate_asset": "duplicate-asset",
    "rename_asset": "rename-asset",
    "delete_asset": "delete-asset",
    "save_asset": "save-asset",
}


def load_capabilities(profile: str | None = None) -> dict[str, Any]:
    payload = load_json_file(CAPABILITIES_PATH)
    selected = str(profile or payload.get("defaultProfile") or "standard")
    tools = payload.get("profiles", {}).get(selected) or []
    annotations = payload.get("toolAnnotations") or {}
    return {
        "protocolVersions": payload.get("protocolVersions") or ["2024-11-05"],
        "tools": [tool for tool in tools if tool in TOOL_DEFINITIONS],
        "annotations": annotations,
    }


def find_unreal_project_file(project_dir: Path) -> Path | None:
    for path in sorted(project_dir.glob("*.uproject")):
        if path.is_file():
            return path
    return None


def enabled_unreal_plugins(project_dir: Path) -> dict[str, bool]:
    project_file = find_unreal_project_file(project_dir)
    if project_file is None:
        return {}
    try:
        payload = load_json_file(project_file)
    except Exception:
        return {}
    enabled: dict[str, bool] = {}
    for item in payload.get("Plugins") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("Name") or "").strip()
        if not name:
            continue
        enabled[name] = bool(item.get("Enabled", False))
    return enabled


def gather_config_tree_text(root: Path) -> str:
    if not root.is_dir():
        return ""
    parts: list[str] = []
    for path in sorted(root.rglob("*.ini")):
        if not path.is_file():
            continue
        try:
            parts.append(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
    return "\n".join(parts)


def gather_unreal_config_text(project_dir: Path) -> str:
    parts = [
        gather_config_tree_text(project_dir / "Config"),
        gather_config_tree_text(project_dir / "Saved" / "Config"),
    ]
    return "\n".join(part for part in parts if part)


def tail_text(path: Path, max_chars: int = 12000) -> str:
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    return text[-max_chars:]


def is_process_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def normalize_editor_gui_path(value: str) -> str:
    candidate = Path(value).expanduser()
    if candidate.is_dir() and candidate.name == "UnrealEditor.app":
        app_binary = candidate / "Contents" / "MacOS" / "UnrealEditor"
        if app_binary.is_file():
            return str(app_binary)
    if candidate.is_file() and candidate.name == "UnrealEditor" and candidate.parent.name == "Mac":
        app_binary = candidate.parent / "UnrealEditor.app" / "Contents" / "MacOS" / "UnrealEditor"
        if app_binary.is_file():
            return str(app_binary)
    return str(candidate)


def find_editor_gui_cmd() -> str:
    for key in ("UNREAL_EDITOR", "UE_EDITOR", "UNREAL_EDITOR_GUI", "UE_EDITOR_GUI"):
        value = str(os.environ.get(key) or "").strip()
        if value:
            return normalize_editor_gui_path(value)

    engine_root = str(os.environ.get("UNREAL_ENGINE_ROOT") or os.environ.get("UE_ENGINE_ROOT") or os.environ.get("UE_ROOT") or "").strip()
    candidates: list[Path] = []
    if engine_root:
        candidates.extend(
            [
                Path(engine_root) / "Engine" / "Binaries" / "Mac" / "UnrealEditor.app" / "Contents" / "MacOS" / "UnrealEditor",
                Path(engine_root) / "Engine" / "Binaries" / "Mac" / "UnrealEditor",
                Path(engine_root) / "Engine" / "Binaries" / "Linux" / "UnrealEditor",
                Path(engine_root) / "Engine" / "Binaries" / "Win64" / "UnrealEditor.exe",
            ]
        )
    for candidate in candidates:
        if candidate.is_file():
            return normalize_editor_gui_path(str(candidate))
    resolved = shutil.which("UnrealEditor")
    if resolved:
        return normalize_editor_gui_path(resolved)
    raise BridgeError("COMMAND_NOT_FOUND", "Unable to resolve UnrealEditor. Set UNREAL_EDITOR or UE_EDITOR.")


class UnrealQueueClient:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir.resolve()
        self.project_file = find_unreal_project_file(self.project_dir)
        if self.project_file is None:
            raise BridgeError("PROJECT_NOT_SUPPORTED", f"No .uproject file found in {project_dir}")
        self.metadata = engine_metadata("unreal")

    @property
    def state_path(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeStateFile") or ".qq/state/qq-unreal-editor-bridge.json")

    @property
    def request_dir(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeRequestDir") or ".qq/state/qq-unreal-editor/requests")

    @property
    def response_dir(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeResponseDir") or ".qq/state/qq-unreal-editor/responses")

    @property
    def console_path(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeConsoleFile") or ".qq/state/qq-unreal-editor-console.jsonl")

    @property
    def log_path(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeLogFile") or ".qq/state/qq-unreal-editor.log")

    @property
    def bootstrap_path(self) -> Path:
        support_dir = str(self.metadata.get("engineSupportTargetDir") or "Content/Python")
        return self.project_dir / support_dir / "qq_unreal_bridge.py"

    @property
    def startup_command(self) -> str:
        return str(self.metadata.get("editorBridgeStartupCommand") or "")

    def bootstrap_installed(self) -> bool:
        return self.bootstrap_path.is_file()

    def startup_configured(self) -> bool:
        config_text = gather_unreal_config_text(self.project_dir)
        return bool(self.startup_command) and self.startup_command in config_text

    def ensure_runtime_dirs(self) -> None:
        self.request_dir.mkdir(parents=True, exist_ok=True)
        self.response_dir.mkdir(parents=True, exist_ok=True)
        self.console_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def load_state(self) -> dict[str, Any]:
        if not self.state_path.is_file():
            return {}
        try:
            return load_json_file(self.state_path)
        except Exception:
            return {}

    def bridge_health(self) -> dict[str, Any]:
        state = self.load_state()
        heartbeat = float(state.get("lastHeartbeatUnix") or 0.0)
        age_sec = (time.time() - heartbeat) if heartbeat > 0 else None
        pid = int(state.get("pid") or 0) if state else 0
        running = bool(state.get("running")) and age_sec is not None and age_sec <= PLUGIN_STATE_TTL_SEC
        warnings: list[str] = []
        if not self.bootstrap_installed():
            warnings.append("qq Unreal editor bridge bootstrap is missing from Content/Python")
        if not self.startup_configured():
            warnings.append("Unreal Python startup hook is not configured for the qq editor bridge")
        if not self.state_path.is_file():
            warnings.append("Unreal editor bridge state file has not been written yet")
        elif not running:
            warnings.append("Unreal editor bridge heartbeat is stale or the editor is not open")
        return {
            "bootstrapInstalled": self.bootstrap_installed(),
            "startupConfigured": self.startup_configured(),
            "stateFile": str(self.state_path),
            "requestDir": str(self.request_dir),
            "responseDir": str(self.response_dir),
            "consoleFile": str(self.console_path),
            "logFile": str(self.log_path),
            "running": running,
            "lastHeartbeatUnix": heartbeat,
            "lastHeartbeatAgeSec": age_sec,
            "pid": pid,
            "pidRunning": is_process_running(pid),
            "state": state,
            "warnings": warnings,
        }

    def launch_editor(self) -> subprocess.Popen[str]:
        editor_cmd = find_editor_gui_cmd()
        self.ensure_runtime_dirs()
        log_handle = self.log_path.open("a", encoding="utf-8")
        try:
            process = subprocess.Popen(
                [
                    editor_cmd,
                    str(self.project_file),
                    "-nop4",
                    "-nosplash",
                    "-stdout",
                    "-FullStdOutLogOutput",
                ],
                cwd=str(self.project_dir),
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
                env=os.environ.copy(),
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            log_handle.close()
            raise BridgeError("COMMAND_NOT_FOUND", f"Command not found: {editor_cmd}", {"error": str(exc)}) from exc
        log_handle.close()
        return process

    def ensure_bridge_running(self, boot_timeout_sec: int | None = None) -> None:
        timeout = int(boot_timeout_sec or DEFAULT_EDITOR_BOOT_TIMEOUT_SEC)
        health = self.bridge_health()
        if health["running"]:
            return
        if not health["bootstrapInstalled"] or not health["startupConfigured"]:
            raise BridgeError(
                "BRIDGE_NOT_READY",
                "The Unreal editor bridge is not installed or configured for startup",
                health,
            )

        if health["pidRunning"]:
            wait_deadline = time.time() + 10
            while time.time() < wait_deadline:
                health = self.bridge_health()
                if health["running"]:
                    return
                time.sleep(REQUEST_POLL_INTERVAL_SEC)

        process = self.launch_editor()
        deadline = time.time() + timeout
        while time.time() < deadline:
            health = self.bridge_health()
            if health["running"]:
                return
            if process.poll() is not None:
                raise BridgeError(
                    "EDITOR_START_FAILED",
                    "UnrealEditor exited before the qq editor bridge became ready",
                    {
                        "exitCode": process.returncode,
                        "logFile": str(self.log_path),
                        "logTail": tail_text(self.log_path),
                    },
                )
            time.sleep(REQUEST_POLL_INTERVAL_SEC)

        raise BridgeError(
            "BRIDGE_TIMEOUT",
            "Timed out waiting for the Unreal editor bridge to become ready",
            {
                "logFile": str(self.log_path),
                "logTail": tail_text(self.log_path),
                "health": self.bridge_health(),
            },
        )

    def send_command(self, command: str, args: dict[str, Any] | None = None, *, timeout_sec: int | None = None) -> dict[str, Any]:
        timeout = int(timeout_sec or DEFAULT_BRIDGE_TIMEOUT_SEC)
        self.ensure_bridge_running(boot_timeout_sec=max(timeout, DEFAULT_EDITOR_BOOT_TIMEOUT_SEC))
        self.ensure_runtime_dirs()
        request_id = uuid.uuid4().hex
        request_path = self.request_dir / f"{request_id}.json"
        response_path = self.response_dir / f"{request_id}.json"
        payload = {
            "requestId": request_id,
            "command": command,
            "args": args or {},
            "createdAtUnix": time.time(),
        }
        temp_path = request_path.with_suffix(".json.tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temp_path.replace(request_path)

        deadline = time.time() + timeout
        while time.time() < deadline:
            if response_path.is_file():
                response = load_json_file(response_path)
                response_path.unlink(missing_ok=True)
                return response
            time.sleep(REQUEST_POLL_INTERVAL_SEC)

        raise BridgeError(
            "BRIDGE_TIMEOUT",
            f"Unreal editor bridge timed out waiting for {command}",
            {
                "command": command,
                "requestId": request_id,
                "stateFile": str(self.state_path),
                "logFile": str(self.log_path),
                "logTail": tail_text(self.log_path),
                "health": self.bridge_health(),
            },
        )

    def read_console_entries(self, count: int = 50, filter_text: str | None = None) -> list[dict[str, Any]]:
        if not self.console_path.is_file():
            return []
        entries: list[dict[str, Any]] = []
        needle = str(filter_text or "").lower().strip()
        for line in self.console_path.read_text(encoding="utf-8").splitlines():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            haystack = json.dumps(payload, ensure_ascii=False).lower()
            if needle and needle not in haystack:
                continue
            entries.append(payload)
        return entries[-max(count, 1):]

    def clear_console(self) -> None:
        self.console_path.parent.mkdir(parents=True, exist_ok=True)
        self.console_path.write_text("", encoding="utf-8")


class UnrealBridge:
    def __init__(self, default_project_dir: str, profile: str | None = None):
        self.engine = "unreal"
        self.default_project_dir = default_project_dir
        self.profile = profile or "standard"
        capabilities = load_capabilities(profile)
        self.supported_protocol_versions = list(capabilities["protocolVersions"])
        self.allowed_tools = set(capabilities["tools"])
        self.tool_annotations = capabilities["annotations"]
        self.server_name = bridge_server_name("unreal") or "qq-unreal"
        self.instructions = (
            "This bridge exposes typed Unreal tools backed by the built-in qq Unreal editor bridge. "
            "Use unreal_compile and unreal_run_tests for workflow verification, then unreal_query, "
            "unreal_editor, unreal_object, and unreal_assets for live editor inspection and mutation."
        )

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        for name in self.allowed_tools:
            definition = dict(TOOL_DEFINITIONS[name])
            definition["name"] = name
            annotations = self.tool_annotations.get(name) or {}
            if annotations:
                definition["annotations"] = annotations
            tools.append(definition)
        return sorted(tools, key=lambda item: str(item.get("name") or ""))

    def tool_result(self, structured: dict[str, Any], is_error: bool | None = None) -> dict[str, Any]:
        message = str(structured.get("message") or structured.get("summary") or "Unreal bridge operation completed")
        return build_tool_result(structured, default_message=message, is_error=is_error)

    def call_tool(self, tool_name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        if tool_name not in self.allowed_tools:
            raise BridgeError("UNKNOWN_TOOL", f"Unknown tool: {tool_name}")
        args = arguments or {}
        if tool_name == "unreal_health":
            return self.health(args)
        if tool_name == "unreal_doctor":
            return self.doctor(args)
        if tool_name == "unreal_compile":
            return self.compile(args)
        if tool_name == "unreal_run_tests":
            return self.run_tests(args)
        if tool_name == "unreal_console":
            return self.console(args)
        if tool_name == "unreal_editor":
            return self.action_tool(args, EDITOR_ACTIONS, "unreal_editor")
        if tool_name == "unreal_query":
            return self.action_tool(args, QUERY_ACTIONS, "unreal_query")
        if tool_name == "unreal_object":
            return self.action_tool(args, OBJECT_ACTIONS, "unreal_object")
        if tool_name == "unreal_assets":
            return self.action_tool(args, ASSET_ACTIONS, "unreal_assets")
        if tool_name == "unreal_batch":
            return self.batch(args)
        if tool_name == "unreal_raw_command":
            return self.raw_command(args)
        raise BridgeError("UNKNOWN_TOOL", f"Unknown tool: {tool_name}")

    def resolve_project(self, project_dir: str | None = None) -> Path:
        candidate = (
            project_dir
            or self.default_project_dir
            or os.environ.get("QQ_PROJECT_DIR")
            or os.environ.get("UNREAL_PROJECT_DIR")
            or "."
        )
        project = Path(candidate).expanduser().resolve()
        engine = resolve_project_engine(project)
        if engine != "unreal":
            raise BridgeError("PROJECT_NOT_SUPPORTED", f"No Unreal project detected at: {project}")
        return project

    def queue_client(self, project_dir: str | None = None) -> UnrealQueueClient:
        return UnrealQueueClient(self.resolve_project(project_dir))

    def health(self, args: dict[str, Any]) -> dict[str, Any]:
        project_dir = self.resolve_project(args.get("project_dir"))
        metadata = engine_metadata("unreal")
        project_file = find_unreal_project_file(project_dir)
        editor_command = ""
        warnings: list[str] = []
        try:
            editor_command = find_editor_gui_cmd()
        except BridgeError as exc:
            warnings.append(exc.message)
        enabled_plugins = enabled_unreal_plugins(project_dir)
        required_plugins = [str(item) for item in metadata.get("requiredProjectPlugins") or [] if str(item)]
        missing_plugins = [name for name in required_plugins if not enabled_plugins.get(name)]
        bridge = self.queue_client(str(project_dir))
        bridge_health = bridge.bridge_health()
        scripts = [
            project_dir / "scripts" / "qq_mcp.py",
            project_dir / "scripts" / "unreal_bridge.py",
            project_dir / "scripts" / "unreal_editor_command.py",
            project_dir / "scripts" / "unreal_capabilities.json",
            project_dir / "scripts" / "qq-compile.sh",
            project_dir / "scripts" / "qq-test.sh",
        ]
        missing_scripts = [path.relative_to(project_dir).as_posix() for path in scripts if not path.is_file()]
        if project_file is None:
            warnings.append("No .uproject file found in the project root")
        if missing_scripts:
            warnings.append("qq Unreal bridge scripts are missing from the project")
        if missing_plugins:
            warnings.append("Required Unreal project plugins are not enabled")
        warnings.extend(str(item) for item in bridge_health["warnings"])
        ok = bool(project_file) and bool(editor_command) and not missing_scripts and not missing_plugins and bridge_health["bootstrapInstalled"] and bridge_health["startupConfigured"] and bridge_health["running"]
        return {
            "ok": ok,
            "category": "OK" if ok else "WARN",
            "message": "Unreal editor bridge reachable" if ok else "Unreal editor bridge is missing prerequisites or not running",
            "engine": "unreal",
            "engineName": "Unreal",
            "project_dir": str(project_dir),
            "project_file": str(project_file) if project_file else "",
            "editor_command": editor_command,
            "qq_scripts_available": not missing_scripts,
            "missing_scripts": missing_scripts,
            "required_plugins": required_plugins,
            "enabled_plugins": enabled_plugins,
            "missing_plugins": missing_plugins,
            "bootstrap_path": bridge_health["bootstrapInstalled"] and str(bridge.bootstrap_path) or "",
            "startup_configured": bridge_health["startupConfigured"],
            "editor_running": bridge_health["running"],
            "bridge_state_file": bridge_health["stateFile"],
            "request_dir": bridge_health["requestDir"],
            "response_dir": bridge_health["responseDir"],
            "console_file": bridge_health["consoleFile"],
            "log_file": bridge_health["logFile"],
            "last_heartbeat_unix": bridge_health["lastHeartbeatUnix"],
            "last_heartbeat_age_sec": bridge_health["lastHeartbeatAgeSec"],
            "warnings": warnings,
        }

    def doctor(self, args: dict[str, Any]) -> dict[str, Any]:
        project_dir = self.resolve_project(args.get("project_dir"))
        result = run_command([sys.executable, str(project_dir / "scripts" / "qq-doctor.py"), "--project", str(project_dir)], cwd=project_dir)
        if result.returncode != 0:
            raise BridgeError("DOCTOR_FAILED", result.stderr.strip() or result.stdout.strip() or "qq-doctor failed")
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise BridgeError("DOCTOR_FAILED", "qq-doctor returned a non-object payload")
        payload.setdefault("ok", True)
        payload.setdefault("message", "qq doctor completed")
        return payload

    def compile(self, args: dict[str, Any]) -> dict[str, Any]:
        project_dir = self.resolve_project(args.get("project_dir"))
        timeout_sec = int(args.get("timeout_sec") or 0) or None
        result = run_command(["bash", str(project_dir / "scripts" / "unreal-compile.sh"), "--project", str(project_dir)], cwd=project_dir, timeout_sec=timeout_sec)
        record = latest_stage_record(project_dir, "compile")
        status = normalize_run_status(record.get("status"), result.returncode)
        return {
            "ok": status in {"passed", "warning"},
            "state": status,
            "message": str(record.get("summary") or result.stderr.strip() or result.stdout.strip() or "Unreal compile finished"),
            "engine": "unreal",
            "project_dir": str(project_dir),
            "backend": str(record.get("backend") or ""),
            "transport": str(record.get("transport") or ""),
            "failureCategory": str(record.get("failure_category") or ""),
            "recordPath": str(record.get("record_path") or ""),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exitCode": result.returncode,
        }

    def run_tests(self, args: dict[str, Any]) -> dict[str, Any]:
        project_dir = self.resolve_project(args.get("project_dir"))
        timeout_sec = int(args.get("timeout_sec") or 0) or None
        mode = str(args.get("mode") or "").strip()
        filter_value = str(args.get("filter") or "").strip()
        command = ["bash", str(project_dir / "scripts" / "unreal-test.sh")]
        if mode:
            command.append(mode)
        command.extend(["--project", str(project_dir)])
        if filter_value:
            command.extend(["--filter", filter_value])
        if timeout_sec:
            command.extend(["--timeout", str(timeout_sec)])
        result = run_command(command, cwd=project_dir, timeout_sec=timeout_sec)
        record = latest_stage_record(project_dir, "test")
        status = normalize_run_status(record.get("status"), result.returncode)
        return {
            "ok": status in {"passed", "warning"},
            "state": status,
            "message": str(record.get("summary") or result.stderr.strip() or result.stdout.strip() or "Unreal test run finished"),
            "engine": "unreal",
            "project_dir": str(project_dir),
            "backend": str(record.get("backend") or ""),
            "transport": str(record.get("transport") or ""),
            "failureCategory": str(record.get("failure_category") or ""),
            "recordPath": str(record.get("record_path") or ""),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exitCode": result.returncode,
        }

    def console(self, args: dict[str, Any]) -> dict[str, Any]:
        action = str(args.get("action") or "").strip()
        if action not in {"get", "clear"}:
            raise BridgeError("INVALID_ARGUMENT", "unreal_console.action must be 'get' or 'clear'")
        client = self.queue_client(args.get("project_dir"))
        if action == "get":
            entries = client.read_console_entries(int(args.get("count") or 50), str(args.get("filter") or "").strip() or None)
            return {"ok": True, "action": action, "entries": entries, "message": f"Retrieved {len(entries)} bridge console entries"}
        client.clear_console()
        return {"ok": True, "action": action, "message": "Cleared Unreal bridge console entries"}

    def action_tool(self, args: dict[str, Any], mapping: dict[str, str], tool_name: str) -> dict[str, Any]:
        action = str(args.get("action") or "").strip()
        if action not in mapping:
            raise BridgeError("INVALID_ARGUMENT", f"{tool_name}.action is invalid: {action}")
        command_args = {key: value for key, value in args.items() if key not in {"project_dir", "action", "timeout_sec"}}
        response = self.queue_client(args.get("project_dir")).send_command(mapping[action], command_args, timeout_sec=int(args.get("timeout_sec") or 0) or None)
        return {
            "ok": bool(response.get("ok")),
            "action": action,
            "category": str(response.get("category") or ""),
            "message": str(response.get("message") or f"{tool_name} action completed"),
            "response": response.get("data"),
        }

    def batch(self, args: dict[str, Any]) -> dict[str, Any]:
        operations = args.get("operations") or []
        if not isinstance(operations, list) or not operations:
            raise BridgeError("INVALID_ARGUMENT", "unreal_batch.operations must be a non-empty array")
        available_tools = {tool["name"] for tool in self.list_tools()}
        results: list[dict[str, Any]] = []
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict):
                results.append({"ok": False, "index": index, "message": "Operation must be an object"})
                continue
            tool_name = str(operation.get("tool") or "")
            if tool_name not in available_tools:
                results.append({"ok": False, "index": index, "message": f"Unknown tool: {tool_name}"})
                continue
            if tool_name == "unreal_batch":
                results.append({"ok": False, "index": index, "message": "unreal_batch cannot recursively call itself"})
                continue
            tool_args = operation.get("arguments") or {}
            if not isinstance(tool_args, dict):
                results.append({"ok": False, "index": index, "message": "Operation arguments must be an object"})
                continue
            if "project_dir" not in tool_args and args.get("project_dir"):
                tool_args = {"project_dir": args.get("project_dir"), **tool_args}
            try:
                results.append({"ok": True, "index": index, "tool": tool_name, "result": self.call_tool(tool_name, tool_args)})
            except BridgeError as exc:
                results.append({"ok": False, "index": index, "tool": tool_name, "message": exc.message, "category": exc.category})
        return {"ok": all(item.get("ok") for item in results), "message": f"Executed {len(results)} Unreal batch operation(s)", "results": results}

    def raw_command(self, args: dict[str, Any]) -> dict[str, Any]:
        command = str(args.get("command") or "").strip()
        if not command:
            raise BridgeError("INVALID_ARGUMENT", "unreal_raw_command.command is required")
        raw_args = args.get("args") or {}
        if not isinstance(raw_args, dict):
            raise BridgeError("INVALID_ARGUMENT", "unreal_raw_command.args must be an object")
        response = self.queue_client(args.get("project_dir")).send_command(command, raw_args, timeout_sec=int(args.get("timeout_sec") or 0) or None)
        return {
            "ok": bool(response.get("ok")),
            "category": str(response.get("category") or ""),
            "message": str(response.get("message") or f"Executed raw command: {command}"),
            "response": response.get("data"),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Unreal bridge helper")
    parser.add_argument("--project", help="Unreal project root")
    parser.add_argument("--profile", choices=["standard", "full"], help="Tool profile to expose")
    parser.add_argument("--doctor", action="store_true", help="Print doctor diagnostics for the target project")
    parser.add_argument("--health", action="store_true", help="Print health diagnostics for the target project")
    parser.add_argument("--tool", choices=sorted(TOOL_DEFINITIONS), help="Call one bridge tool directly")
    parser.add_argument("--arguments", help="JSON object passed to --tool")
    args = parser.parse_args()

    try:
        bridge = UnrealBridge(
            default_project_dir=args.project or os.environ.get("QQ_PROJECT_DIR") or os.environ.get("UNREAL_PROJECT_DIR") or ".",
            profile=args.profile,
        )
        if args.doctor:
            print(pretty_json(bridge.doctor({"project_dir": args.project})))
            return 0
        if args.health:
            print(pretty_json(bridge.health({"project_dir": args.project})))
            return 0
        if args.tool:
            payload: dict[str, Any] = {}
            if args.arguments:
                try:
                    payload = json.loads(args.arguments)
                except json.JSONDecodeError as exc:
                    raise BridgeError("INVALID_ARGUMENT", "--arguments must be valid JSON") from exc
                if not isinstance(payload, dict):
                    raise BridgeError("INVALID_ARGUMENT", "--arguments must decode to an object")
            print(pretty_json(bridge.call_tool(args.tool, payload)))
            return 0
        parser.print_help()
        return 0
    except BridgeError as exc:
        sys.stderr.write(f"{exc.category}: {exc.message}\n")
        if exc.details:
            sys.stderr.write(pretty_json(exc.details) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
