from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("worktree_janitor.py")


def command(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


class JanitorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "repo"
        self.worktree = self.root / "worktree"
        self.proc = self.root / "proc"
        self.proc.mkdir()
        command(["git", "init", "--bare", str(self.remote)], self.root)
        command(["git", "clone", str(self.remote), str(self.repo)], self.root)
        command(["git", "config", "user.name", "Test"], self.repo)
        command(["git", "config", "user.email", "test@example.com"], self.repo)
        (self.repo / "README.md").write_text("base\n", encoding="utf-8")
        command(["git", "add", "README.md"], self.repo)
        command(["git", "commit", "-m", "base"], self.repo)
        command(["git", "branch", "-M", "main"], self.repo)
        command(["git", "push", "-u", "origin", "main"], self.repo)
        command(["git", "worktree", "add", "-b", "feat/done", str(self.worktree), "main"], self.repo)
        (self.worktree / "done.txt").write_text("done\n", encoding="utf-8")
        command(["git", "add", "done.txt"], self.worktree)
        command(["git", "commit", "-m", "done"], self.worktree)
        self.head = command(["git", "rev-parse", "HEAD"], self.worktree).stdout.strip()
        command(["git", "remote", "set-url", "origin", "git@github.com:example/repo.git"], self.repo)
        self.config = self.root / "config.json"
        self.state = self.root / "state.json"
        self.gh = self.root / "gh"
        self.write_config(grace=10)
        self.write_gh(merged=True, head=self.head)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_config(self, grace: int) -> None:
        self.config.write_text(
            json.dumps(
                {
                    "version": 1,
                    "grace_seconds": grace,
                    "delete_branch": True,
                    "protected_branches": ["main", "archive/*"],
                    "repositories": [{"path": str(self.repo), "base_branch": "main"}],
                }
            ),
            encoding="utf-8",
        )

    def write_gh(self, *, merged: bool, head: str) -> None:
        rows = [
            {
                "number": 1,
                "mergedAt": "2026-01-01T00:00:00Z" if merged else None,
                "headRefOid": head,
                "baseRefName": "main",
            }
        ]
        self.gh.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps(rows) + "'\n", encoding="utf-8")
        self.gh.chmod(0o755)

    def run_janitor(self, now: int, execute: bool = True) -> list[dict[str, object]]:
        env = os.environ.copy()
        env["WORKTREE_JANITOR_GH"] = str(self.gh)
        env["WORKTREE_JANITOR_PROC_ROOT"] = str(self.proc)
        args = [sys.executable, str(SCRIPT), "--config", str(self.config), "--state", str(self.state), "--now", str(now)]
        if execute:
            args.append("--execute")
        result = command(args, self.root, env)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def worktree_registered(self) -> bool:
        return str(self.worktree) in command(["git", "worktree", "list", "--porcelain"], self.repo).stdout

    def test_clean_merged_worktree_is_removed_after_unchanged_grace_period(self) -> None:
        first = self.run_janitor(100)
        self.assertIn("mark_candidate", [row["action"] for row in first])
        self.assertTrue(self.worktree_registered())
        second = self.run_janitor(111)
        self.assertIn("cleaned", [row["action"] for row in second])
        self.assertFalse(self.worktree_registered())
        self.assertNotEqual(command(["git", "show-ref", "--verify", "refs/heads/feat/done"], self.repo).returncode, 0)

    def test_grace_period_preserves_candidate(self) -> None:
        self.run_janitor(100)
        rows = self.run_janitor(105)
        self.assertIn("wait", [row["action"] for row in rows])
        self.assertTrue(self.worktree_registered())

    def test_dirty_worktree_is_preserved(self) -> None:
        (self.worktree / "dirty.txt").write_text("dirty\n", encoding="utf-8")
        rows = self.run_janitor(100)
        self.assertIn("dirty", [row["reason"] for row in rows])
        self.assertTrue(self.worktree_registered())

    def test_keep_marker_preserves_worktree(self) -> None:
        (self.worktree / ".keep-worktree").write_text("keep\n", encoding="utf-8")
        rows = self.run_janitor(100)
        self.assertIn("keep_marker", [row["reason"] for row in rows])

    def test_process_using_worktree_as_cwd_preserves_worktree(self) -> None:
        process = self.proc / "123"
        process.mkdir()
        (process / "cwd").symlink_to(self.worktree, target_is_directory=True)
        rows = self.run_janitor(100)
        self.assertIn("active_process", [row["reason"] for row in rows])
        self.assertTrue(self.worktree_registered())

    def test_open_pr_is_preserved(self) -> None:
        self.write_gh(merged=False, head=self.head)
        rows = self.run_janitor(100)
        self.assertIn("no_merged_pr", [row["reason"] for row in rows])

    def test_head_mismatch_is_preserved(self) -> None:
        self.write_gh(merged=True, head="0" * 40)
        rows = self.run_janitor(100)
        self.assertIn("head_mismatch", [row["reason"] for row in rows])

    def test_external_error_is_preserved(self) -> None:
        self.gh.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        self.gh.chmod(0o755)
        rows = self.run_janitor(100)
        self.assertIn("external_error", [row["reason"] for row in rows])

    def test_dry_run_does_not_write_state(self) -> None:
        rows = self.run_janitor(100, execute=False)
        self.assertIn("would_mark_candidate", [row["action"] for row in rows])
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
