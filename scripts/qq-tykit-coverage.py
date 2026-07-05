#!/usr/bin/env python3
"""
qq-tykit-coverage.py — Audit tykit command-class test coverage.

Walks packages/com.tyk.tykit/Editor/Commands/*Commands.cs to find every
CommandRegistry.Register / CommandRegistry.Describe call and extracts the
command name (the first string literal). Then walks
packages/com.tyk.tykit/Tests/Editor/*.cs and checks whether each command
name appears anywhere in the test files as a literal string.

Output:
  - Per-class breakdown: covered count / total, plus the uncovered list
  - Summary: total registered, total covered, total uncovered

Exit codes:
  - 0       always (informational mode, default) — even if uncovered > 0
  - 0 / 1   --strict mode: 1 if any uncovered, 0 otherwise
  - 0 / 1   --max-uncovered N mode: 1 if uncovered > N, 0 otherwise
            (used by test.sh as a ratchet — bake the current uncovered
            count in and refuse to let it grow)

Why this exists
---------------
tykit v0.5.0 shipped ~50 new commands (reflection / prefab / physics /
asset / UI / prefs / batch / main-thread recovery) but test coverage did
not follow at the same pace. This audit is the source of truth for the
test backlog and the regression guard for new untested commands.

Usage
-----
  qq-tykit-coverage.py                       # informational, exit 0
  qq-tykit-coverage.py --strict              # exit 1 if any uncovered
  qq-tykit-coverage.py --max-uncovered 33    # ratchet: exit 1 if > 33
  qq-tykit-coverage.py --json                # machine-readable output
"""
import argparse
import json
import re
import sys
from pathlib import Path

# Match the first string literal of CommandRegistry.Describe(...) calls.
# Tolerates whitespace and newlines between Describe and the opening paren.
DESCRIBE_PATTERN = re.compile(r'Describe\s*\(\s*"([^"]+)"', re.MULTILINE)


def find_repo_root(start: Path) -> Path:
    """Walk up from start until we find a directory containing .git or
    packages/com.tyk.tykit. Falls back to start.parents[1]."""
    current = start.resolve()
    for candidate in [current] + list(current.parents):
        if (candidate / ".git").exists():
            return candidate
        if (candidate / "packages" / "com.tyk.tykit").exists():
            return candidate
    return start.parents[1]


def extract_registered_commands(cs_file: Path) -> set:
    """Extract all command names registered in a *Commands.cs file."""
    text = cs_file.read_text(encoding="utf-8")
    return set(DESCRIBE_PATTERN.findall(text))


def collect_test_blob(test_dir: Path) -> str:
    """Concatenate all C# test files into one big text blob."""
    parts = []
    for test_file in sorted(test_dir.glob("*.cs")):
        parts.append(test_file.read_text(encoding="utf-8"))
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser(
        description="Audit tykit command test coverage"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit 1 if any registered command is uncovered",
    )
    parser.add_argument(
        "--max-uncovered",
        type=int,
        default=None,
        metavar="N",
        help="Ratchet: exit 1 if uncovered count exceeds N",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of human text",
    )
    parser.add_argument(
        "--project",
        type=Path,
        default=None,
        help="Path to the qq repo root (default: walk up from this script)",
    )
    args = parser.parse_args()

    repo = args.project if args.project else find_repo_root(Path(__file__).resolve().parent)
    cmd_dir = repo / "packages" / "com.tyk.tykit" / "Editor" / "Commands"
    test_dir = repo / "packages" / "com.tyk.tykit" / "Tests" / "Editor"

    if not cmd_dir.exists():
        print(f"tykit command dir not found: {cmd_dir}", file=sys.stderr)
        return 0  # not a hard failure — repo without tykit is fine
    if not test_dir.exists():
        print(f"tykit test dir not found: {test_dir}", file=sys.stderr)
        return 0

    # Step 1: collect registered commands per *Commands.cs file
    per_class = {}
    all_registered = set()
    for cs_file in sorted(cmd_dir.glob("*Commands.cs")):
        cmds = extract_registered_commands(cs_file)
        per_class[cs_file.stem] = sorted(cmds)
        all_registered.update(cmds)

    # Step 2: read all test files into one blob and check covered
    test_blob = collect_test_blob(test_dir)
    covered = {cmd for cmd in all_registered if f'"{cmd}"' in test_blob}
    uncovered = sorted(all_registered - covered)

    # Build per-class report
    report = {}
    for class_name, cmds in per_class.items():
        cmd_set = set(cmds)
        class_covered = sorted(cmd_set & covered)
        class_uncovered = sorted(cmd_set - covered)
        report[class_name] = {
            "total": len(cmds),
            "covered": len(class_covered),
            "uncovered": len(class_uncovered),
            "uncovered_list": class_uncovered,
        }

    summary = {
        "total_registered": len(all_registered),
        "total_covered": len(covered),
        "total_uncovered": len(uncovered),
        "uncovered_list": uncovered,
        "per_class": report,
    }

    if args.json:
        json.dump(summary, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print("tykit command coverage audit")
        print("=" * 50)
        print(
            f"Total registered: {summary['total_registered']}   "
            f"covered: {summary['total_covered']}   "
            f"uncovered: {summary['total_uncovered']}"
        )
        print()
        for class_name in sorted(per_class.keys()):
            r = report[class_name]
            if r["total"] == 0:
                # Class file exists but no Describe() calls — probably uses
                # a non-standard registration path. Skip silently.
                continue
            pct = (r["covered"] * 100) // r["total"] if r["total"] else 0
            marker = "OK " if r["uncovered"] == 0 else "GAP"
            print(f"  [{marker}] {class_name}: {r['covered']}/{r['total']} ({pct}%)")
            for cmd in r["uncovered_list"]:
                print(f"        - {cmd}")
        print()
        if uncovered:
            print(
                f"NOTE: {len(uncovered)} commands have no test coverage. "
                f"This is the test backlog for v1.17.0 — see "
                f"docs/dev/core-roadmap.md."
            )
        else:
            print("All registered commands have at least one test reference.")

    # Exit code
    if args.strict and uncovered:
        return 1
    if args.max_uncovered is not None and len(uncovered) > args.max_uncovered:
        print(
            f"\nFAIL: uncovered count {len(uncovered)} > "
            f"--max-uncovered {args.max_uncovered}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
