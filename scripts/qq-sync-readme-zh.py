#!/usr/bin/env python3
"""
qq-sync-readme-zh.py — Keep root README's Chinese half in sync with docs/zh-CN/README.md.

The standalone docs/zh-CN/README.md is the Chinese canonical: it is a normal
markdown file with relative paths to siblings under docs/zh-CN/, easier to
edit than the embedded section in a 470-line root README. The root README's
Chinese half is a generated mirror produced by this script. The workflow is:

  1. Edit docs/zh-CN/README.md
  2. Run: python scripts/qq-sync-readme-zh.py --write
  3. Commit both files

test.sh section 4 enforces the contract by running this script with --check
and failing the build if root README has drifted from the canonical.

Modes
-----
  --check (default)  exit 1 if root README's Chinese half drifts from canonical
  --write            rewrite root README's Chinese half in place
  --print            emit the generated mirror block to stdout (debugging)

Path rewriting
--------------
The canonical lives at docs/zh-CN/README.md, so its relative paths look like:
  - bare:        getting-started.md          → docs/zh-CN/getting-started.md
  - up one:      ../dev/architecture/ow.md   → docs/dev/architecture/ow.md
  - up two:      ../../templates/foo.example → templates/foo.example
  - external:    https://...                 → unchanged
  - anchor only: #section                    → unchanged

The Chinese half in root README needs all paths repo-rooted (root README
itself sits at the repo root), so the rewriter applies the rules above.
"""
import argparse
import difflib
import re
import sys
from pathlib import Path


def rewrite_path(path: str) -> str:
    """Rewrite a single link target from docs/zh-CN/-relative to repo-root-relative."""
    # External links and protocol-relative URLs: leave unchanged
    if path.startswith(("http://", "https://", "mailto:", "//")):
        return path
    # Pure anchor: leave unchanged
    if path.startswith("#"):
        return path
    # Split off any anchor so we can preserve it
    if "#" in path:
        url, anchor = path.split("#", 1)
        anchor = "#" + anchor
    else:
        url, anchor = path, ""
    # Empty url after anchor split: leave it
    if not url:
        return anchor
    # Normalize ./X → X
    if url.startswith("./"):
        url = url[2:]
    # Walk up the relative path
    if url.startswith("../../"):
        url = url[6:]  # ../../ from docs/zh-CN/ = repo root
    elif url.startswith("../"):
        url = "docs/" + url[3:]  # ../ from docs/zh-CN/ = docs/
    elif not url.startswith("/"):
        # bare or sub-path, sibling of docs/zh-CN/README.md
        url = "docs/zh-CN/" + url
    return url + anchor


def rewrite_links(text: str) -> str:
    """Rewrite every markdown link target in a text block."""

    def repl(match: "re.Match[str]") -> str:
        link_text = match.group(1)
        url = match.group(2)
        return f"[{link_text}]({rewrite_path(url)})"

    return re.sub(r"\[([^\]]*)\]\(([^)]+)\)", repl, text)


def extract_canonical_body(canonical_text: str) -> str:
    """Strip the title + lang nav + first '---' from the canonical and return the body."""
    parts = canonical_text.split("\n---\n", 1)
    if len(parts) < 2:
        raise ValueError(
            "canonical does not contain a leading '---' separator after the lang nav"
        )
    return parts[1].lstrip("\n").rstrip()


def build_root_chinese_block(canonical_text: str) -> str:
    """Build the full Chinese-half block (h2 + body) for root README."""
    body = extract_canonical_body(canonical_text)
    body = rewrite_links(body)
    return f'<h2 align="center">中文</h2>\n\n{body}\n'


# Match the existing Chinese-half block in root README. The block runs from
# `<h2 align="center">中文</h2>` up to (but not including) the trailing
# `---\n\n## Contributing` separator that introduces the project-level footer.
ROOT_BLOCK_PATTERN = re.compile(
    r'<h2 align="center">中文</h2>.*?(?=\n---\n\n## Contributing)',
    re.DOTALL,
)


def replace_root_chinese_block(root_text: str, new_block: str) -> str:
    if not ROOT_BLOCK_PATTERN.search(root_text):
        raise ValueError(
            'could not find <h2 align="center">中文</h2>...---\\n\\n## Contributing '
            "block in root README — has the structure changed?"
        )
    return ROOT_BLOCK_PATTERN.sub(new_block, root_text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync root README Chinese half from docs/zh-CN/README.md",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if root README has drifted from the canonical (default)",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="rewrite root README's Chinese half in place from canonical",
    )
    parser.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="print the generated Chinese-half block to stdout (debugging)",
    )
    parser.add_argument(
        "--project",
        type=Path,
        default=None,
        help="repo root (default: walk up from this script)",
    )
    args = parser.parse_args()

    if not (args.check or args.write or args.print_only):
        args.check = True

    if args.project:
        repo = args.project
    else:
        # walk up from scripts/ to repo root
        repo = Path(__file__).resolve().parents[1]

    canonical_path = repo / "docs" / "zh-CN" / "README.md"
    root_path = repo / "README.md"

    if not canonical_path.exists():
        print(f"canonical not found: {canonical_path}", file=sys.stderr)
        return 1
    if not root_path.exists():
        print(f"root README not found: {root_path}", file=sys.stderr)
        return 1

    canonical_text = canonical_path.read_text(encoding="utf-8")
    root_text = root_path.read_text(encoding="utf-8")

    new_block = build_root_chinese_block(canonical_text)

    if args.print_only:
        sys.stdout.write(new_block)
        return 0

    new_root_text = replace_root_chinese_block(root_text, new_block)

    if new_root_text == root_text:
        if args.check:
            print(
                "OK: root README Chinese half is in sync with docs/zh-CN/README.md"
            )
        return 0

    if args.write:
        root_path.write_text(new_root_text, encoding="utf-8")
        print(
            "WROTE: root README Chinese half synced from docs/zh-CN/README.md"
        )
        return 0

    # check mode + drift detected
    print(
        "DRIFT: root README Chinese half does not match docs/zh-CN/README.md",
        file=sys.stderr,
    )
    print(
        "Fix:   python scripts/qq-sync-readme-zh.py --write",
        file=sys.stderr,
    )
    diff = list(
        difflib.unified_diff(
            root_text.splitlines(),
            new_root_text.splitlines(),
            fromfile="README.md (current)",
            tofile="README.md (after sync)",
            lineterm="",
            n=2,
        )
    )
    if diff:
        print("\nFirst 30 lines of drift:", file=sys.stderr)
        for line in diff[:30]:
            print(line, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
