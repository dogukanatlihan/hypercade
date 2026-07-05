#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
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


CAPABILITIES_PATH = Path(__file__).resolve().with_name("sbox_capabilities.json")
PLUGIN_STATE_TTL_SEC = 5.0
REQUEST_POLL_INTERVAL_SEC = 0.1
DEFAULT_BRIDGE_TIMEOUT_SEC = 15


TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "sbox_health": {
        "title": "S&box Health",
        "description": "Check S&box project discovery, qq script wiring, editor bridge installation, and bridge reachability.",
        "inputSchema": {"type": "object", "properties": {"project_dir": {"type": "string"}}},
    },
    "sbox_doctor": {
        "title": "S&box Doctor",
        "description": "Diagnose qq direct-path readiness, built-in MCP configuration, editor bridge installation, and bridge reachability.",
        "inputSchema": {"type": "object", "properties": {"project_dir": {"type": "string"}}},
    },
    "sbox_compile": {
        "title": "S&box Compile",
        "description": "Run the project-local S&box compile workflow.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "timeout_sec": {"type": "integer", "minimum": 1},
            },
        },
    },
    "sbox_run_tests": {
        "title": "S&box Run Tests",
        "description": "Run the project-local S&box test workflow.",
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
    "sbox_console": {
        "title": "S&box Console",
        "description": "Read or clear qq S&box bridge console output.",
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
    "sbox_editor": {
        "title": "S&box Editor",
        "description": "Control high-level S&box editor actions such as play mode and scene open/save/reload flows.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": ["play", "stop", "pause", "save_scene", "open_scene", "new_scene", "reload_scene"],
                },
                "path": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    "sbox_query": {
        "title": "S&box Query",
        "description": "Read live editor state, hierarchy, selection, objects, scenes, and assets.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": ["status", "hierarchy", "find", "inspect", "get_selection", "list_scenes", "list_assets"],
                },
                "path": {"type": "string"},
                "name": {"type": "string"},
                "type": {"type": "string"},
                "filter": {"type": "string"},
                "depth": {"type": "integer", "minimum": 1},
                "count": {"type": "integer", "minimum": 1},
            },
            "required": ["action"],
        },
    },
    "sbox_object": {
        "title": "S&box Objects",
        "description": "Create and mutate live S&box scene objects, selection, parenting, properties, and transforms.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": [
                        "create",
                        "destroy",
                        "duplicate",
                        "set_transform",
                        "set_parent",
                        "set_active",
                        "set_property",
                        "select",
                    ],
                },
                "path": {"type": "string"},
                "parent": {"type": "string"},
                "name": {"type": "string"},
                "node_type": {"type": "string"},
                "position": {"type": "array", "items": {"type": "number"}},
                "rotation": {"type": "array", "items": {"type": "number"}},
                "scale": {"type": "array", "items": {"type": "number"}},
                "active": {"type": "boolean"},
                "property": {"type": "string"},
                "value": {},
            },
            "required": ["action"],
        },
    },
    "sbox_scene": {
        "title": "S&box Scene",
        "description": "Legacy scene-asset helper for file-level scene inspection and safe scene file mutations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": [
                        "status",
                        "list_scenes",
                        "inspect_scene",
                        "duplicate_scene",
                        "rename_scene",
                        "delete_scene",
                    ],
                },
                "path": {"type": "string"},
                "source": {"type": "string"},
                "target": {"type": "string"},
                "filter": {"type": "string"},
                "count": {"type": "integer", "minimum": 1},
            },
            "required": ["action"],
        },
    },
    "sbox_assets": {
        "title": "S&box Assets",
        "description": "Query project assets and perform safe file-level asset mutations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": [
                        "list_assets",
                        "inspect_asset",
                        "create_directory",
                        "duplicate_asset",
                        "rename_asset",
                        "delete_asset",
                    ],
                },
                "path": {"type": "string"},
                "source": {"type": "string"},
                "target": {"type": "string"},
                "filter": {"type": "string"},
                "count": {"type": "integer", "minimum": 1},
            },
            "required": ["action"],
        },
    },
    "sbox_batch": {
        "title": "S&box Batch",
        "description": "Execute multiple S&box bridge tool calls in one request.",
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
                },
            },
            "required": ["operations"],
        },
    },
    "sbox_raw_command": {
        "title": "S&box Raw Command",
        "description": "Send an arbitrary command directly to the S&box editor bridge.",
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


SCENE_ACTIONS = {
    "status": "status",
    "list_scenes": "list-scenes",
    "inspect_scene": "inspect-scene",
    "duplicate_scene": "duplicate-scene",
    "rename_scene": "rename-scene",
    "delete_scene": "delete-scene",
}

ASSET_ACTIONS = {
    "list_assets": "list-assets",
    "inspect_asset": "inspect-asset",
    "create_directory": "create-directory",
    "duplicate_asset": "duplicate-asset",
    "rename_asset": "rename-asset",
    "delete_asset": "delete-asset",
}

EDITOR_ACTIONS = {
    "play": "play",
    "stop": "stop",
    "pause": "pause",
    "save_scene": "save-scene",
    "open_scene": "open-scene",
    "new_scene": "new-scene",
    "reload_scene": "reload-scene",
}

QUERY_ACTIONS = {
    "status": "status",
    "hierarchy": "hierarchy",
    "find": "find-objects",
    "inspect": "inspect-object",
    "get_selection": "get-selection",
    "list_scenes": "list-scenes",
    "list_assets": "list-assets",
}

OBJECT_ACTIONS = {
    "create": "create-object",
    "destroy": "destroy-object",
    "duplicate": "duplicate-object",
    "set_transform": "set-transform",
    "set_parent": "set-parent",
    "set_active": "set-active",
    "set_property": "set-property",
    "select": "select-object",
}


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise BridgeError("INVALID_CONFIG", f"Expected JSON object in {path}")
    return payload


def unique_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        token = str(item or "").strip()
        if token and token not in seen:
            seen.add(token)
            ordered.append(token)
    return ordered


def find_sbox_project_file(project_dir: Path) -> Path | None:
    hidden = project_dir / ".sbproj"
    if hidden.is_file():
        return hidden
    for path in sorted(project_dir.glob("*.sbproj")):
        if path.is_file():
            return path
    return None


def describe_path(project_dir: Path, absolute_path: Path) -> dict[str, Any]:
    file = absolute_path.resolve()
    if not file.exists():
        raise BridgeError("NOT_FOUND", f"Path does not exist: {file}")
    return {
        "path": str(file.relative_to(project_dir)).replace("\\", "/"),
        "name": file.name,
        "extension": file.suffix,
        "sizeBytes": file.stat().st_size if file.is_file() else 0,
        "modifiedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(file.stat().st_mtime)),
        "kind": "scene" if file.suffix.lower() == ".scene" else ("directory" if file.is_dir() else "asset"),
    }


class SboxProjectFileOps:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir.resolve()

    def asset_roots(self) -> list[Path]:
        roots = [self.project_dir / "Assets"]
        libraries = self.project_dir / "Libraries"
        if libraries.is_dir():
            for library in sorted(item for item in libraries.iterdir() if item.is_dir()):
                roots.append(library / "Assets")
        return roots

    def iter_asset_files(self) -> list[Path]:
        files: list[Path] = []
        for root in self.asset_roots():
            if not root.is_dir():
                continue
            for path in sorted(root.rglob("*")):
                if not path.is_file():
                    continue
                lowered = {part.lower() for part in path.parts}
                if "bin" in lowered or "obj" in lowered or ".qq" in lowered or ".git" in lowered:
                    continue
                files.append(path)
        return files

    def iter_scene_files(self) -> list[Path]:
        return [path for path in self.iter_asset_files() if path.suffix.lower() == ".scene"]

    def matches_filter(self, path: Path, filter_text: str | None) -> bool:
        token = str(filter_text or "").strip().lower()
        if not token:
            return True
        return token in str(path.relative_to(self.project_dir)).replace("\\", "/").lower()

    def resolve_project_path(
        self,
        relative_path: str,
        *,
        require_scene: bool = False,
        require_existing: bool = True,
        allow_directory: bool = False,
    ) -> Path:
        candidate = str(relative_path or "").strip().replace("\\", "/")
        if not candidate:
            raise BridgeError("INVALID_ARGUMENT", "path is required")
        absolute = (self.project_dir / candidate).resolve()
        project_root = str(self.project_dir)
        if str(absolute) != project_root and not str(absolute).startswith(project_root + os.sep):
            raise BridgeError("INVALID_ARGUMENT", f"Path escapes project root: {relative_path}")
        if require_scene and absolute.suffix.lower() != ".scene":
            raise BridgeError("INVALID_ARGUMENT", f"Expected a .scene path: {relative_path}")
        if require_existing:
            exists = absolute.exists() if allow_directory else absolute.is_file()
            if not exists:
                raise BridgeError("NOT_FOUND", f"Path does not exist: {relative_path}")
        else:
            if absolute.exists():
                raise BridgeError("INVALID_ARGUMENT", f"Target already exists: {relative_path}")
        return absolute

    def status(self) -> dict[str, Any]:
        project_file = find_sbox_project_file(self.project_dir)
        return {
            "projectRoot": str(self.project_dir),
            "projectFile": str(project_file.relative_to(self.project_dir)).replace("\\", "/") if project_file else "",
            "sceneCount": len(self.iter_scene_files()),
            "assetCount": len(self.iter_asset_files()),
            "editorCodePresent": (self.project_dir / "Editor").is_dir(),
            "libraryCount": len([item for item in (self.project_dir / "Libraries").iterdir() if item.is_dir()]) if (self.project_dir / "Libraries").is_dir() else 0,
        }

    def list_scenes(self, filter_text: str | None = None, count: int = 200) -> list[dict[str, Any]]:
        return [describe_path(self.project_dir, path) for path in self.iter_scene_files() if self.matches_filter(path, filter_text)][: max(int(count or 200), 1)]

    def inspect_scene(self, relative_path: str) -> dict[str, Any]:
        return describe_path(self.project_dir, self.resolve_project_path(relative_path, require_scene=True, require_existing=True))

    def duplicate_scene(self, source: str, target: str) -> dict[str, Any]:
        src = self.resolve_project_path(source, require_scene=True, require_existing=True)
        dst = self.resolve_project_path(target, require_scene=True, require_existing=False)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return {
            "source": str(src.relative_to(self.project_dir)).replace("\\", "/"),
            "target": str(dst.relative_to(self.project_dir)).replace("\\", "/"),
        }

    def rename_scene(self, source: str, target: str) -> dict[str, Any]:
        src = self.resolve_project_path(source, require_scene=True, require_existing=True)
        dst = self.resolve_project_path(target, require_scene=True, require_existing=False)
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return {
            "source": str(src.relative_to(self.project_dir)).replace("\\", "/"),
            "target": str(dst.relative_to(self.project_dir)).replace("\\", "/"),
        }

    def delete_scene(self, path: str) -> dict[str, Any]:
        target = self.resolve_project_path(path, require_scene=True, require_existing=True)
        target.unlink()
        return {
            "path": str(target.relative_to(self.project_dir)).replace("\\", "/"),
            "deleted": True,
        }

    def list_assets(self, filter_text: str | None = None, count: int = 200) -> list[dict[str, Any]]:
        return [describe_path(self.project_dir, path) for path in self.iter_asset_files() if self.matches_filter(path, filter_text)][: max(int(count or 200), 1)]

    def inspect_asset(self, relative_path: str) -> dict[str, Any]:
        return describe_path(self.project_dir, self.resolve_project_path(relative_path, require_existing=True))

    def create_directory(self, relative_path: str) -> dict[str, Any]:
        target = self.resolve_project_path(relative_path, require_existing=False, allow_directory=True)
        target.mkdir(parents=True, exist_ok=False)
        return describe_path(self.project_dir, target)

    def duplicate_asset(self, source: str, target: str) -> dict[str, Any]:
        src = self.resolve_project_path(source, require_existing=True)
        dst = self.resolve_project_path(target, require_existing=False)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return {
            "source": str(src.relative_to(self.project_dir)).replace("\\", "/"),
            "target": str(dst.relative_to(self.project_dir)).replace("\\", "/"),
        }

    def rename_asset(self, source: str, target: str) -> dict[str, Any]:
        src = self.resolve_project_path(source, require_existing=True)
        dst = self.resolve_project_path(target, require_existing=False)
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return {
            "source": str(src.relative_to(self.project_dir)).replace("\\", "/"),
            "target": str(dst.relative_to(self.project_dir)).replace("\\", "/"),
        }

    def delete_asset(self, path: str) -> dict[str, Any]:
        target = self.resolve_project_path(path, require_existing=True)
        target.unlink()
        return {
            "path": str(target.relative_to(self.project_dir)).replace("\\", "/"),
            "deleted": True,
        }


class SboxQueueClient:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir.resolve()
        self.metadata = engine_metadata("sbox")

    @property
    def state_path(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeStateFile") or ".qq/state/qq-sbox-editor-bridge.json")

    @property
    def request_dir(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeRequestDir") or ".qq/state/qq-sbox-editor/requests")

    @property
    def response_dir(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeResponseDir") or ".qq/state/qq-sbox-editor/responses")

    @property
    def console_path(self) -> Path:
        return self.project_dir / str(self.metadata.get("editorBridgeConsoleFile") or ".qq/state/qq-sbox-editor-console.jsonl")

    @property
    def support_paths(self) -> list[Path]:
        support_dir = str(self.metadata.get("engineSupportTargetDir") or "Editor/QQ").strip()
        return [self.project_dir / support_dir / "QQSboxEditorBridge.cs"]

    def support_installed(self) -> bool:
        return all(path.is_file() for path in self.support_paths)

    def ensure_runtime_dirs(self) -> None:
        self.request_dir.mkdir(parents=True, exist_ok=True)
        self.response_dir.mkdir(parents=True, exist_ok=True)
        self.console_path.parent.mkdir(parents=True, exist_ok=True)

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
        running = bool(state.get("running")) and age_sec is not None and age_sec <= PLUGIN_STATE_TTL_SEC
        warnings: list[str] = []
        if not self.support_installed():
            warnings.append("qq S&box editor bridge support files are not installed in Editor/QQ")
        if not self.state_path.is_file():
            warnings.append("S&box editor bridge state file has not been written yet")
        elif not running:
            warnings.append("S&box editor bridge heartbeat is stale or the editor is not open")
        return {
            "supportInstalled": self.support_installed(),
            "stateFile": str(self.state_path),
            "requestDir": str(self.request_dir),
            "responseDir": str(self.response_dir),
            "consoleFile": str(self.console_path),
            "running": running,
            "lastHeartbeatUnix": heartbeat,
            "lastHeartbeatAgeSec": age_sec,
            "state": state,
            "warnings": warnings,
        }

    def send_command(self, command: str, args: dict[str, Any] | None = None, *, timeout_sec: int | None = None) -> dict[str, Any]:
        timeout = int(timeout_sec or DEFAULT_BRIDGE_TIMEOUT_SEC)
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

        health = self.bridge_health()
        raise BridgeError(
            "BRIDGE_TIMEOUT",
            f"S&box editor bridge timed out waiting for {command}",
            {
                "command": command,
                "requestId": request_id,
                "stateFile": str(self.state_path),
                "running": health.get("running"),
                "warnings": health.get("warnings"),
            },
        )

    def read_console_entries(self, count: int = 50, filter_text: str | None = None) -> list[dict[str, Any]]:
        if not self.console_path.is_file():
            return []
        entries: list[dict[str, Any]] = []
        token = str(filter_text or "").lower().strip()
        for line in self.console_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            if token and token not in json.dumps(payload, ensure_ascii=False).lower():
                continue
            entries.append(payload)
        return entries[-max(int(count or 50), 1):]

    def clear_console(self) -> None:
        self.console_path.parent.mkdir(parents=True, exist_ok=True)
        self.console_path.write_text("", encoding="utf-8")


class SboxBridge:
    def __init__(self, default_project_dir: str | None = None, profile: str | None = None, capabilities_path: Path | None = None):
        self._config = load_config(capabilities_path or CAPABILITIES_PATH)
        self.supported_protocol_versions = list(self._config["protocolVersions"])
        self.profile = profile or self._config["defaultProfile"]
        if self.profile not in self._config["profiles"]:
            raise BridgeError(
                "INVALID_PROFILE",
                f"Unknown MCP profile: {self.profile}",
                {"supported": sorted(self._config["profiles"].keys())},
            )
        self.engine = "sbox"
        self.default_project_dir = str(Path(default_project_dir).resolve()) if default_project_dir else None
        self.server_name = bridge_server_name("sbox") or "qq-sbox"
        self.instructions = (
            "This bridge exposes typed S&box tools backed by the built-in qq S&box editor bridge. "
            "Use sbox_compile and sbox_run_tests for workflow verification, then sbox_editor, "
            "sbox_query, sbox_object, and sbox_assets for live editor, hierarchy, object, and "
            "asset inspection or mutation."
        )

    def list_tools(self) -> list[dict[str, Any]]:
        tool_names = self._config["profiles"][self.profile]
        tools: list[dict[str, Any]] = []
        for tool_name in tool_names:
            base = dict(TOOL_DEFINITIONS[tool_name])
            base["name"] = tool_name
            base["annotations"] = self._config["toolAnnotations"].get(tool_name, {})
            tools.append(base)
        return tools

    def tool_result(self, structured: dict[str, Any], is_error: bool | None = None) -> dict[str, Any]:
        return build_tool_result(structured, default_message="S&box bridge operation completed", is_error=is_error)

    def call_tool(self, tool_name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        args = arguments or {}
        if tool_name not in {tool["name"] for tool in self.list_tools()}:
            raise BridgeError("UNKNOWN_TOOL", f"Unknown tool: {tool_name}")
        if tool_name == "sbox_health":
            return self.health(args.get("project_dir"))
        if tool_name == "sbox_doctor":
            return self.doctor(args.get("project_dir"))
        if tool_name == "sbox_compile":
            return self.compile(args)
        if tool_name == "sbox_run_tests":
            return self.run_tests(args)
        if tool_name == "sbox_console":
            return self.console(args)
        if tool_name == "sbox_editor":
            return self.action_tool(args, EDITOR_ACTIONS, "sbox_editor")
        if tool_name == "sbox_query":
            return self.action_tool(args, QUERY_ACTIONS, "sbox_query")
        if tool_name == "sbox_object":
            return self.action_tool(args, OBJECT_ACTIONS, "sbox_object")
        if tool_name == "sbox_scene":
            return self.action_tool(args, SCENE_ACTIONS, "sbox_scene")
        if tool_name == "sbox_assets":
            return self.action_tool(args, ASSET_ACTIONS, "sbox_assets")
        if tool_name == "sbox_batch":
            return self.batch(args)
        if tool_name == "sbox_raw_command":
            return self.raw_command(args)
        raise BridgeError("UNKNOWN_TOOL", f"Unsupported tool handler: {tool_name}")

    def resolve_project(self, project_dir: str | None = None) -> Path:
        candidate = None
        if project_dir:
            candidate = Path(project_dir).expanduser()
        elif self.default_project_dir:
            candidate = Path(self.default_project_dir).expanduser()
        elif os.environ.get("QQ_PROJECT_DIR"):
            candidate = Path(os.environ["QQ_PROJECT_DIR"]).expanduser()
        elif os.environ.get("SBOX_PROJECT_DIR"):
            candidate = Path(os.environ["SBOX_PROJECT_DIR"]).expanduser()
        else:
            candidate = Path.cwd()
        resolved = candidate.resolve()
        if resolve_project_engine(resolved) != "sbox":
            raise BridgeError("PROJECT_NOT_FOUND", f"Not an S&box project: {resolved}", {"required": ".sbproj or *.sbproj"})
        return resolved

    def queue_client(self, project_dir: str | None = None) -> SboxQueueClient:
        return SboxQueueClient(self.resolve_project(project_dir))

    def file_ops(self, project_dir: str | None = None) -> SboxProjectFileOps:
        return SboxProjectFileOps(self.resolve_project(project_dir))

    def has_project_fast_path(self, project_dir: Path) -> bool:
        required = [
            project_dir / "scripts" / "qq-compile.sh",
            project_dir / "scripts" / "qq-test.sh",
            project_dir / "scripts" / "qq-doctor.py",
            project_dir / "scripts" / "qq-project-state.py",
            project_dir / "scripts" / "qq-policy-check.sh",
            project_dir / "scripts" / "qq_mcp.py",
            project_dir / "scripts" / "sbox_bridge.py",
            project_dir / "scripts" / "sbox_capabilities.json",
        ]
        return all(path.is_file() for path in required)

    def health(self, project_dir: str | None = None) -> dict[str, Any]:
        resolved = self.resolve_project(project_dir)
        client = SboxQueueClient(resolved)
        bridge_health = client.bridge_health()
        qq_scripts_available = self.has_project_fast_path(resolved)
        project_file = find_sbox_project_file(resolved)
        warnings = list(bridge_health["warnings"])
        if project_file is None:
            warnings.append("No .sbproj file found in the project root")
        if not qq_scripts_available:
            warnings.append("qq fast-path scripts are not installed in this project")
        payload = {
            "ok": qq_scripts_available,
            "category": "OK" if bridge_health["running"] else "SBOX_BRIDGE_UNAVAILABLE",
            "message": "S&box editor bridge reachable" if bridge_health["running"] else "S&box editor bridge not reachable",
            "project_dir": str(resolved),
            "project_file": str(project_file) if project_file else "",
            "backend": "qq-sbox-editor" if bridge_health["running"] else "unavailable",
            "engine": "sbox",
            "engineName": str(engine_metadata("sbox").get("displayName") or "S&box"),
            "qq_scripts_available": qq_scripts_available,
            "support_installed": bridge_health["supportInstalled"],
            "local_file_ops_available": True,
            "editor_running": bridge_health["running"],
            "bridge_state_file": bridge_health["stateFile"],
            "request_dir": bridge_health["requestDir"],
            "response_dir": bridge_health["responseDir"],
            "console_file": bridge_health["consoleFile"],
            "last_heartbeat_unix": bridge_health["lastHeartbeatUnix"],
            "last_heartbeat_age_sec": bridge_health["lastHeartbeatAgeSec"],
            "warnings": unique_strings(warnings),
        }
        return payload

    def doctor(self, project_dir: str | None = None) -> dict[str, Any]:
        resolved = self.resolve_project(project_dir)
        health = self.health(str(resolved))
        command = [sys.executable, str(resolved / "scripts" / "qq-doctor.py"), "--project", str(resolved)]
        result = run_command(command, cwd=resolved)
        if result.returncode != 0:
            raise BridgeError("DOCTOR_FAILED", result.stderr.strip() or result.stdout.strip() or "qq-doctor failed")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise BridgeError("DOCTOR_FAILED", "qq-doctor returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise BridgeError("DOCTOR_FAILED", "qq-doctor returned a non-object payload")
        warnings = unique_strings(list(payload.get("warnings") or []) + list(health.get("warnings") or []))
        payload["health"] = health
        payload["warnings"] = warnings
        payload["ok"] = bool(payload.get("ok")) and bool(health.get("ok"))
        if health.get("ok"):
            payload["message"] = "qq direct path and S&box typed bridge surface are ready"
        else:
            payload["message"] = "qq routing is installed, but the live S&box editor bridge is not fully ready"
        return payload

    def compile(self, args: dict[str, Any]) -> dict[str, Any]:
        project_dir = self.resolve_project(args.get("project_dir"))
        timeout_sec = int(args.get("timeout_sec") or 0) or None
        command = ["bash", str(project_dir / "scripts" / "qq-compile.sh"), "--project", str(project_dir)]
        if timeout_sec:
            command.extend(["--timeout", str(timeout_sec)])
        result = run_command(command, cwd=project_dir, timeout_sec=timeout_sec)
        record = latest_stage_record(project_dir, "compile")
        status = normalize_run_status(record.get("status"), result.returncode)
        summary = str(record.get("summary") or result.stderr.strip() or result.stdout.strip() or "Compile finished")
        return {
            "ok": status in {"passed", "warning"},
            "state": status,
            "message": summary,
            "engine": "sbox",
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
        command = ["bash", str(project_dir / "scripts" / "qq-test.sh")]
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
        summary = str(record.get("summary") or result.stderr.strip() or result.stdout.strip() or "Test run finished")
        return {
            "ok": status in {"passed", "warning"},
            "state": status,
            "message": summary,
            "engine": "sbox",
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
            raise BridgeError("INVALID_ARGUMENT", "sbox_console.action must be 'get' or 'clear'")
        client = self.queue_client(args.get("project_dir"))
        if action == "get":
            entries = client.read_console_entries(int(args.get("count") or 50), str(args.get("filter") or "").strip() or None)
            return {
                "ok": True,
                "action": action,
                "message": f"Retrieved {len(entries)} bridge console entries",
                "entries": entries,
            }
        client.clear_console()
        return {
            "ok": True,
            "action": action,
            "message": "Cleared S&box bridge console entries",
            "entries": [],
        }

    def action_tool(self, args: dict[str, Any], mapping: dict[str, str], tool_name: str) -> dict[str, Any]:
        action = str(args.get("action") or "").strip()
        if action not in mapping:
            raise BridgeError("INVALID_ARGUMENT", f"{tool_name}.action is invalid", {"supported": sorted(mapping)})
        project_dir = self.resolve_project(args.get("project_dir"))
        timeout_sec = int(args.get("timeout_sec") or 0) or None
        client = SboxQueueClient(project_dir)
        command_args = {
            key: value
            for key, value in args.items()
            if key not in {"project_dir", "action", "timeout_sec"} and value is not None
        }
        if tool_name in {"sbox_query", "sbox_scene", "sbox_assets"} and not client.bridge_health()["running"]:
            fallback = self.local_action_tool(project_dir, tool_name, action, command_args)
            fallback["message"] = f"{fallback['message']} (local fallback)"
            return fallback
        response = client.send_command(mapping[action], command_args, timeout_sec=timeout_sec)
        return {
            "ok": bool(response.get("ok")),
            "action": action,
            "message": str(response.get("message") or f"{tool_name} action completed"),
            "response": response.get("data"),
            "category": str(response.get("category") or ""),
        }

    def local_action_tool(self, project_dir: Path, tool_name: str, action: str, command_args: dict[str, Any]) -> dict[str, Any]:
        ops = SboxProjectFileOps(project_dir)
        if tool_name == "sbox_query":
            if action == "status":
                response = ops.status()
            elif action == "list_scenes":
                response = {"items": ops.list_scenes(str(command_args.get("filter") or "").strip() or None, int(command_args.get("count") or 200))}
            elif action == "list_assets":
                response = {"items": ops.list_assets(str(command_args.get("filter") or "").strip() or None, int(command_args.get("count") or 200))}
            else:
                raise BridgeError(
                    "BRIDGE_UNAVAILABLE",
                    f"{action} requires a running S&box editor bridge",
                    {"tool": tool_name, "action": action},
                )
        elif tool_name == "sbox_scene":
            if action == "status":
                response = ops.status()
            elif action == "list_scenes":
                response = {"items": ops.list_scenes(str(command_args.get("filter") or "").strip() or None, int(command_args.get("count") or 200))}
            elif action == "inspect_scene":
                response = ops.inspect_scene(str(command_args.get("path") or ""))
            elif action == "duplicate_scene":
                response = ops.duplicate_scene(str(command_args.get("source") or ""), str(command_args.get("target") or ""))
            elif action == "rename_scene":
                response = ops.rename_scene(str(command_args.get("source") or ""), str(command_args.get("target") or ""))
            elif action == "delete_scene":
                response = ops.delete_scene(str(command_args.get("path") or ""))
            else:
                raise BridgeError("INVALID_ARGUMENT", f"Unsupported S&box scene action: {action}")
        elif tool_name == "sbox_assets":
            if action == "list_assets":
                response = {"items": ops.list_assets(str(command_args.get("filter") or "").strip() or None, int(command_args.get("count") or 200))}
            elif action == "inspect_asset":
                response = ops.inspect_asset(str(command_args.get("path") or ""))
            elif action == "create_directory":
                response = ops.create_directory(str(command_args.get("path") or ""))
            elif action == "duplicate_asset":
                response = ops.duplicate_asset(str(command_args.get("source") or ""), str(command_args.get("target") or ""))
            elif action == "rename_asset":
                response = ops.rename_asset(str(command_args.get("source") or ""), str(command_args.get("target") or ""))
            elif action == "delete_asset":
                response = ops.delete_asset(str(command_args.get("path") or ""))
            else:
                raise BridgeError("INVALID_ARGUMENT", f"Unsupported S&box asset action: {action}")
        else:
            raise BridgeError("INVALID_ARGUMENT", f"Unsupported local fallback tool: {tool_name}")
        return {
            "ok": True,
            "action": action,
            "message": f"{tool_name} action completed",
            "response": response,
            "category": "OK",
        }

    def batch(self, args: dict[str, Any]) -> dict[str, Any]:
        operations = args.get("operations")
        if not isinstance(operations, list) or not operations:
            raise BridgeError("INVALID_ARGUMENT", "sbox_batch.operations must be a non-empty array")

        results: list[dict[str, Any]] = []
        any_errors = False
        available_tools = {tool["name"] for tool in self.list_tools()}
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict):
                results.append({"ok": False, "index": index, "message": "Operation must be an object"})
                any_errors = True
                continue
            tool_name = str(operation.get("tool") or "")
            if tool_name == "sbox_batch":
                results.append({"ok": False, "index": index, "message": "sbox_batch cannot recursively call itself"})
                any_errors = True
                continue
            if tool_name not in available_tools:
                results.append({"ok": False, "index": index, "message": f"Tool not exposed in current profile: {tool_name}"})
                any_errors = True
                continue
            try:
                result = self.call_tool(tool_name, operation.get("arguments") or {})
                results.append({"index": index, "tool": tool_name, "result": result})
                any_errors = any_errors or not bool(result.get("ok", False))
            except BridgeError as exc:
                any_errors = True
                results.append({"index": index, "tool": tool_name, "result": exc.to_result()})

        return {
            "ok": not any_errors,
            "message": f"Executed {len(results)} batch operation(s)",
            "results": results,
        }

    def raw_command(self, args: dict[str, Any]) -> dict[str, Any]:
        command = str(args.get("command") or "").strip()
        if not command:
            raise BridgeError("INVALID_ARGUMENT", "sbox_raw_command.command is required")
        timeout_sec = int(args.get("timeout_sec") or 0) or None
        raw_args = args.get("args") or {}
        if not isinstance(raw_args, dict):
            raise BridgeError("INVALID_ARGUMENT", "sbox_raw_command.args must be an object")
        client = self.queue_client(args.get("project_dir"))
        response = client.send_command(command, raw_args, timeout_sec=timeout_sec)
        return {
            "ok": bool(response.get("ok")),
            "command": command,
            "message": str(response.get("message") or f"Executed raw command: {command}"),
            "response": response.get("data"),
            "category": str(response.get("category") or ""),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="S&box bridge helper")
    parser.add_argument("--project", help="S&box project root")
    parser.add_argument("--profile", choices=["standard", "full"], help="Tool profile to expose")
    parser.add_argument("--doctor", action="store_true", help="Print doctor diagnostics for the target project")
    parser.add_argument("--health", action="store_true", help="Print health diagnostics for the target project")
    parser.add_argument("--tool", choices=sorted(TOOL_DEFINITIONS), help="Call one bridge tool directly")
    parser.add_argument("--arguments", help="JSON object passed to --tool")
    args = parser.parse_args()

    try:
        bridge = SboxBridge(
            default_project_dir=args.project or os.environ.get("QQ_PROJECT_DIR") or os.environ.get("SBOX_PROJECT_DIR"),
            profile=args.profile,
        )
        if args.doctor:
            print(pretty_json(bridge.doctor(args.project)))
            return 0
        if args.health:
            print(pretty_json(bridge.health(args.project)))
            return 0
        if args.tool:
            payload = {}
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
