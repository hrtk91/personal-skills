"""Offline contract tests: real Git, simulated Herdr/Codex lifecycle."""

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


SKILL = Path(__file__).resolve().parents[1]
GIT = shutil.which("git")

FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path

state_path = Path(os.environ['FAKE_STATE'])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
mode = os.environ.get('FAKE_MODE', 'normal')
name = os.environ['FAKE_NAME']
prefix = os.environ.get('FAKE_PREFIX', '')
work = Path(os.environ['FAKE_WORK'])
def option(flag):
    return args[args.index(flag) + 1]
def save():
    state_path.write_text(json.dumps(state))
def emit(kind, value):
    save()
    print(json.dumps({'result': {kind: value}}))
state['calls'].append(args)
if args[:2] == ['tab', 'create']:
    state['serial'] += 1
    tab = 'tab-' + str(state['serial'])
    pane = 'impl-pane-' + str(state['serial'])
    state['cwd'] = option('--cwd')
    state['tabs'][tab] = True
    save()
    print(json.dumps({'result': {'tab': {'tab_id': tab}, 'root_pane': {'pane_id': pane}}}))
elif args[:2] == ['pane', 'split']:
    emit('pane', {'pane_id': 'rev-pane-' + str(state['serial'])})
elif args[:2] == ['pane', 'rename']:
    emit('type', 'ok')
elif args[:2] == ['pane', 'close']:
    state['closed_panes'].append(args[2])
    emit('type', 'ok')
elif args[:2] == ['tab', 'close']:
    if mode == 'close-fail':
        save(); sys.exit(1)
    state['tabs'][args[2]] = False
    emit('type', 'ok')
elif args[:2] == ['agent', 'get']:
    agent = state['agents'].get(args[2])
    if not agent:
        save(); sys.exit(1)
    if mode == 'slow-marker' and agent.get('waits') == 2 and not agent.get('status_failed'):
        agent['status_failed'] = True
        save(); sys.exit(1)
    emit('agent', agent)
elif args[:2] == ['agent', 'list']:
    emit('agents', [dict(agent, name=key) for key, agent in state['agents'].items()])
elif args[:2] == ['agent', 'start']:
    state['agents'][args[2]] = {'pane_id': option('--pane'), 'agent_status': 'idle', 'interactive_ready': True}
    emit('type', 'agent_started')
elif args[:2] == ['agent', 'read']:
    print('A version-dependent input example')
    save()
elif args[:2] == ['agent', 'prompt']:
    text = args[3]
    agent = state['agents'][args[2]]
    mark = re.search(r'touch (.*?) を実行する', text).group(1)
    agent['mark'] = mark
    state['prompts'].append([args[2], text])
    session = Path(os.environ['CODEX_HOME']) / 'sessions' / 'fixture.jsonl'
    session.parent.mkdir(parents=True, exist_ok=True)
    if mode == 'no-receipt':
        events = [{'type': 'event_msg', 'payload': {'type': 'thread_goal_updated', 'objective': 'another marker'}},
                  {'type': 'event_msg', 'payload': {'type': 'other_event', 'text': text}}]
    else:
        events = [{'type': 'event_msg', 'payload': {'type': 'thread_goal_updated', 'objective': text}}]
    with session.open('a') as stream:
        for event in events:
            stream.write(json.dumps(event, ensure_ascii=False) + '\n')
    stamp = work / ('.sent-' + args[2])
    if stamp.exists():
        tick = max(session.stat().st_mtime_ns, stamp.stat().st_mtime_ns + 1)
        os.utime(session, ns=(tick, tick))
    w = Path(state['cwd'])
    handoff = w / 'handoff'
    if args[2].startswith('impl-'):
        handoff.mkdir(exist_ok=True)
        (handoff / (prefix + name + '-design.md')).write_text('結論: STOP\n' if mode == 'stop' else '結論: そのまま実装\n')
        (handoff / (prefix + name + '-report.md')).write_text('Implementation checked.\n')
        if mode != 'stop':
            (w / 'implementation.txt').write_text('implemented\n')
            (w / 'generated.png').write_text('excluded fixture\n')
            (w / 'saves/portraits').mkdir(parents=True, exist_ok=True)
            (w / 'saves/portraits/generated.json').write_text('{}\n')
    else:
        (handoff / (prefix + name + '-review.md')).write_text('Reviewed independently.\n')
    agent['agent_status'] = 'blocked' if mode == 'blocked' else 'working' if mode == 'slow-marker' else 'done'
    if mode not in ('blocked', 'no-mark', 'no-receipt', 'slow-marker', 'vanished'):
        Path(mark).touch()
    emit('type', 'agent_prompted')
elif args[:2] == ['agent', 'wait']:
    agent = state['agents'][args[2]]
    if mode == 'vanished':
        state['agents'].pop(args[2])
        save(); sys.exit(1)
    agent['waits'] = agent.get('waits', 0) + 1
    if mode == 'slow-marker':
        if agent['waits'] >= 4:
            Path(agent['mark']).touch()
            agent['agent_status'] = 'done'
        save()
        sys.exit(1)  # observation timeout is not completion
    emit('type', 'agent_waited')
else:
    save()
    print('unsupported fake command', args, file=sys.stderr)
    sys.exit(1)
'''


class HerdrContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.work = self.root / "work"
        self.home = self.root / "codex-home"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.name = "contract"
        self.state_path = self.root / "state.json"
        self.state_path.write_text(json.dumps({"serial": 0, "agents": {}, "tabs": {}, "prompts": [], "calls": [], "closed_panes": []}))
        for path, source in {
            self.bin / "herdr": FAKE_HERDR,
            self.bin / "sleep": "#!/bin/sh\nexit 0\n",
            self.bin / "git": "#!/usr/bin/env python3\nimport os,sys\n"
                "if os.environ.get('FAKE_COMMIT_FAIL') == '1' and 'commit' in sys.argv and os.environ['FAKE_W'] in sys.argv:\n    sys.exit(1)\n"
                f"os.execv({GIT!r}, [{GIT!r}] + sys.argv[1:])\n",
        }.items():
            path.write_text(source)
            path.chmod(0o755)
        (self.repo / "baseline.txt").write_text("baseline\n")
        (self.repo / "AGENTS.md").write_text("project context\n")
        (self.repo / "CLAUDE.md").write_text("caller context\n")
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@noreply.invalid", "commit", "-q", "-m", "baseline")
        self.initial_head = self.git("rev-parse", "HEAD").strip()
        self.git("branch", "codex/existing")
        self.prefix = ""
        self.config = {"HERDR_WORK": str(self.work)}
        self.prepare_request()
        self.env = os.environ.copy()
        for key in list(self.env):
            if key.startswith(("CODEX_", "HERDR_", "PI_")) or key in {
                "MODEL", "TIER", "EFFORT", "REPO", "HANDOFF", "RULES", "CONTEXT_FILES", "CHECKLIST", "DESIGN_RULES",
                "TASK_PREFIX", "BRANCH_PREFIX", "WORK_NAME", "EXTRA", "EXTRA_DIRS", "BASE_REFRESH_EXTRA_DIRS", "PATCH_EXCLUDE", "BASE", "RESUME", "SKIP_IMPL",
                "COMMIT_DIRTY", "COMMIT_NAME", "COMMIT_EMAIL", "DIRTY_COMMIT_NAME", "DIRTY_COMMIT_EMAIL", "AGENT", "IMPL_AGENT", "REV_AGENT",
            }:
                self.env.pop(key)
        self.env.update({"PATH": str(self.bin) + os.pathsep + self.env["PATH"], "HERDR_WORKSPACE_ID": "test-workspace",
            "CODEX_HOME": str(self.home), "FAKE_STATE": str(self.state_path), "FAKE_NAME": self.name,
            "FAKE_WORK": str(self.work), "FAKE_W": str(self.w)})

    @property
    def w(self):
        return self.work / "wt" / self.name

    def git(self, *args, cwd=None):
        return subprocess.check_output([GIT, "-C", str(cwd or self.repo), *args], text=True, stderr=subprocess.STDOUT)

    def state(self):
        return json.loads(self.state_path.read_text())

    def prepare_request(self):
        (self.repo / "handoff").mkdir(exist_ok=True)
        (self.repo / "handoff" / (self.prefix + self.name + ".md")).write_text("Dummy task\n")

    def run_script(self, mode="normal", **extra):
        (self.repo / ".herdr.env").write_text("".join(f"{k}={shlex.quote(v)}\n" for k, v in self.config.items()))
        env = self.env | {"FAKE_MODE": mode, "FAKE_PREFIX": self.prefix} | extra
        result = subprocess.run(["bash", str(SKILL / "herdr-run.sh"), self.name], cwd=self.repo, env=env,
            stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=30)
        self.last_result = result
        return result

    def marker(self):
        return (self.work / ("reviewed-" + self.name)).read_text().strip()

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.marker(), "reviewed")
        self.assertFalse(any(self.state()["tabs"].values()))
        self.assertFalse(list(self.work.glob("done-*")))

    def starts(self):
        return [call for call in self.state()["calls"] if call[:2] == ["agent", "start"]]

    def test_default_model_author_branch_and_pipeline(self):
        self.assert_success(self.run_script())
        self.assertEqual(len(self.starts()), 2)
        for start in self.starts():
            self.assertIn("gpt-6.1-sol", start)
            self.assertIn('service_tier="default"', start)
            self.assertIn("model_reasoning_effort=max", start)
            self.assertIn(f'projects."{self.repo}".trust_level="trusted"', start)
        self.assertEqual(self.git("branch", "--show-current", cwd=self.w).strip(), "herdr/contract")
        self.assertEqual(self.git("log", "-1", "--format=%an <%ae>", cwd=self.w).strip(), "Codex <codex@noreply.invalid>")
        self.assertEqual(self.git("rev-parse", "codex/existing").strip(), self.initial_head)
        self.assertTrue((self.w / "handoff/contract-review.md").is_file())
        self.assertEqual(len(self.state()["prompts"]), 2)

    def test_rogue_style_configuration_and_patch_exclusions(self):
        self.prefix = "codex-example-"
        self.prepare_request()
        self.config.update({"TASK_PREFIX": self.prefix, "BRANCH_PREFIX": "codex", "WORK_NAME": "example-codex",
            "RULES": "handoff/evidence.md handoff/design-first.md", "DESIGN_RULES": "handoff/design-first.md",
            "EXTRA_DIRS": "saves/portraits", "EXTRA": "reference.txt", "PATCH_EXCLUDE": ":!*.png :!saves",
            "COMMIT_NAME": "Example", "COMMIT_EMAIL": "example@noreply.invalid"})
        (self.repo / "handoff/evidence.md").write_text("evidence\n")
        (self.repo / "handoff/design-first.md").write_text("project design conclusions\n")
        (self.repo / "saves/portraits").mkdir(parents=True)
        (self.repo / "saves/portraits/index.json").write_text("original\n")
        (self.repo / "reference.txt").write_text("read only\n")
        self.assert_success(self.run_script())
        tracked = self.git("ls-files", cwd=self.w).splitlines()
        patch = (self.work / "patch-contract.diff").read_text()
        self.assertNotIn("reference.txt", tracked)
        self.assertFalse(any(path.endswith(".png") or path.startswith("saves/") for path in tracked))
        self.assertNotIn("generated.png", patch)
        self.assertNotIn("reference.txt", patch)
        self.assertEqual((self.repo / "saves/portraits/index.json").read_text(), "original\n")
        self.assertEqual((self.w / "reference.txt").stat().st_mode & 0o222, 0)
        self.assertTrue((self.w / "handoff/codex-example-contract-review.md").is_file())
        self.assertEqual(self.git("branch", "--show-current", cwd=self.w).strip(), "codex/contract")
        self.assertEqual(self.git("log", "-1", "--format=%an <%ae>", cwd=self.w).strip(), "Example <example@noreply.invalid>")
        impl_text = self.state()["prompts"][0][1]
        self.assertIn("handoff/design-first.md の手順と結論の書式に従う", impl_text)
        self.assertNotIn("10 行程度", impl_text)

    def test_ignored_extra_and_excluded_paths_do_not_fail_staging(self):
        (self.repo / ".gitignore").write_text("saves/\nreference.txt\n")
        self.config.update({"EXTRA": "reference.txt", "PATCH_EXCLUDE": ":!*.png :!saves"})
        (self.repo / "reference.txt").write_text("ignored reference\n")
        self.assert_success(self.run_script())

    def test_role_overrides_and_explicit_astra_are_allowed(self):
        self.assert_success(self.run_script(CODEX_MODEL="gpt-6-astra", CODEX_TIER="priority", CODEX_EFFORT="high",
            CODEX_REV_MODEL="gpt-6.1-sol", CODEX_REV_TIER="default", CODEX_REV_EFFORT="max"))
        impl, rev = self.starts()
        self.assertIn("gpt-6-astra", impl)
        self.assertIn('service_tier="priority"', impl)
        self.assertIn("model_reasoning_effort=high", impl)
        self.assertIn("gpt-6.1-sol", rev)
        self.assertIn('service_tier="default"', rev)
        self.assertIn("model_reasoning_effort=max", rev)

    def test_legacy_model_names_are_inherited_by_review(self):
        self.assert_success(self.run_script(MODEL="gpt-6-astra", TIER="default", EFFORT="high"))
        for start in self.starts():
            self.assertIn("gpt-6-astra", start)
            self.assertIn("model_reasoning_effort=high", start)

    def test_codex_settings_override_legacy_names(self):
        self.assert_success(self.run_script(MODEL="legacy-model", TIER="priority", EFFORT="low",
            CODEX_MODEL="gpt-6.1-sol", CODEX_TIER="default", CODEX_EFFORT="max"))
        for start in self.starts():
            self.assertIn("gpt-6.1-sol", start)
            self.assertNotIn("legacy-model", start)
            self.assertIn('service_tier="default"', start)
            self.assertIn("model_reasoning_effort=max", start)

    def test_codex_home_is_forwarded_to_both_panes(self):
        self.assert_success(self.run_script())
        creates = [call for call in self.state()["calls"] if call[:2] in (["tab", "create"], ["pane", "split"])]
        self.assertEqual(len(creates), 2)
        for call in creates:
            self.assertIn("CODEX_HOME=" + str(self.home), call)
            self.assertIn("--no-focus", call)

    def test_legacy_work_directory_is_supported(self):
        self.config.pop("HERDR_WORK")
        self.assert_success(self.run_script(CODEX_WORK=str(self.work)))

    def test_pi_has_no_astra_restriction(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", PI_MODEL="gpt-6-astra"))
        self.assertIn("gpt-6-astra", self.starts()[0])
        self.assertIn("pi", self.starts()[0])
        self.assertIn("gpt-6.1-sol", self.starts()[1])

    def test_stop_does_not_start_review_or_close_tab(self):
        result = self.run_script(mode="stop")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.marker(), "stopped")
        self.assertEqual(len(self.starts()), 1)
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_blocked_leaves_tab_and_returns_two(self):
        result = self.run_script(mode="blocked")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.marker(), "blocked")
        self.assertEqual(len(self.starts()), 1)
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_done_without_marker_retries_and_fails(self):
        result = self.run_script(mode="no-mark")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual(len(self.state()["prompts"]), 3)
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_goal_must_contain_marker_in_the_goal_event(self):
        result = self.run_script(mode="no-receipt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual(len(self.state()["prompts"]), 3)
        self.assertEqual(len(self.starts()), 1)

    def test_observation_timeout_and_transient_status_failure_keep_same_goal(self):
        self.assert_success(self.run_script(mode="slow-marker"))
        self.assertEqual(len(self.state()["prompts"]), 2)  # one per role, no resubmission
        self.assertEqual(len(self.starts()), 2)

    def test_resume_keeps_existing_agent_and_tab(self):
        self.run_script(mode="blocked")
        state = self.state()
        state["agents"]["impl-contract"]["agent_status"] = "done"
        self.state_path.write_text(json.dumps(state))
        (self.work / "done-impl-contract").touch()
        self.assert_success(self.run_script(RESUME="1"))
        self.assertEqual(self.state()["serial"], 1)
        self.assertEqual(len(self.starts()), 2)
        self.assertEqual(len(self.state()["prompts"]), 2)

    def test_confirmed_missing_agent_fails_instead_of_waiting_forever(self):
        result = self.run_script(mode="vanished")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual(len(self.starts()), 1)
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_newtab_with_skip_impl_keeps_work(self):
        self.run_script(mode="blocked")
        state = self.state()
        state["agents"] = {}
        state["tabs"] = {}
        self.state_path.write_text(json.dumps(state))
        (self.w / "keep.txt").write_text("keep\n")
        self.assert_success(self.run_script(RESUME="newtab", SKIP_IMPL="1"))
        self.assertEqual((self.w / "keep.txt").read_text(), "keep\n")
        self.assertEqual(self.state()["serial"], 2)
        self.assertEqual(len(self.state()["prompts"]), 2)

    def test_base_from_worktree_does_not_share_git_index(self):
        base = self.root / "base"
        self.git("worktree", "add", "-q", "-b", "base-task", str(base))
        (base / "baseline.txt").write_text("base uncommitted\n")
        (base / "untracked.txt").write_text("untracked\n")
        index = Path(self.git("rev-parse", "--path-format=absolute", "--git-path", "index", cwd=base).strip())
        before = index.read_bytes()
        self.assert_success(self.run_script(BASE=str(base)))
        self.assertEqual(index.read_bytes(), before)
        self.assertEqual((base / "baseline.txt").read_text(), "base uncommitted\n")
        self.assertEqual((self.w / "untracked.txt").read_text(), "untracked\n")
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=self.w).strip(), self.initial_head)
        self.assertTrue((self.w / ".git").is_dir())
        self.assertIn("base uncommitted", (self.work / "patch-contract.diff").read_text())

    def assert_base_inventory(self, refresh, expected):
        base = self.root / "base"
        self.git("worktree", "add", "-q", "-b", "base-task", str(base))
        for location, value in ((base, "previous"), (self.repo, "current")):
            (location / "catalog").mkdir()
            (location / "catalog/inventory.txt").write_text(value)
        self.config["EXTRA_DIRS"] = "catalog"
        if refresh is not None:
            self.config["BASE_REFRESH_EXTRA_DIRS"] = refresh
        self.assert_success(self.run_script(BASE=str(base)))
        self.assertEqual((self.w / "catalog/inventory.txt").read_text(), expected)
        self.assertEqual((base / "catalog/inventory.txt").read_text(), "previous")

    def test_base_extra_dirs_can_preserve_previous_inventory(self):
        self.assert_base_inventory("0", "previous")

    def test_base_extra_dirs_refresh_by_default(self):
        self.assert_base_inventory(None, "current")

    def test_base_read_only_extra_can_be_refreshed(self):
        base = self.root / "base"
        self.git("worktree", "add", "-q", "-b", "base-task", str(base))
        (base / "reference.txt").write_text("previous reference")
        (base / "reference.txt").chmod(0o444)
        (self.repo / "reference.txt").write_text("current reference")
        self.config["EXTRA"] = "reference.txt"
        self.assert_success(self.run_script(BASE=str(base)))
        self.assertEqual((self.w / "reference.txt").read_text(), "current reference")
        self.assertEqual((self.w / "reference.txt").stat().st_mode & 0o222, 0)
        self.assertEqual((base / "reference.txt").read_text(), "previous reference")

    def test_existing_work_directory_is_not_deleted(self):
        self.w.mkdir(parents=True)
        (self.w / "keep.txt").write_text("keep\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual((self.w / "keep.txt").read_text(), "keep\n")
        self.assertEqual(self.state()["serial"], 0)

    def test_dirty_work_is_excluded_by_default(self):
        (self.repo / "baseline.txt").write_text("dirty\n")
        self.assert_success(self.run_script())
        self.assertEqual((self.repo / "baseline.txt").read_text(), "dirty\n")
        self.assertEqual((self.w / "baseline.txt").read_text(), "baseline\n")
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.initial_head)

    def test_commit_dirty_is_opt_in_with_separate_author(self):
        (self.repo / "baseline.txt").write_text("dirty\n")
        self.assert_success(self.run_script(COMMIT_DIRTY="1"))
        self.assertEqual((self.w / "baseline.txt").read_text(), "dirty\n")
        self.assertEqual(self.git("log", "-1", "--format=%an <%ae>").strip(), "Claude <claude@noreply.invalid>")

    def test_commit_failure_cannot_claim_reviewed(self):
        result = self.run_script(FAKE_COMMIT_FAIL="1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_tab_close_failure_cannot_claim_reviewed(self):
        result = self.run_script(mode="close-fail")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_existing_branch_is_not_reset(self):
        self.git("branch", "herdr/contract")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual(self.git("rev-parse", "herdr/contract").strip(), self.initial_head)
        self.assertEqual(self.state()["serial"], 0)

    def test_agent_on_another_pane_is_untouched(self):
        state = self.state()
        state["agents"]["impl-contract"] = {"pane_id": "unrelated-pane", "agent_status": "working"}
        self.state_path.write_text(json.dumps(state))
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual(self.state()["agents"]["impl-contract"]["pane_id"], "unrelated-pane")
        self.assertEqual(len(self.state()["prompts"]), 0)


if __name__ == "__main__":
    unittest.main()
