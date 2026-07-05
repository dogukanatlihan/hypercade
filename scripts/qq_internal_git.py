#!/usr/bin/env python3
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


# Standard git hook filenames; used to detect whether a hooks directory contains
# any executable hooks (vs. just a sample directory or empty dir).
_GIT_HOOK_FILENAMES = (
    "applypatch-msg",
    "commit-msg",
    "fsmonitor-watchman",
    "post-applypatch",
    "post-checkout",
    "post-commit",
    "post-merge",
    "post-receive",
    "post-rewrite",
    "post-update",
    "pre-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "pre-rebase",
    "pre-receive",
    "prepare-commit-msg",
    "proc-receive",
    "push-to-checkout",
    "sendemail-validate",
    "update",
)


@dataclass(frozen=True)
class GitContext:
    project_dir: Path
    work_tree_root: Path
    git_dir: Path | None
    use_explicit_work_tree: bool

    def command(self, *args: str) -> list[str]:
        command = ["git"]
        if self.use_explicit_work_tree and self.git_dir is not None:
            command.extend(
                [
                    f"--git-dir={self.git_dir}",
                    f"--work-tree={self.work_tree_root}",
                ]
            )
        command.extend(args)
        return command

    @property
    def cwd(self) -> Path:
        return self.work_tree_root if self.use_explicit_work_tree else self.project_dir


def _run_plain_git(project_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=project_dir,
        check=False,
        capture_output=True,
        text=True,
    )


def _discover_work_tree_root(project_dir: Path) -> Path | None:
    for candidate in [project_dir, *project_dir.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def _resolve_git_dir(project_dir: Path, fallback_root: Path | None) -> Path | None:
    result = _run_plain_git(project_dir, "rev-parse", "--git-dir")
    raw = result.stdout.strip()
    if result.returncode == 0 and raw:
        path = Path(raw)
        if not path.is_absolute():
            path = (project_dir / path).resolve()
        else:
            path = path.resolve()
        return path
    if fallback_root is not None and (fallback_root / ".git").exists():
        return (fallback_root / ".git").resolve()
    return None


@lru_cache(maxsize=32)
def resolve_git_context(project_dir: str | Path) -> GitContext:
    project_path = Path(project_dir).resolve()
    discovered_root = _discover_work_tree_root(project_path) or project_path

    bare_result = _run_plain_git(project_path, "config", "--bool", "--get", "core.bare")
    is_bare = bare_result.returncode == 0 and bare_result.stdout.strip().lower() == "true"

    if is_bare:
        git_dir = _resolve_git_dir(project_path, discovered_root)
        return GitContext(
            project_dir=project_path,
            work_tree_root=discovered_root,
            git_dir=git_dir,
            use_explicit_work_tree=True,
        )

    top_level = _run_plain_git(project_path, "rev-parse", "--show-toplevel")
    work_tree_root = discovered_root
    if top_level.returncode == 0 and top_level.stdout.strip():
        work_tree_root = Path(top_level.stdout.strip()).resolve()

    git_dir = _resolve_git_dir(project_path, work_tree_root)
    return GitContext(
        project_dir=project_path,
        work_tree_root=work_tree_root,
        git_dir=git_dir,
        use_explicit_work_tree=False,
    )


def run_git(project_dir: str | Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    context = resolve_git_context(project_dir)
    result = subprocess.run(
        context.command(*args),
        cwd=context.cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "git command failed")
    return result


def repo_root(project_dir: str | Path) -> Path:
    return resolve_git_context(project_dir).work_tree_root


def _hook_dir_has_hooks(directory: Path) -> bool:
    if not directory.is_dir():
        return False
    for name in _GIT_HOOK_FILENAMES:
        if (directory / name).is_file():
            return True
    return False


def _read_hooks_path_config(project_dir: Path) -> tuple[str, str]:
    """Return (value, scope) for core.hooksPath. scope is local/global/system or ""."""
    for scope in ("local", "global", "system"):
        result = _run_plain_git(project_dir, "config", f"--{scope}", "--get", "core.hooksPath")
        value = (result.stdout or "").strip()
        if result.returncode == 0 and value:
            return value, scope
    return "", ""


def check_git_hooks(project_dir: str | Path) -> dict[str, Any]:
    """Inspect core.hooksPath for the silently-broken configuration where it is
    set (often to a hardcoded absolute path) but resolves to the same place git
    would use by default. That setup is redundant and blocks any .githooks/
    convention from taking effect.

    Returns a dict suitable for embedding in qq-doctor JSON output. Status is
    one of: not-a-repo, ok, warn, broken.
    """
    project_path = Path(project_dir).resolve()

    info: dict[str, Any] = {
        "isGitRepo": False,
        "hooksPath": "",
        "hooksPathScope": "",
        "hooksPathIsAbsolute": False,
        "resolvedHooksPath": "",
        "defaultHooksDir": "",
        "altHooksDir": "",
        "altHooksDirHasHooks": False,
        "status": "not-a-repo",
        "issues": [],
        "recommendedAction": "",
        "autoFixable": False,
        "autoFixCommand": "",
    }

    git_dir_result = _run_plain_git(project_path, "rev-parse", "--git-dir")
    if git_dir_result.returncode != 0:
        return info
    raw_git_dir = (git_dir_result.stdout or "").strip()
    if not raw_git_dir:
        return info

    git_dir = Path(raw_git_dir)
    if not git_dir.is_absolute():
        git_dir = (project_path / git_dir).resolve()
    else:
        git_dir = git_dir.resolve()

    info["isGitRepo"] = True
    info["status"] = "ok"

    default_dir = (git_dir / "hooks").resolve()
    info["defaultHooksDir"] = str(default_dir)

    alt_dir = (project_path / ".githooks").resolve()
    info["altHooksDir"] = str(alt_dir)
    info["altHooksDirHasHooks"] = _hook_dir_has_hooks(alt_dir)

    raw_value, scope = _read_hooks_path_config(project_path)
    info["hooksPath"] = raw_value
    info["hooksPathScope"] = scope

    if not raw_value:
        if info["altHooksDirHasHooks"]:
            info["status"] = "warn"
            info["issues"].append(
                ".githooks/ contains hook files but core.hooksPath is unset, "
                "so git is reading the default .git/hooks/ instead."
            )
            info["recommendedAction"] = "git config core.hooksPath .githooks"
        return info

    raw_path = Path(raw_value)
    info["hooksPathIsAbsolute"] = raw_path.is_absolute()
    try:
        if raw_path.is_absolute():
            resolved = raw_path.resolve()
        else:
            resolved = (project_path / raw_path).resolve()
    except OSError:
        resolved = raw_path
    info["resolvedHooksPath"] = str(resolved)

    if resolved == default_dir:
        if raw_path.is_absolute():
            info["issues"].append(
                f"core.hooksPath is hardcoded to an absolute path ({raw_value}) "
                "that resolves to the default .git/hooks/. The setting has no "
                "useful effect, breaks if the project is moved, and silently "
                "blocks any .githooks/ convention from being used."
            )
        else:
            info["issues"].append(
                f"core.hooksPath is set to '{raw_value}', which is the default "
                "git hooks location. The setting is redundant and blocks "
                ".githooks/ from being used."
            )
        info["status"] = "broken"
        if info["altHooksDirHasHooks"]:
            info["recommendedAction"] = "git config core.hooksPath .githooks"
            info["autoFixCommand"] = "git config core.hooksPath .githooks"
        else:
            info["recommendedAction"] = "git config --unset core.hooksPath"
            info["autoFixCommand"] = "git config --unset core.hooksPath"
        # Only auto-fix when the bad setting lives in the local repo config —
        # never touch global or system git config silently.
        info["autoFixable"] = (scope == "local")
        return info

    if not resolved.is_dir():
        info["status"] = "broken"
        info["issues"].append(
            f"core.hooksPath points to '{raw_value}' (resolved: {resolved}), "
            "but that directory does not exist."
        )
        info["recommendedAction"] = (
            "Verify the path or unset it: git config --unset core.hooksPath"
        )

    return info


def apply_safe_git_hooks_fix(project_dir: str | Path) -> dict[str, Any] | None:
    """Apply the auto-fix recommended by check_git_hooks(), but only when it is
    marked safe (autoFixable). Returns a small report describing what was done,
    or None if no fix was applied.
    """
    project_path = Path(project_dir).resolve()
    info = check_git_hooks(project_path)
    if not info["autoFixable"] or not info["autoFixCommand"]:
        return None
    if info["hooksPathScope"] != "local":
        return None

    parts = info["autoFixCommand"].split()
    if parts[:2] != ["git", "config"]:
        return None
    git_args = parts[1:]  # drop only the leading 'git', keep 'config' and the rest
    if not git_args:
        return None

    result = _run_plain_git(project_path, *git_args)
    # `git config --unset` returns 5 if the key was already unset; treat as success.
    if result.returncode not in (0, 5):
        return None

    return {
        "previousValue": info["hooksPath"],
        "previousScope": info["hooksPathScope"],
        "command": info["autoFixCommand"],
        "altHooksDirHasHooks": info["altHooksDirHasHooks"],
        "status": "fixed",
    }
