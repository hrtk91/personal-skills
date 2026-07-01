#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REQUIRED_PATTERNS = {
    "happy path": r"happy|success|succeeded",
    "qc repair loop": r"qc.*loop|repair.*loop|attempt",
    "loop exhausted": r"exhaust|limit|max",
    "executor failure": r"executor.*fail|run_executor.*fail",
    "diagnosis creates action": r"diagnosis.*repair_action|draft.*repair_action",
    "diagnosis failure": r"diagnosis.*fail",
    "human needed": r"human_needed|human.*needed",
    "repair action success": r"repair_action.*success|repair_action.*succeed",
    "repair action failure": r"repair_action.*fail|repair_action.*qc_failed",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Check whether workflow E2E tests mention required failure-path cases.")
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()

    text_parts: list[str] = []
    for path in args.paths:
        if path.is_dir():
            for file in sorted(path.rglob("test*.py")):
                text_parts.append(file.read_text(encoding="utf-8", errors="replace"))
        elif path.is_file():
            text_parts.append(path.read_text(encoding="utf-8", errors="replace"))
    text = "\n".join(text_parts).lower()

    missing = [name for name, pattern in REQUIRED_PATTERNS.items() if not re.search(pattern, text, re.IGNORECASE | re.DOTALL)]
    if missing:
        print("missing E2E coverage hints:")
        for name in missing:
            print(f"- {name}")
        return 1
    print("E2E coverage hints present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
