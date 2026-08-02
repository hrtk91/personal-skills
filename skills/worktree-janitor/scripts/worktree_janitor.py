#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Worktree:
    path: Path
    head: str
    branch: str | None


@dataclass(frozen=True)
class PullRequest:
    number: int
    head_oid: str
    merged_at: str


class CommandError(RuntimeError):
    pass


def run(command: list[str], *, cwd: Path | None = None, allow_failure: bool = False) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0 and not allow_failure:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise CommandError(f"command failed ({completed.returncode}): {' '.join(command)}: {detail}")
    return completed.stdout


def emit(**event: Any) -> None:
    print(json.dumps(event, ensure_ascii=False, sort_keys=True), flush=True)


def load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def save_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_worktrees(porcelain: str) -> list[Worktree]:
    result: list[Worktree] = []
    record: dict[str, str] = {}
    for line in [*porcelain.splitlines(), ""]:
        if line:
            key, _, value = line.partition(" ")
            record[key] = value
            continue
        if record.get("worktree") and record.get("HEAD"):
            branch_ref = record.get("branch")
            branch = branch_ref.removeprefix("refs/heads/") if branch_ref else None
            result.append(Worktree(Path(record["worktree"]).resolve(), record["HEAD"], branch))
        record = {}
    return result


def remote_slug(repo: Path) -> str:
    url = run(["git", "remote", "get-url", "origin"], cwd=repo).strip()
    if url.startswith("git@github.com:"):
        slug = url.removeprefix("git@github.com:")
    elif "github.com/" in url:
        slug = url.split("github.com/", 1)[1]
    else:
        raise ValueError(f"origin is not a GitHub remote: {url}")
    return slug.removesuffix(".git").strip("/")


def merged_pr(gh: str, slug: str, branch: str, base_branch: str) -> PullRequest | None:
    raw = run(
        [
            gh,
            "pr",
            "list",
            "--repo",
            slug,
            "--state",
            "all",
            "--head",
            branch,
            "--json",
            "number,mergedAt,headRefOid,baseRefName",
        ]
    )
    try:
        rows = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid gh JSON for {branch}: {exc}") from exc
    if not isinstance(rows, list):
        raise ValueError(f"gh JSON must be a list for {branch}")
    merged = [
        row
        for row in rows
        if isinstance(row, dict)
        and row.get("mergedAt")
        and row.get("baseRefName") == base_branch
        and row.get("headRefOid")
    ]
    if not merged:
        return None
    row = max(merged, key=lambda item: str(item["mergedAt"]))
    return PullRequest(int(row["number"]), str(row["headRefOid"]), str(row["mergedAt"]))


def is_clean(worktree: Path) -> bool:
    return not run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=worktree).strip()


def is_protected(branch: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(branch, pattern) for pattern in patterns)


def path_is_in_use(path: Path, proc_root: Path) -> bool:
    if not proc_root.is_dir():
        return True
    for process in proc_root.iterdir():
        if not process.name.isdigit():
            continue
        try:
            cwd = (process / "cwd").resolve(strict=True)
        except (FileNotFoundError, PermissionError, OSError):
            continue
        if cwd == path or path in cwd.parents:
            return True
    return False


def candidate_key(repo: Path, worktree: Path) -> str:
    return f"{repo.resolve()}::{worktree.resolve()}"


def signature(head: str, branch: str, pr: PullRequest) -> str:
    return f"{head}:{branch}:{pr.number}:{pr.head_oid}"


def classify(
    repo: Path,
    base_branch: str,
    worktree: Worktree,
    protected: list[str],
    gh: str,
    proc_root: Path,
) -> tuple[str, PullRequest | None]:
    if worktree.branch is None:
        return "detached", None
    if worktree.branch == base_branch or is_protected(worktree.branch, protected):
        return "protected_branch", None
    if (worktree.path / ".keep-worktree").exists():
        return "keep_marker", None
    if not worktree.path.is_dir():
        return "missing_path", None
    if not is_clean(worktree.path):
        return "dirty", None
    if path_is_in_use(worktree.path, proc_root):
        return "active_process", None
    pr = merged_pr(gh, remote_slug(repo), worktree.branch, base_branch)
    if pr is None:
        return "no_merged_pr", None
    if pr.head_oid != worktree.head:
        return "head_mismatch", pr
    return "eligible", pr


def cleanup(repo: Path, worktree: Worktree, delete_branch: bool, proc_root: Path) -> None:
    current_head = run(["git", "rev-parse", "HEAD"], cwd=worktree.path).strip()
    if current_head != worktree.head:
        raise CommandError("worktree HEAD changed before cleanup")
    if not is_clean(worktree.path):
        raise CommandError("worktree became dirty before cleanup")
    if path_is_in_use(worktree.path, proc_root):
        raise CommandError("worktree became active before cleanup")
    run(["git", "worktree", "remove", str(worktree.path)], cwd=repo)
    if delete_branch and worktree.branch:
        branch_head = run(
            ["git", "rev-parse", "--verify", f"refs/heads/{worktree.branch}"],
            cwd=repo,
            allow_failure=True,
        ).strip()
        if branch_head == worktree.head:
            run(["git", "branch", "-D", worktree.branch], cwd=repo)
        elif branch_head:
            emit(
                repo=str(repo),
                branch=worktree.branch,
                action="preserve_branch",
                reason="branch_changed_before_delete",
            )


def validate_config(config: dict[str, Any]) -> None:
    if config.get("version") != 1:
        raise ValueError("config.version must be 1")
    if not isinstance(config.get("repositories"), list) or not config["repositories"]:
        raise ValueError("config.repositories must be a non-empty list")
    if not isinstance(config.get("grace_seconds", 3600), (int, float)) or config.get("grace_seconds", 3600) < 0:
        raise ValueError("config.grace_seconds must be non-negative")
    if not isinstance(config.get("protected_branches", []), list):
        raise ValueError("config.protected_branches must be a list")


def process_repository(
    entry: dict[str, Any],
    config: dict[str, Any],
    candidates: dict[str, Any],
    *,
    execute: bool,
    now: float,
    gh: str,
    proc_root: Path,
) -> None:
    repo = Path(str(entry["path"])).expanduser().resolve()
    base_branch = str(entry.get("base_branch", "main"))
    registered = parse_worktrees(run(["git", "worktree", "list", "--porcelain"], cwd=repo))
    root = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=repo).strip()).resolve()
    for worktree in registered:
        key = candidate_key(repo, worktree.path)
        if worktree.path == root:
            candidates.pop(key, None)
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="preserve", reason="primary_worktree")
            continue
        try:
            reason, pr = classify(
                repo,
                base_branch,
                worktree,
                [str(value) for value in config.get("protected_branches", [])],
                gh,
                proc_root,
            )
        except (CommandError, OSError, ValueError) as exc:
            candidates.pop(key, None)
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="preserve", reason="external_error", detail=str(exc))
            continue
        if reason != "eligible" or pr is None:
            candidates.pop(key, None)
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="preserve", reason=reason)
            continue
        current_signature = signature(worktree.head, worktree.branch or "", pr)
        previous = candidates.get(key)
        grace = float(config.get("grace_seconds", 3600))
        if not execute:
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="would_mark_candidate", reason="eligible", pr=pr.number)
            continue
        if not isinstance(previous, dict) or previous.get("signature") != current_signature:
            candidates[key] = {"signature": current_signature, "first_observed_at": now}
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="mark_candidate", reason="eligible", pr=pr.number)
            continue
        first_observed = float(previous.get("first_observed_at", now))
        if now - first_observed < grace:
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="wait", reason="grace_period", pr=pr.number, remaining_seconds=max(0, grace - (now - first_observed)))
            continue
        try:
            cleanup(repo, worktree, bool(config.get("delete_branch", True)), proc_root)
        except (CommandError, OSError) as exc:
            emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="preserve", reason="cleanup_failed", detail=str(exc))
            continue
        candidates.pop(key, None)
        emit(repo=str(repo), worktree=str(worktree.path), branch=worktree.branch, action="cleaned", reason="merged_and_inactive", pr=pr.number)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Safely clean merged Git worktrees")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--now", type=float, default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        config = load_json(args.config.expanduser(), {})
        validate_config(config)
        state = load_json(args.state.expanduser(), {"version": 1, "candidates": {}})
        candidates = state.setdefault("candidates", {})
        if not isinstance(candidates, dict):
            raise ValueError("state.candidates must be an object")
        gh = os.environ.get("WORKTREE_JANITOR_GH", "gh")
        proc_root = Path(os.environ.get("WORKTREE_JANITOR_PROC_ROOT", "/proc"))
        now = args.now if args.now is not None else time.time()
        for entry in config["repositories"]:
            if not isinstance(entry, dict) or "path" not in entry:
                raise ValueError("each repository must contain path")
            try:
                process_repository(entry, config, candidates, execute=args.execute, now=now, gh=gh, proc_root=proc_root)
            except (CommandError, OSError, ValueError) as exc:
                emit(repo=str(entry.get("path", "")), action="preserve", reason="repository_error", detail=str(exc))
        if args.execute:
            state["version"] = 1
            save_json(args.state.expanduser(), state)
        return 0
    except (OSError, ValueError) as exc:
        emit(action="failed", reason="invalid_configuration", detail=str(exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
