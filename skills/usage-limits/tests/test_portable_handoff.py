import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"

HERDR_STUB = r"""import json, os, re, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['FAKE_HERDR_LOG']).open('a') as stream:
    stream.write(json.dumps(args) + '\n')
if args[:2] == ['agent', 'get']:
    sys.exit(0 if os.environ.get('FAKE_EXISTING') == '1' else 1)
elif args[:2] == ['tab', 'create']:
    print(json.dumps({'result': {'root_pane': {'pane_id': 'test-pane'}}}))
elif args[:2] == ['agent', 'start']:
    print('{}')
elif args[:2] == ['agent', 'read']:
    print('loading' if os.environ.get('FAKE_NOT_READY') == '1' else 'Ask Codex')
elif args[:2] == ['agent', 'prompt']:
    prompt = args[3]
    nonce = re.search(r'引継ぎID:([a-f0-9]+)', prompt).group(1)
    path = Path(os.environ['LIMITS_CODEX_SESSIONS']) / 'receipt.jsonl'
    if os.environ.get('FAKE_UNRELATED') == '1':
        records = [
            {'type': 'event_msg', 'payload': {'type': 'thread_goal_updated', 'goal': {
                'objective': 'old request for ' + os.environ['HANDOFF_FILE']}}},
            {'type': 'response_item', 'payload': {'type': 'thread_goal_updated', 'goal': {
                'objective': prompt}}}
        ]
    else:
        records = [{'type': 'event_msg', 'payload': {'type': 'thread_goal_updated', 'goal': {
            'objective': prompt}}}]
    with path.open('a') as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False) + '\n')
else:
    sys.exit('unexpected mock command')
"""


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / "project with spaces"
        self.project.mkdir()
        self.handoff = self.project / "supervisor instructions.md"
        self.handoff.write_text("# Example project\nRead the project state and stop at the stated completion condition.\n")
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()
        self.log = self.root / "mock-calls.jsonl"
        binary = self.root / "bin"
        binary.mkdir()
        (binary / "herdr").write_text("#!" + sys.executable + "\n" + HERDR_STUB)
        (binary / "herdr").chmod(0o755)
        self.env = dict(os.environ, REPO=str(self.project), HANDOFF_FILE=str(self.handoff),
                        HERDR_WORKSPACE_ID="test-workspace", LIMITS_SUPERVISOR_NAME="test-supervisor",
                        LIMITS_CODEX_SESSIONS=str(self.sessions), FAKE_HERDR_LOG=str(self.log),
                        LIMITS_HANDOFF_READY_SECONDS="1", LIMITS_HANDOFF_CONFIRM_SECONDS="1",
                        LIMITS_HANDOFF_SETTLE_SECONDS="0", TMPDIR=str(self.root),
                        PATH=str(binary) + os.pathsep + os.environ["PATH"])

    def run_handoff(self, *args, **env):
        return subprocess.run(["bash", str(SCRIPTS / "handoff.sh"), *args],
                              env=dict(self.env, **env), text=True, capture_output=True, timeout=12)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_dry_run_does_not_connect_start_send_or_create_files(self):
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))
        result = self.run_handoff("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("gpt-6.1-sol", result.stdout)
        self.assertIn(str(self.handoff), result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertEqual(sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*')), before)

    def test_missing_project_and_unfilled_template_do_not_launch(self):
        result = self.run_handoff(REPO="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])
        self.handoff.write_text("# {{PROJECT_NAME}}\n{{OBJECTIVE_AND_DONE_CONDITION}}\n")
        result = self.run_handoff()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_existing_agent_does_not_start_or_receive_a_second_request(self):
        result = self.run_handoff(FAKE_EXISTING="1")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.calls(), [["agent", "get", "test-supervisor"]])

    def test_receipt_of_this_goal_is_required_and_launch_arguments_are_configurable(self):
        result = self.run_handoff(LIMITS_SUPERVISOR_MODEL="example-model", LIMITS_SUPERVISOR_EFFORT="high")
        self.assertEqual(result.returncode, 0, result.stderr)
        start = next(call for call in self.calls() if call[:2] == ["agent", "start"])
        self.assertEqual(start[start.index("-m") + 1], "example-model")
        self.assertIn("model_reasoning_effort=high", start)
        self.assertEqual(start[start.index("-C") + 1], str(self.project))
        prompts = [call[3] for call in self.calls() if call[:2] == ["agent", "prompt"]]
        self.assertEqual(len(prompts), 1)
        self.assertIn(str(self.handoff), prompts[0])
        self.assertIn("引継ぎID:", prompts[0])
        self.assertIn("受信確認", result.stdout)
        self.assertFalse(list(self.root.glob("usage-limits-handoff.*")))

    def test_quoted_instruction_filename_is_confirmed(self):
        quoted = self.project / 'instructions "quoted".md'
        self.handoff.rename(quoted)
        result = self.run_handoff(HANDOFF_FILE=str(quoted))
        self.assertEqual(result.returncode, 0, result.stderr)
        prompts = [call[3] for call in self.calls() if call[:2] == ["agent", "prompt"]]
        self.assertIn(json.dumps(str(quoted), ensure_ascii=False), prompts[0])

    def test_old_goal_and_non_event_copy_are_not_accepted_and_retry_is_bounded(self):
        result = self.run_handoff(FAKE_UNRELATED="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        prompts = [call[3] for call in self.calls() if call[:2] == ["agent", "prompt"]]
        self.assertEqual(len(prompts), 3)
        self.assertEqual(len(set(prompts)), 1)
        self.assertEqual(sum(call[:2] == ["agent", "start"] for call in self.calls()), 1)
        self.assertFalse(any(call[:2] in (["agent", "stop"], ["agent", "close"]) for call in self.calls()))
        self.assertFalse(list(self.root.glob("usage-limits-handoff.*")))

    def test_readiness_timeout_does_not_send_or_stop_the_agent(self):
        result = self.run_handoff(FAKE_NOT_READY="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(any(call[:2] == ["agent", "prompt"] for call in self.calls()))
        self.assertFalse(any(call[:2] in (["agent", "stop"], ["agent", "close"]) for call in self.calls()))


class SnapshotExampleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        readme = (SKILL / "README.md").read_text()
        self.snippet = readme.split("```js\n", 1)[1].split("```", 1)[0]
        self.input = {"rate_limits": {"five_hour": {"used_percentage": 97, "resets_at": 2000000000},
                                      "seven_day": {"used_percentage": 20, "resets_at": 2000000000}}}

    def render(self, env):
        code = "const input = " + json.dumps(self.input) + ";\n" + self.snippet + '\nconsole.log("visible status");\n'
        return subprocess.run(["node", "--input-type=module", "-e", code],
                              env=env, text=True, capture_output=True, timeout=5)

    def test_statusline_example_and_reader_agree_on_xdg_state_path(self):
        env = dict(os.environ, XDG_STATE_HOME=str(self.root))
        env.pop("LIMITS_CLAUDE_SNAPSHOT", None)
        rendered = self.render(env)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        self.assertEqual(rendered.stdout, "visible status\n")
        snapshot = self.root / "limits" / "claude.json"
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        read = subprocess.run([sys.executable, str(SCRIPTS / "limits.py"), "claude", "--json"],
                              env=env, text=True, capture_output=True, timeout=5)
        self.assertEqual(read.returncode, 0, read.stderr)
        self.assertEqual(json.loads(read.stdout)["remaining_percent"], 3)

    def test_statusline_write_failure_preserves_visible_output(self):
        blocker = self.root / "not-a-directory"
        blocker.write_text("keep")
        env = dict(os.environ, LIMITS_CLAUDE_SNAPSHOT=str(blocker / "claude.json"))
        rendered = self.render(env)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        self.assertEqual(rendered.stdout, "visible status\n")
        self.assertEqual(blocker.read_text(), "keep")

    def test_cli_uses_explicit_inputs_without_touching_real_configuration(self):
        snapshot = self.root / "snapshot.json"
        env = dict(os.environ, LIMITS_CLAUDE_SNAPSHOT=str(snapshot), LIMITS_CODEX_SESSIONS=str(self.root / "sessions"))
        missing = subprocess.run([sys.executable, str(SCRIPTS / "limits.py"), "check", "--json"],
                                 env=env, text=True, capture_output=True, timeout=5)
        self.assertEqual(missing.returncode, 3)
        self.assertEqual(json.loads(missing.stdout)["state"], "UNKNOWN")
        self.assertFalse(snapshot.exists())
        rendered = self.render(env)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        low = subprocess.run([sys.executable, str(SCRIPTS / "limits.py"), "check", "--json"],
                             env=env, text=True, capture_output=True, timeout=5)
        self.assertEqual(low.returncode, 2, low.stderr)
        result = json.loads(low.stdout)
        self.assertEqual(result["state"], "HANDOFF")
        self.assertFalse(result["codex"]["known"])


if __name__ == "__main__":
    unittest.main()
