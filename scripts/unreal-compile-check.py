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


def write_payload(payload: dict[str, Any]) -> None:
    output_path = os.environ.get("QQ_UNREAL_OUTPUT_PATH", "").strip()
    encoded = json.dumps(payload, ensure_ascii=False)
    if output_path:
        Path(output_path).write_text(encoded, encoding="utf-8")
    print(f"QQ_UNREAL_COMPILE_RESULT::{encoded}")


def asset_class_name(asset_data: Any) -> str:
    class_path = getattr(asset_data, "asset_class_path", None)
    if class_path is not None:
        asset_name = getattr(class_path, "asset_name", "")
        if asset_name:
            return str(asset_name)
    asset_class = getattr(asset_data, "asset_class", "")
    return str(asset_class)


def asset_object_path(asset_data: Any) -> str:
    for attribute in ("object_path_string", "object_path"):
        value = getattr(asset_data, attribute, "")
        if value:
            return str(value)
    return ""


def main() -> None:
    if unreal is None:
        write_payload(
            {
                "ok": False,
                "finding_count": 1,
                "findings": ["Unreal Python module is unavailable. Enable PythonScriptPlugin before running qq compile checks."],
            }
        )
        return

    findings: list[str] = []
    compiled_blueprints = 0

    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        assets = registry.get_assets_by_path("/Game", recursive=True)
        for asset in assets:
            class_name = asset_class_name(asset)
            if "Blueprint" not in class_name:
                continue
            object_path = asset_object_path(asset)
            if not object_path:
                continue
            blueprint = unreal.EditorAssetLibrary.load_asset(object_path)
            if blueprint is None:
                findings.append(f"Failed to load blueprint asset: {object_path}")
                continue
            try:
                unreal.KismetEditorUtilities.compile_blueprint(blueprint)
                compiled_blueprints += 1
            except Exception as exc:  # pragma: no cover - Unreal runtime path
                findings.append(f"Failed to compile blueprint {object_path}: {exc}")
    except Exception as exc:  # pragma: no cover - Unreal runtime path
        findings.append(f"Unreal compile check crashed: {exc}")
        findings.append(traceback.format_exc())

    write_payload(
        {
            "ok": len(findings) == 0,
            "finding_count": len(findings),
            "compiled_blueprints": compiled_blueprints,
            "findings": findings,
        }
    )


if __name__ == "__main__":
    main()
