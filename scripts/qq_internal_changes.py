#!/usr/bin/env python3
from __future__ import annotations

import hashlib
from pathlib import Path

from qq_internal_git import run_git


IGNORED_STATUS_PREFIXES = (
    ".qq/",
)
STATIC_IGNORED_STATUS_PATHS = {
    ".qq",
    ".qq/local.yaml",
    ".mcp.json",
    ".claude/settings.local.json",
    "qq.yaml",
}
IGNORED_STATUS_SEGMENTS = {
    "__pycache__",
}
IGNORED_STATUS_SUFFIXES = (
    ".pyc",
    ".pyo",
)


def normalize_status_path(raw: str) -> str:
    path = raw.strip()
    if " -> " in path:
        path = path.split(" -> ", 1)[1].strip()
    return Path(path).as_posix()


def is_ignored_status_path(relative_path: str) -> bool:
    normalized = normalize_status_path(relative_path).rstrip("/")
    if normalized in STATIC_IGNORED_STATUS_PATHS:
        return True
    if any(normalized.startswith(prefix) for prefix in IGNORED_STATUS_PREFIXES):
        return True
    parts = [part for part in Path(normalized).parts if part not in {"."}]
    if any(part in IGNORED_STATUS_SEGMENTS for part in parts):
        return True
    if normalized.endswith(IGNORED_STATUS_SUFFIXES):
        return True
    return False


def meaningful_local_change_paths(project_dir: Path) -> list[str]:
    result = run_git(project_dir, "status", "--porcelain", check=False)
    if result.returncode != 0:
        return []

    paths: set[str] = set()
    for raw in result.stdout.splitlines():
        line = raw.rstrip()
        if len(line) < 4:
            continue
        relative_path = normalize_status_path(line[3:])
        if not relative_path or is_ignored_status_path(relative_path):
            continue
        paths.add(relative_path)
    return sorted(paths)


def file_content_digest(path: Path) -> str:
    if not path.exists() or not path.is_file():
        return "missing"
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def meaningful_local_change_snapshot(project_dir: Path) -> dict[str, object]:
    result = run_git(project_dir, "status", "--porcelain", check=False)
    if result.returncode != 0:
        return {"paths": [], "fingerprint": ""}

    entries: list[str] = []
    paths: list[str] = []
    for raw in result.stdout.splitlines():
        line = raw.rstrip()
        if len(line) < 4:
            continue
        status = line[:2]
        relative_path = normalize_status_path(line[3:])
        if not relative_path or is_ignored_status_path(relative_path):
            continue
        content_digest = file_content_digest(project_dir / relative_path)
        entries.append(f"{status} {relative_path} {content_digest}")
        paths.append(relative_path)

    payload = "\n".join(sorted(entries)).encode("utf-8")
    fingerprint = hashlib.sha256(payload).hexdigest() if entries else ""
    return {"paths": sorted(set(paths)), "fingerprint": fingerprint}


def latest_change_mtime(project_dir: Path, changed_files: list[str]) -> float | None:
    latest: float | None = None
    for relative in changed_files:
        path = project_dir / relative
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        latest = mtime if latest is None else max(latest, mtime)
    return latest
