#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the worktree janitor user timer")
    parser.add_argument("--repo", action="append", required=True, help="repository path; repeat for multiple repositories")
    parser.add_argument("--interval", default="15min")
    parser.add_argument("--grace-seconds", type=int, default=3600)
    parser.add_argument("--no-enable", action="store_true")
    args = parser.parse_args()
    if args.grace_seconds < 0:
        parser.error("--grace-seconds must be non-negative")

    skill_root = Path(__file__).resolve().parent.parent
    config_dir = Path.home() / ".config" / "worktree-janitor"
    systemd_dir = Path.home() / ".config" / "systemd" / "user"
    config_dir.mkdir(parents=True, exist_ok=True)
    systemd_dir.mkdir(parents=True, exist_ok=True)

    config = {
        "version": 1,
        "grace_seconds": args.grace_seconds,
        "delete_branch": True,
        "protected_branches": ["main", "master", "archive/*"],
        "repositories": [
            {"path": str(Path(repo).expanduser().resolve()), "base_branch": "main"}
            for repo in args.repo
        ],
    }
    (config_dir / "config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    shutil.copy2(skill_root / "assets" / "worktree-janitor.service", systemd_dir / "worktree-janitor.service")
    timer_text = (skill_root / "assets" / "worktree-janitor.timer").read_text(encoding="utf-8")
    timer_text = timer_text.replace("OnUnitActiveSec=15min", f"OnUnitActiveSec={args.interval}")
    (systemd_dir / "worktree-janitor.timer").write_text(timer_text, encoding="utf-8")

    if not args.no_enable:
        run(["systemctl", "--user", "daemon-reload"])
        run(["systemctl", "--user", "enable", "--now", "worktree-janitor.timer"])
    print(config_dir / "config.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
