#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import traceback
from pathlib import Path
from typing import Any

try:
    import unreal  # type: ignore
except Exception:  # pragma: no cover - imported by Unreal, not CPython
    unreal = None


DEFAULT_ACTOR_CLASS = "/Script/Engine.EmptyActor"
DEFAULT_TRANSFORM = [0.0, 0.0, 0.0]


def load_request() -> dict[str, Any]:
    request_path = Path(os.environ["QQ_UNREAL_COMMAND_PATH"])
    payload = json.loads(request_path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def append_console(level: str, event: str, payload: dict[str, Any], console_path: Path | None = None) -> None:
    target = console_path or Path(os.environ.get("QQ_UNREAL_CONSOLE_PATH", "")).expanduser()
    if not str(target):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "level": level,
        "event": event,
        "payload": payload,
    }
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def write_response(payload: dict[str, Any]) -> None:
    response_path = Path(os.environ["QQ_UNREAL_RESPONSE_PATH"])
    response_path.parent.mkdir(parents=True, exist_ok=True)
    response_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def asset_class_name(asset_data: Any) -> str:
    class_path = getattr(asset_data, "asset_class_path", None)
    if class_path is not None:
        asset_name = getattr(class_path, "asset_name", "")
        if asset_name:
            return str(asset_name)
    return str(getattr(asset_data, "asset_class", ""))


def asset_path(asset_data: Any) -> str:
    for attribute in ("object_path_string", "package_name", "object_path"):
        value = getattr(asset_data, attribute, "")
        if value:
            return str(value)
    return ""


def asset_registry() -> Any:
    return unreal.AssetRegistryHelpers.get_asset_registry()


def normalize_content_path(path: str) -> str:
    token = str(path or "").strip()
    if not token:
        return ""
    if token.startswith("/"):
        return token
    return f"/Game/{token.lstrip('/')}"


def normalize_asset_path(path: str) -> str:
    token = normalize_content_path(path)
    leaf = token.rsplit("/", 1)[-1]
    if "." in leaf:
        token = token.rsplit(".", 1)[0]
    return token


def split_asset_path(path: str) -> tuple[str, str]:
    asset_path = normalize_asset_path(path)
    if not asset_path or "/" not in asset_path.strip("/"):
        raise ValueError(f"Invalid Unreal asset path: {path}")
    package_path, asset_name = asset_path.rsplit("/", 1)
    return package_path, asset_name


def vector_payload(value: Any) -> list[float]:
    return [float(getattr(value, "x", 0.0)), float(getattr(value, "y", 0.0)), float(getattr(value, "z", 0.0))]


def rotator_payload(value: Any) -> list[float]:
    return [float(getattr(value, "roll", 0.0)), float(getattr(value, "pitch", 0.0)), float(getattr(value, "yaw", 0.0))]


def vector_from(values: Any, default: list[float] | None = None) -> Any:
    items = values if isinstance(values, list) else (default or DEFAULT_TRANSFORM)
    padded = [float(items[index]) if index < len(items) else 0.0 for index in range(3)]
    return unreal.Vector(*padded)


def rotator_from(values: Any, default: list[float] | None = None) -> Any:
    items = values if isinstance(values, list) else (default or DEFAULT_TRANSFORM)
    padded = [float(items[index]) if index < len(items) else 0.0 for index in range(3)]
    return unreal.Rotator(*padded)


def component_payload(component: Any) -> dict[str, Any]:
    return {
        "name": str(component.get_name()),
        "class": str(component.get_class().get_name()) if component.get_class() is not None else "",
        "path": str(component.get_path_name()),
    }


def selected_actor_paths() -> set[str]:
    subsystem = actor_subsystem()
    if subsystem is None:
        return set()
    return {str(actor.get_path_name()) for actor in subsystem.get_selected_level_actors()}


def actor_payload(actor: Any, *, include_components: bool = False, selected_paths: set[str] | None = None) -> dict[str, Any]:
    parent = actor.get_attach_parent_actor() if hasattr(actor, "get_attach_parent_actor") else None
    payload = {
        "label": str(actor.get_actor_label()),
        "class": str(actor.get_class().get_name()) if actor.get_class() is not None else "",
        "path": str(actor.get_path_name()),
        "parentLabel": str(parent.get_actor_label()) if parent is not None else "",
        "parentPath": str(parent.get_path_name()) if parent is not None else "",
        "folder": str(actor.get_folder_path()) if hasattr(actor, "get_folder_path") else "",
        "location": vector_payload(actor.get_actor_location()),
        "rotation": rotator_payload(actor.get_actor_rotation()),
        "scale": vector_payload(actor.get_actor_scale3d()),
        "selected": bool(selected_paths and actor.get_path_name() in selected_paths),
    }
    if include_components:
        payload["components"] = [component_payload(component) for component in actor.get_components_by_class(unreal.ActorComponent)]
    return payload


def asset_payload_from_data(asset_data: Any) -> dict[str, str]:
    path = asset_path(asset_data)
    name = path.rsplit("/", 1)[-1] if path else ""
    return {"path": path, "name": name, "class": asset_class_name(asset_data)}


def list_assets(filter_text: str = "", class_name: str = "") -> list[dict[str, str]]:
    registry = asset_registry()
    assets = registry.get_assets_by_path("/Game", recursive=True)
    results: list[dict[str, str]] = []
    needle = filter_text.lower().strip()
    class_filter = class_name.lower().strip()
    for asset in assets:
        path = asset_path(asset)
        asset_class = asset_class_name(asset)
        if needle and needle not in path.lower():
            continue
        if class_filter and class_filter not in asset_class.lower():
            continue
        results.append({"path": path, "name": path.rsplit("/", 1)[-1], "class": asset_class})
    return results


def list_maps(filter_text: str = "") -> list[dict[str, str]]:
    items = list_assets(filter_text=filter_text, class_name="World")
    return [{"path": item["path"], "class": item["class"]} for item in items]


def status_payload() -> dict[str, Any]:
    engine_version = ""
    project_name = ""
    project_dir = ""
    if unreal is not None:
        engine_version = str(unreal.SystemLibrary.get_engine_version())
        project_name = str(unreal.Paths.get_base_filename(unreal.Paths.get_project_file_path()))
        project_dir = str(unreal.Paths.project_dir())
    return {
        "engineVersion": engine_version,
        "projectName": project_name,
        "projectDir": project_dir,
    }


def current_world() -> Any:
    try:
        subsystem = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        return subsystem.get_editor_world()
    except Exception:
        return None


def actor_subsystem() -> Any:
    try:
        return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception:
        return None


def level_editor_subsystem() -> Any:
    try:
        return unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    except Exception:
        return None


def list_actors(name_filter: str = "", class_name: str = "", filter_text: str = "") -> list[dict[str, Any]]:
    subsystem = actor_subsystem()
    if subsystem is None:
        return []
    results: list[dict[str, Any]] = []
    needle = name_filter.lower().strip()
    class_filter = class_name.lower().strip()
    text_filter = filter_text.lower().strip()
    selected_paths = selected_actor_paths()
    for actor in subsystem.get_all_level_actors():
        label = str(actor.get_actor_label())
        actor_class = str(actor.get_class().get_name()) if actor.get_class() is not None else ""
        actor_path = str(actor.get_path_name())
        if needle and needle not in label.lower() and needle not in actor_path.lower():
            continue
        if class_filter and class_filter not in actor_class.lower():
            continue
        if text_filter:
            haystack = " ".join((label.lower(), actor_class.lower(), actor_path.lower()))
            if text_filter not in haystack:
                continue
        results.append(actor_payload(actor, selected_paths=selected_paths))
    return results


def hierarchy_payload(max_depth: int = 0, filter_text: str = "", class_name: str = "") -> list[dict[str, Any]]:
    subsystem = actor_subsystem()
    if subsystem is None:
        return []
    selected_paths = selected_actor_paths()
    items = [actor_payload(actor, selected_paths=selected_paths) for actor in subsystem.get_all_level_actors()]
    filter_needle = filter_text.lower().strip()
    class_filter = class_name.lower().strip()
    by_path = {str(item["path"]): item for item in items}
    depth_cache: dict[str, int] = {}

    def compute_depth(path: str) -> int:
        if path in depth_cache:
            return depth_cache[path]
        parent_path = str(by_path.get(path, {}).get("parentPath") or "")
        if not parent_path or parent_path not in by_path:
            depth_cache[path] = 1
            return 1
        depth_cache[path] = compute_depth(parent_path) + 1
        return depth_cache[path]

    results: list[dict[str, Any]] = []
    for item in items:
        path = str(item["path"])
        depth = compute_depth(path)
        if max_depth and depth > max_depth:
            continue
        if class_filter and class_filter not in str(item["class"]).lower():
            continue
        if filter_needle:
            haystack = " ".join(
                (
                    str(item["label"]).lower(),
                    str(item["class"]).lower(),
                    str(item["path"]).lower(),
                    str(item["parentLabel"]).lower(),
                )
            )
            if filter_needle not in haystack:
                continue
        enriched = dict(item)
        enriched["depth"] = depth
        results.append(enriched)
    return sorted(results, key=lambda entry: (int(entry.get("depth") or 0), str(entry.get("label") or "")))


def find_actor(path: str = "", name: str = "") -> Any:
    subsystem = actor_subsystem()
    if subsystem is None:
        return None
    path_ref = str(path or "").strip()
    name_ref = str(name or "").strip()
    for actor in subsystem.get_all_level_actors():
        actor_path = str(actor.get_path_name())
        actor_label = str(actor.get_actor_label())
        if path_ref and (actor_path == path_ref or actor_label == path_ref):
            return actor
        if name_ref and actor_label == name_ref:
            return actor
    return None


def resolve_actor(args: dict[str, Any]) -> Any:
    actor = find_actor(str(args.get("path") or ""), str(args.get("name") or ""))
    if actor is not None:
        return actor
    raise ValueError(f"Actor not found: {args.get('path') or args.get('name') or ''}")


def resolve_component(actor: Any, component_ref: str) -> Any:
    needle = component_ref.lower().strip()
    for component in actor.get_components_by_class(unreal.ActorComponent):
        if needle in str(component.get_name()).lower() or needle in str(component.get_path_name()).lower():
            return component
        if component.get_class() is not None and needle in str(component.get_class().get_name()).lower():
            return component
    return None


def inspect_asset(path: str) -> dict[str, Any] | None:
    asset_path_value = normalize_asset_path(path)
    if not asset_path_value or not unreal.EditorAssetLibrary.does_asset_exist(asset_path_value):
        return None
    asset_data = unreal.EditorAssetLibrary.find_asset_data(asset_path_value)
    payload = asset_payload_from_data(asset_data)
    payload["exists"] = True
    loaded = unreal.EditorAssetLibrary.load_asset(asset_path_value)
    if loaded is not None:
        payload["objectPath"] = str(loaded.get_path_name())
        payload["class"] = str(loaded.get_class().get_name()) if loaded.get_class() is not None else payload["class"]
    return payload


def attachment_rules(mode: str) -> tuple[Any, Any]:
    token = str(mode or "keep_world").strip().lower()
    if token == "keep_relative":
        return unreal.AttachmentRule.KEEP_RELATIVE, unreal.DetachmentRule.KEEP_RELATIVE
    if token == "snap_to_target":
        return unreal.AttachmentRule.SNAP_TO_TARGET, unreal.DetachmentRule.KEEP_WORLD
    return unreal.AttachmentRule.KEEP_WORLD, unreal.DetachmentRule.KEEP_WORLD


def dispatch(command: str, args: dict[str, Any]) -> dict[str, Any]:
    if unreal is None:
        return {
            "ok": False,
            "category": "PYTHON_PLUGIN_DISABLED",
            "message": "Unreal Python module is unavailable. Enable PythonScriptPlugin before using qq Unreal tools.",
        }

    if command == "status":
        status = status_payload()
        level_subsystem = level_editor_subsystem()
        world = current_world()
        selection = list_actors()
        status["currentMap"] = str(level_subsystem.get_current_level().get_path_name()) if level_subsystem is not None and level_subsystem.get_current_level() is not None else str(world.get_path_name()) if world is not None else ""
        status["isPlaying"] = bool(level_subsystem.is_in_play_in_editor()) if level_subsystem is not None else False
        status["selectionCount"] = len(selected_actor_paths())
        status["actorCount"] = len(selection)
        return {"ok": True, "message": "Loaded Unreal editor status", "data": status}

    if command == "hierarchy":
        max_depth = int(args.get("depth") or 0)
        items = hierarchy_payload(max_depth=max_depth, filter_text=str(args.get("filter") or ""), class_name=str(args.get("class_name") or ""))
        return {"ok": True, "message": f"Listed {len(items)} actor hierarchy item(s)", "data": {"actors": items}}

    if command == "list-assets":
        items = list_assets(str(args.get("filter") or ""), str(args.get("class_name") or ""))
        return {"ok": True, "message": f"Listed {len(items)} asset(s)", "data": {"assets": items}}

    if command == "list-maps":
        items = list_maps(str(args.get("filter") or ""))
        return {"ok": True, "message": f"Listed {len(items)} map asset(s)", "data": {"assets": items}}

    if command == "find-actors":
        actors = list_actors(str(args.get("name") or ""), str(args.get("class_name") or ""), str(args.get("filter") or ""))
        return {"ok": True, "message": f"Found {len(actors)} actor(s)", "data": {"actors": actors}}

    if command == "inspect-actor":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        return {"ok": True, "message": f"Inspected actor {actor.get_actor_label()}", "data": {"actor": actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())}}

    if command == "get-selection":
        subsystem = actor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "EditorActorSubsystem is unavailable"}
        actors = [actor_payload(actor, selected_paths=selected_actor_paths()) for actor in subsystem.get_selected_level_actors()]
        return {"ok": True, "message": f"Listed {len(actors)} selected actor(s)", "data": {"actors": actors}}

    if command == "play":
        subsystem = level_editor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "LevelEditorSubsystem is unavailable"}
        subsystem.editor_request_begin_play()
        return {"ok": True, "message": "Requested Play In Editor", "data": status_payload()}

    if command == "stop":
        subsystem = level_editor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "LevelEditorSubsystem is unavailable"}
        subsystem.editor_request_end_play()
        return {"ok": True, "message": "Requested end Play In Editor", "data": status_payload()}

    if command == "open-map":
        map_path = str(args.get("path") or "")
        if not map_path:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "path is required"}
        subsystem = level_editor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "LevelEditorSubsystem is unavailable"}
        if not subsystem.load_level(normalize_asset_path(map_path)):
            return {"ok": False, "category": "LOAD_FAILED", "message": f"Failed to open map {map_path}"}
        return {"ok": True, "message": f"Opened map {map_path}", "data": status_payload()}

    if command == "new-level":
        target_path = str(args.get("path") or "")
        if not target_path:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "path is required"}
        subsystem = level_editor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "LevelEditorSubsystem is unavailable"}
        normalized = normalize_asset_path(target_path)
        created = subsystem.new_level(normalized, bool(args.get("partitioned")))
        if not created:
            return {"ok": False, "category": "CREATE_FAILED", "message": f"Failed to create level {normalized}"}
        return {"ok": True, "message": f"Created level {normalized}", "data": status_payload()}

    if command == "save-all":
        subsystem = level_editor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "LevelEditorSubsystem is unavailable"}
        saved = subsystem.save_all_dirty_levels()
        return {"ok": True, "message": "Saved dirty assets and maps", "data": {"saved": bool(saved)}}

    if command == "save-current-level":
        subsystem = level_editor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "LevelEditorSubsystem is unavailable"}
        saved = subsystem.save_current_level()
        return {"ok": True, "message": "Saved current level", "data": {"saved": bool(saved)}}

    if command == "create-actor":
        class_path = str(args.get("class_path") or DEFAULT_ACTOR_CLASS)
        actor_class = unreal.load_class(None, class_path)
        if actor_class is None:
            return {"ok": False, "category": "CLASS_NOT_FOUND", "message": f"Unable to load actor class: {class_path}"}
        subsystem = actor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "EditorActorSubsystem is unavailable"}
        actor = subsystem.spawn_actor_from_class(
            actor_class,
            vector_from(args.get("location")),
            rotator_from(args.get("rotation")),
        )
        if actor is None:
            return {"ok": False, "category": "SPAWN_FAILED", "message": f"Failed to spawn actor from class: {class_path}"}
        label = str(args.get("label") or "").strip()
        if label:
            actor.set_actor_label(label)
        if isinstance(args.get("scale"), list):
            actor.set_actor_scale3d(vector_from(args.get("scale"), [1.0, 1.0, 1.0]))
        parent_ref = str(args.get("parent") or "").strip()
        if parent_ref:
            parent_actor = find_actor(parent_ref, parent_ref)
            if parent_actor is None:
                return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": f"Parent actor not found: {parent_ref}"}
            attach_rule, _ = attachment_rules(str(args.get("mode") or "keep_world"))
            actor.attach_to_actor(parent_actor, "", attach_rule, attach_rule, attach_rule, False)
        if bool(args.get("select")) and subsystem is not None:
            subsystem.set_selected_level_actors([actor])
        return {
            "ok": True,
            "message": f"Spawned actor {actor.get_actor_label()}",
            "data": {"actor": actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())},
        }

    if command == "destroy-actor":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        subsystem = actor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "EditorActorSubsystem is unavailable"}
        actor_label = actor.get_actor_label()
        subsystem.destroy_actor(actor)
        return {"ok": True, "message": f"Destroyed actor {actor_label}", "data": {}}

    if command == "duplicate-actor":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        subsystem = actor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "EditorActorSubsystem is unavailable"}
        duplicate = subsystem.duplicate_actor(actor, current_world(), vector_from(args.get("offset")))
        if duplicate is None:
            return {"ok": False, "category": "DUPLICATE_FAILED", "message": f"Failed to duplicate actor {actor.get_actor_label()}"}
        label = str(args.get("label") or "").strip()
        if label:
            duplicate.set_actor_label(label)
        if bool(args.get("select")):
            subsystem.set_selected_level_actors([duplicate])
        return {"ok": True, "message": f"Duplicated actor {actor.get_actor_label()}", "data": {"actor": actor_payload(duplicate, include_components=True, selected_paths=selected_actor_paths())}}

    if command == "set-actor-transform":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        if isinstance(args.get("location"), list):
            actor.set_actor_location(vector_from(args.get("location")), False, True)
        if isinstance(args.get("rotation"), list):
            actor.set_actor_rotation(rotator_from(args.get("rotation")), True)
        if isinstance(args.get("scale"), list):
            actor.set_actor_scale3d(vector_from(args.get("scale"), [1.0, 1.0, 1.0]))
        return {"ok": True, "message": f"Updated transform for {actor.get_actor_label()}", "data": {"actor": actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())}}

    if command == "set-parent":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        attach_rule, detach_rule = attachment_rules(str(args.get("mode") or "keep_world"))
        parent_ref = str(args.get("parent") or "").strip()
        if parent_ref:
            parent_actor = find_actor(parent_ref, parent_ref)
            if parent_actor is None:
                return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": f"Parent actor not found: {parent_ref}"}
            actor.attach_to_actor(parent_actor, "", attach_rule, attach_rule, attach_rule, False)
            return {"ok": True, "message": f"Attached {actor.get_actor_label()} to {parent_actor.get_actor_label()}", "data": {"actor": actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())}}
        actor.detach_from_actor(detach_rule, detach_rule, detach_rule)
        return {"ok": True, "message": f"Detached {actor.get_actor_label()} from its parent", "data": {"actor": actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())}}

    if command == "set-property":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        property_name = str(args.get("property") or "").strip()
        if not property_name:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "property is required"}
        target = actor
        component_ref = str(args.get("component") or "").strip()
        if component_ref:
            component = resolve_component(actor, component_ref)
            if component is None:
                return {"ok": False, "category": "COMPONENT_NOT_FOUND", "message": f"Component not found: {component_ref}"}
            target = component
        try:
            target.set_editor_property(property_name, args.get("value"))
        except Exception as exc:
            return {"ok": False, "category": "PROPERTY_SET_FAILED", "message": str(exc)}
        message_target = component_ref or actor.get_actor_label()
        return {"ok": True, "message": f"Updated property {property_name} on {message_target}", "data": {"actor": actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())}}

    if command == "select-actor":
        try:
            actor = resolve_actor(args)
        except ValueError as exc:
            return {"ok": False, "category": "ACTOR_NOT_FOUND", "message": str(exc)}
        subsystem = actor_subsystem()
        if subsystem is None:
            return {"ok": False, "category": "EDITOR_SUBSYSTEM_UNAVAILABLE", "message": "EditorActorSubsystem is unavailable"}
        subsystem.set_selected_level_actors([actor])
        return {"ok": True, "message": f"Selected actor {actor.get_actor_label()}", "data": {"actors": [actor_payload(actor, include_components=True, selected_paths=selected_actor_paths())]}}

    if command == "inspect-asset":
        asset = inspect_asset(str(args.get("path") or ""))
        if asset is None:
            return {"ok": False, "category": "ASSET_NOT_FOUND", "message": f"Asset not found: {args.get('path') or ''}"}
        return {"ok": True, "message": f"Inspected asset {asset['path']}", "data": {"asset": asset}}

    if command == "create-directory":
        directory = normalize_content_path(str(args.get("path") or ""))
        if not directory:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "path is required"}
        created = unreal.EditorAssetLibrary.make_directory(directory)
        return {"ok": bool(created), "message": f"Created directory {directory}" if created else f"Failed to create directory {directory}", "data": {"path": directory}}

    if command == "create-material":
        try:
            package_path, asset_name = split_asset_path(str(args.get("path") or ""))
        except ValueError as exc:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": str(exc)}
        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        asset = asset_tools.create_asset(asset_name, package_path, unreal.Material, unreal.MaterialFactoryNew())
        if asset is None:
            return {"ok": False, "category": "CREATE_FAILED", "message": f"Failed to create material {asset_name}"}
        asset_path_value = normalize_asset_path(f"{package_path}/{asset_name}")
        return {"ok": True, "message": f"Created material {asset_path_value}", "data": {"asset": inspect_asset(asset_path_value)}}

    if command == "duplicate-asset":
        source = normalize_asset_path(str(args.get("source") or ""))
        destination = normalize_asset_path(str(args.get("path") or ""))
        if not source or not destination:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "source and path are required"}
        duplicated = unreal.EditorAssetLibrary.duplicate_asset(source, destination)
        if duplicated is None:
            return {"ok": False, "category": "DUPLICATE_FAILED", "message": f"Failed to duplicate asset {source} to {destination}"}
        return {"ok": True, "message": f"Duplicated asset to {destination}", "data": {"asset": inspect_asset(destination)}}

    if command == "rename-asset":
        source = normalize_asset_path(str(args.get("source") or ""))
        destination = normalize_asset_path(str(args.get("path") or ""))
        if not source or not destination:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "source and path are required"}
        renamed = unreal.EditorAssetLibrary.rename_asset(source, destination)
        if not renamed:
            return {"ok": False, "category": "RENAME_FAILED", "message": f"Failed to rename asset {source} to {destination}"}
        return {"ok": True, "message": f"Renamed asset to {destination}", "data": {"asset": inspect_asset(destination)}}

    if command == "delete-asset":
        asset_path_value = normalize_asset_path(str(args.get("path") or ""))
        if not asset_path_value:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "path is required"}
        deleted = unreal.EditorAssetLibrary.delete_asset(asset_path_value)
        return {"ok": bool(deleted), "message": f"Deleted asset {asset_path_value}" if deleted else f"Failed to delete asset {asset_path_value}", "data": {"path": asset_path_value}}

    if command == "save-asset":
        asset_path_value = normalize_asset_path(str(args.get("path") or ""))
        if not asset_path_value:
            return {"ok": False, "category": "INVALID_ARGUMENT", "message": "path is required"}
        saved = unreal.EditorAssetLibrary.save_asset(asset_path_value)
        return {"ok": bool(saved), "message": f"Saved asset {asset_path_value}" if saved else f"Failed to save asset {asset_path_value}", "data": {"asset": inspect_asset(asset_path_value)}}

    return {"ok": False, "category": "UNKNOWN_COMMAND", "message": f"Unknown Unreal bridge command: {command}"}


def main() -> None:
    request = load_request()
    command = str(request.get("command") or "")
    args = request.get("args") or {}
    if not isinstance(args, dict):
        args = {}

    try:
        response = dispatch(command, args)
    except Exception as exc:  # pragma: no cover - Unreal runtime path
        response = {
            "ok": False,
            "category": "UNHANDLED_EXCEPTION",
            "message": str(exc),
            "details": {"traceback": traceback.format_exc()},
        }

    append_console("info" if bool(response.get("ok")) else "error", command or "unknown", {"response": response})
    write_response(response)


if __name__ == "__main__":
    main()
