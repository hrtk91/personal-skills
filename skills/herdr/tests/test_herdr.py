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
TASK_BIN = SKILL.parents[1] / "tools/task-ledger/bin/task"
VERIFICATION_RULE = "終わりの条件の確かめは、使う人が実際に通る入口（依頼文に書かれたスクリプト・コマンド・起動の台本）で流し、そのコマンドと出力の要所を貼る。手で組んだ代わりの命令で流したもの、手で作った成果物は「代わりの道」と書き、満たしたとは書かない"

FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, re, sys, subprocess
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
elif args[:2] == ['pane', 'send-text']:
    result = subprocess.run(args[3], shell=True, cwd=state['cwd'], env=os.environ.copy(), text=True, capture_output=True)
    print(result.stdout, end='')
    print(result.stderr, end='', file=sys.stderr)
    with open(os.environ['FAKE_PANE_OUTPUT'], 'a') as stream: stream.write(result.stdout + result.stderr)
    save()
    sys.exit(result.returncode)
elif args[:2] == ['pane', 'send-keys']:
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
    state['agents'][args[2]] = {'pane_id': option('--pane'), 'agent_status': 'idle', 'interactive_ready': True,
        'kind': option('--kind')}
    emit('type', 'agent_started')
elif args[:2] == ['agent', 'read']:
    print('A version-dependent input example')
    save()
elif args[:2] == ['agent', 'prompt']:
    text = args[3]
    agent = state['agents'][args[2]]
    channel_mode = agent.get('kind') == 'pi' and os.environ.get('PI_CHANNEL', '1') != '0' and os.path.isfile(os.environ['PI_CHANNEL_EXT']) and os.path.isfile(os.environ['CHANNEL_BIN'])
    mark_match = re.search(r'touch (.*?) を実行する', text)
    mark = mark_match.group(1) if mark_match else None
    agent['channel_mode'] = channel_mode
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
            (w / 'assets/cache').mkdir(parents=True, exist_ok=True)
            (w / 'assets/cache/generated.json').write_text('{}\n')
    else:
        (handoff / (prefix + name + '-review.md')).write_text('Reviewed independently.\n')
    agent['agent_status'] = 'blocked' if mode == 'blocked' else 'working' if mode == 'slow-marker' else 'done'
    if channel_mode and mode not in ('blocked', 'no-mark', 'no-receipt', 'slow-marker', 'vanished', 'old-finish'):
        channel = Path(os.environ['AGENT_CHANNEL'])
        channel.parent.mkdir(parents=True, exist_ok=True)
        rows = [json.loads(line) for line in channel.read_text().splitlines()] if channel.exists() else []
        row = {'id': str(len(rows) + 1), 'kind': 'finish', 'from': args[2], 'body': 'Fake implementation finished'}
        channel.open('a').write(json.dumps(row) + '\n')
    elif mark and mode not in ('blocked', 'no-mark', 'no-receipt', 'slow-marker', 'vanished'):
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


FAKE_CHANNEL = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(args[args.index('--log') + 1]) if '--log' in args else Path(os.environ['AGENT_CHANNEL'])
args = [x for i, x in enumerate(args) if x != '--log' and (i == 0 or args[i - 1] != '--log')]
rows = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
if args[0] == 'last-id':
    if rows: print(rows[-1]['id'])
elif args[0] == 'supervisor':
    if os.environ.get('FAKE_SUPERVISOR_FAIL') == '1': sys.exit(1)
    supervisor = os.environ.get('FAKE_SUPERVISOR', '')
    if supervisor: print(supervisor)
elif args[0] == 'tail':
    opts = dict(zip(args[1::2], args[2::2]))
    after = opts.get('--after')
    start = next((i + 1 for i, row in enumerate(rows) if row['id'] == after), 0) if after else 0
    for row in rows[start:]:
        if row.get('kind') == opts.get('--kind') and row.get('from') == opts.get('--from'):
            print(json.dumps(row))
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
            self.bin / "systemctl": "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_SYSTEMCTL_CALLS\"\n[ \"${FAKE_SYSTEMCTL_FAIL:-0}\" = 0 ]\n",
            self.bin / "git": "#!/usr/bin/env python3\nimport os,sys,subprocess\nfrom pathlib import Path\n"
                "if os.environ.get('FAKE_COMMIT_FAIL') == '1' and 'commit' in sys.argv and os.environ['FAKE_W'] in sys.argv:\n    sys.exit(1)\n"
                f"result = subprocess.run([{GIT!r}] + sys.argv[1:])\n"
                "if result.returncode == 0 and 'worktree' in sys.argv and 'add' in sys.argv and os.environ.get('FAKE_PREEXISTING_LINK_DIR'):\n"
                "    Path(os.environ['FAKE_W'], os.environ['FAKE_PREEXISTING_LINK_DIR']).mkdir(parents=True, exist_ok=True)\n"
                "    Path(os.environ['FAKE_W'], os.environ['FAKE_PREEXISTING_LINK_DIR'], 'stale.txt').write_text('stale')\n"
                "sys.exit(result.returncode)\n",
        }.items():
            path.write_text(source)
            path.chmod(0o755)
        claude = self.bin / "claude"
        claude.write_text("#!/usr/bin/env python3\nimport json,os,sys,subprocess\nbody=sys.stdin.read()\nopen(os.environ['FAKE_CLAUDE_ARGS'],'w').write(json.dumps(sys.argv[1:]))\nwith open(os.environ['FAKE_CLAUDE_CALLS'],'a') as calls: calls.write(json.dumps({'args':sys.argv[1:],'input':body})+'\\n')\nif os.environ.get('FAKE_CLAUDE_RESUME_FAIL') == '1' and '--resume' in sys.argv: sys.exit(17)\nprint(json.dumps({'type':'system','subtype':'init','session_id':'session-smoke'}), flush=True)\nif os.environ.get('FAKE_CLAUDE_RETRY_DENIAL') == '1':\n counter=os.environ['FAKE_CLAUDE_ARGS']+'.count'; n=int(open(counter).read()) if os.path.exists(counter) else 0; open(counter,'w').write(str(n+1))\n if n == 0: print(json.dumps({'type':'system','subtype':'permission_denied','message':'sandbox blocked write'}), flush=True)\nif os.environ.get('FAKE_CLAUDE_BODY_BUBBLEWRAP') == '1': print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'The word bubblewrap is just in this explanation.'}]}}), flush=True)\nif os.environ.get('FAKE_CLAUDE_TOOL_DENIAL') == '1': print(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','is_error':True,'content':'bwrap: Operation not permitted'}]}}), flush=True)\nif os.environ.get('FAKE_CLAUDE_BASH_JA') == '1': print(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','is_error':False,'content':'mkdir: 作成できません: 読み込み専用ファイルシステムです\\nmkdir_exit=1'}]}}), flush=True)\nprint(json.dumps({'type':'assistant','message':{'content':[{'type':'tool_use','name':'Write','input':{'file':'handoff/report'}}]}}), flush=True)\nprint(json.dumps({'type':'result','subtype':'success','stop_reason':'end_turn','result':'finished'}), flush=True)\nif os.environ.get('FAKE_CLAUDE_HOLD_CHILD') == '1':\n child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n open(os.environ['FAKE_CLAUDE_CHILD_PID'],'w').write(str(child.pid))\n if os.environ.get('FAKE_CLAUDE_HOLD_PARENT') == '1':\n  import time; time.sleep(60)\nname=os.environ['FAKE_NAME']; os.makedirs('handoff',exist_ok=True)\nif os.environ.get('FAKE_CLAUDE_RETRY_DENIAL') != '1' or n != 0: open('handoff/'+name+'-report.md','w').write('done\\n')\n" )
        claude.chmod(0o755)
        self.claude_args = self.root / "claude-args.json"
        self.channel_bin = self.bin / "channel"
        self.channel_bin.write_text(FAKE_CHANNEL)
        self.channel_bin.chmod(0o755)
        self.channel_ext = self.root / "channel-extension.ts"
        self.channel_ext.write_text("export function createChannelExtension() {}\n")
        self.channel_log = self.root / "channel.jsonl"
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
                "TASK_PREFIX", "BRANCH_PREFIX", "WORK_NAME", "EXTRA", "EXTRA_DIRS", "LINK_DIRS", "BASE_REFRESH_EXTRA_DIRS", "PATCH_EXCLUDE", "BASE", "RESUME", "SKIP_IMPL",
                "COMMIT_DIRTY", "COMMIT_NAME", "COMMIT_EMAIL", "DIRTY_COMMIT_NAME", "DIRTY_COMMIT_EMAIL", "AGENT", "IMPL_AGENT", "REV_AGENT", "SEND_BACK_BRIEF_REFRESHED",
                # The parent Herdr session may carry a live TASK_ID / DB path. These offline contract tests
                # must never mutate a caller's task ledger while exercising the fake harness.
                "TASK_ID", "TASK_ISSUE_ID", "TASK_LEDGER_DB", "TASK_KICK", "TASK_RUN_AFTER",
            }:
                self.env.pop(key)
        self.env.update({"PATH": str(self.bin) + os.pathsep + self.env["PATH"], "HERDR_WORKSPACE_ID": "test-workspace",
            "CODEX_HOME": str(self.home), "FAKE_STATE": str(self.state_path), "FAKE_SYSTEMCTL_CALLS": str(self.root / "systemctl-calls.txt"), "FAKE_NAME": self.name,
            "FAKE_WORK": str(self.work), "FAKE_W": str(self.w), "FAKE_CLAUDE_ARGS": str(self.claude_args), "FAKE_CLAUDE_CALLS": str(self.root / "claude-calls.jsonl"), "FAKE_CLAUDE_CHILD_PID": str(self.root / "claude-child.pid"), "FAKE_PANE_OUTPUT": str(self.root / "pane-output.txt"), "PI_CHANNEL_EXT": str(self.channel_ext),
            "CHANNEL_BIN": str(self.channel_bin), "AGENT_CHANNEL": str(self.channel_log),
            # Offline contract runs must not inherit an active ledger task context.
            "TASK_ID": "", "TASK_ISSUE_ID": "", "TASK_LEDGER_DB": ""})

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
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr + (self.work / ("herdr-" + self.name + ".log")).read_text())
        self.assertEqual(self.marker(), "reviewed")
        self.assertFalse(any(self.state()["tabs"].values()))
        self.assertFalse(list(self.work.glob("done-*")))

    def starts(self):
        return [call for call in self.state()["calls"] if call[:2] == ["agent", "start"]]

    def test_claude_p_stream_json_report_session_and_pane_rendering(self):
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", CLAUDE_MODEL="haiku", CLAUDE_EFFORT="high")
        self.assert_success(result)
        args = json.loads(self.claude_args.read_text())
        self.assertEqual(args[0:2], ["-p", "--model"])
        self.assertIn("haiku", args)
        self.assertIn("--permission-mode", args)
        self.assertIn("acceptEdits", args)
        self.assertIn("stream-json", args)
        settings = json.loads(args[args.index("--settings") + 1])
        self.assertTrue(settings["disableAllHooks"])
        self.assertTrue(settings["sandbox"]["enabled"])
        self.assertTrue(settings["sandbox"]["autoAllowBashIfSandboxed"])
        self.assertFalse(settings["sandbox"]["allowUnsandboxedCommands"])
        self.assertNotIn("filesystem", settings["sandbox"])
        self.assertNotIn("/tmp/claude-1000/isolation-smoke/outside", json.dumps(settings))
        self.assertEqual(settings["permissions"]["defaultMode"], "acceptEdits")
        self.assertEqual(settings["permissions"]["allow"], ["Bash(*)"])
        self.assertIn("--strict-mcp-config", args)
        self.assertEqual((self.work / "claude-contract.session").read_text().strip(), "session-smoke")
        self.assertIn('"session_id": "session-smoke"', (self.work / "claude-contract.jsonl").read_text())
        pane = (self.root / "pane-output.txt").read_text()
        self.assertIn("tool: Write", pane)
        self.assertIn("result: finished", pane)
        self.assertTrue((self.w / "handoff/contract-report.md").is_file())
        self.assertIn(VERIFICATION_RULE, (self.work / "claude-contract.md").read_text())

    def test_claude_denial_detection_only_reports_tool_result_error(self):
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", FAKE_CLAUDE_TOOL_DENIAL="1")
        self.assert_success(result)
        log = (self.work / "herdr-contract.log").read_text()
        self.assertEqual(log.count("囲いで止められた"), 1, log)
        self.assertIn("tool_result bwrap: Operation not permitted", (self.root / "pane-output.txt").read_text())

    def test_claude_denial_detection_catches_a_japanese_bash_failure_that_is_not_an_error(self):
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", FAKE_CLAUDE_BASH_JA="1")
        self.assert_success(result)
        log = (self.work / "herdr-contract.log").read_text()
        self.assertEqual(log.count("囲いで止められた"), 1, log)

    def test_claude_body_bubblewrap_text_does_not_trigger_denial(self):
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", FAKE_CLAUDE_BODY_BUBBLEWRAP="1")
        self.assert_success(result)
        log = (self.work / "herdr-contract.log").read_text()
        self.assertNotIn("囲いで止められた", log)
        self.assertNotIn("囲いで止められた", (self.root / "pane-output.txt").read_text())

    def test_claude_denial_detection_only_reports_new_attempt_data(self):
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", FAKE_CLAUDE_RETRY_DENIAL="1")
        self.assert_success(result)
        log = (self.work / "herdr-contract.log").read_text()
        self.assertEqual(log.count("囲いで止められた"), 1, log)
        self.assertEqual((self.claude_args.with_suffix(".json.count")).read_text(), "2")

    def test_claude_sandbox_can_be_disabled_explicitly(self):
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", CLAUDE_SANDBOX="0")
        self.assert_success(result)
        args = json.loads(self.claude_args.read_text())
        self.assertIn("bypassPermissions", args)
        self.assertEqual(args[args.index("--settings") + 1], '{"disableAllHooks":true}')

    def test_claude_result_finishes_when_descendant_holds_stdout_open(self):
        import signal
        import time
        started = time.monotonic()
        result = self.run_script(IMPL_AGENT="claude", REV_AGENT="codex", CLAUDE_MODEL="haiku", CLAUDE_EFFORT="high", FAKE_CLAUDE_HOLD_CHILD="1")
        elapsed = time.monotonic() - started
        child_pid = int((self.root / "claude-child.pid").read_text()) if (self.root / "claude-child.pid").exists() else None
        try:
            self.assert_success(result)
            log=(self.work / ("herdr-" + self.name + ".log")).read_text()
            self.assertIn("自分で終わった=yes 終了コード=0", log)
            self.assertIn("terminal_reason=success", log)
            self.assertLess(elapsed, 15, f"stream formatter waited for inherited stdout (elapsed {elapsed:.1f}s)")
        finally:
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

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
        self.assertFalse(self.channel_log.exists())  # Codex は引き続き印で完了判定

    def test_project_style_configuration_and_patch_exclusions(self):
        self.prefix = "codex-example-"
        self.prepare_request()
        self.config.update({"TASK_PREFIX": self.prefix, "BRANCH_PREFIX": "codex", "WORK_NAME": "example-codex",
            "RULES": "handoff/evidence.md handoff/design-first.md", "DESIGN_RULES": "handoff/design-first.md",
            "EXTRA_DIRS": "assets/cache", "EXTRA": "reference.txt", "PATCH_EXCLUDE": ":!*.png :!assets",
            "COMMIT_NAME": "Example", "COMMIT_EMAIL": "example@noreply.invalid"})
        (self.repo / "handoff/evidence.md").write_text("evidence\n")
        (self.repo / "handoff/design-first.md").write_text("project design conclusions\n")
        (self.repo / "assets/cache").mkdir(parents=True)
        (self.repo / "assets/cache/index.json").write_text("original\n")
        (self.repo / "reference.txt").write_text("read only\n")
        self.assert_success(self.run_script())
        tracked = self.git("ls-files", cwd=self.w).splitlines()
        patch = (self.work / "patch-contract.diff").read_text()
        self.assertNotIn("reference.txt", tracked)
        self.assertFalse(any(path.endswith(".png") or path.startswith("assets/") for path in tracked))
        self.assertNotIn("generated.png", patch)
        self.assertNotIn("reference.txt", patch)
        self.assertEqual((self.repo / "assets/cache/index.json").read_text(), "original\n")
        self.assertEqual((self.w / "reference.txt").stat().st_mode & 0o222, 0)
        self.assertTrue((self.w / "handoff/codex-example-contract-review.md").is_file())
        self.assertEqual(self.git("branch", "--show-current", cwd=self.w).strip(), "codex/contract")
        self.assertEqual(self.git("log", "-1", "--format=%an <%ae>", cwd=self.w).strip(), "Example <example@noreply.invalid>")
        impl_text = self.state()["prompts"][0][1]
        self.assertIn("handoff/design-first.md の手順と結論の書式に従う", impl_text)
        self.assertIn("終わりの条件: 満たした", impl_text)
        self.assertIn("終わりの条件: 満たしていない", impl_text)
        self.assertIn(VERIFICATION_RULE, impl_text)
        self.assertNotIn("10 行程度", impl_text)

    def test_link_dirs_are_symlinks_and_replace_preexisting_directories(self):
        (self.repo / "node_modules").mkdir()
        (self.repo / "node_modules" / "dependency.txt").write_text("external dependency\n")
        # A trailing slash in .gitignore matches directories only. The link must still
        # stay out of both the worker commit and the generated patch.
        (self.repo / ".gitignore").write_text("node_modules/\n")
        self.git("add", ".gitignore")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@noreply.invalid", "commit", "-q", "-m", "ignore node_modules")
        self.config.update({"LINK_DIRS": "node_modules", "EXTRA_DIRS": "node_modules"})
        result = self.run_script(FAKE_PREEXISTING_LINK_DIR="node_modules")
        self.assert_success(result)
        self.assertTrue((self.w / "node_modules").is_symlink())
        self.assertEqual(os.readlink(self.w / "node_modules"), str(self.repo / "node_modules"))
        self.assertTrue((self.w / "node_modules/dependency.txt").is_file())
        committed_paths = self.git("show", "--format=", "--name-only", "HEAD", cwd=self.w).splitlines()
        patch = (self.work / "patch-contract.diff").read_text()
        self.assertFalse(any("node_modules" in path for path in committed_paths), committed_paths)
        self.assertNotIn("node_modules", patch)
        log = (self.work / "herdr-contract.log").read_text()
        self.assertIn("LINK_DIRS を優先", log)

    def test_recursive_self_link_in_extra_dirs_stops_as_environment_failure(self):
        (self.repo / "node_modules").mkdir()
        (self.repo / "node_modules" / "nested").mkdir()
        (self.repo / "node_modules" / "nested" / "node_modules").symlink_to(self.repo / "node_modules", target_is_directory=True)
        self.config["EXTRA_DIRS"] = "node_modules"
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.marker(), "environment-failed")
        self.assertIn("自分や祖先を指すリンク", (self.work / "herdr-contract.log").read_text())
        self.assertTrue((self.repo / "node_modules/nested/node_modules").is_symlink())
        self.assertFalse((self.work / ("done-impl-contract")).exists())

    def test_extra_dirs_still_copy_the_directory(self):
        (self.repo / "shared-data").mkdir()
        (self.repo / "shared-data" / "value.txt").write_text("copy\n")
        self.config["EXTRA_DIRS"] = "shared-data"
        self.assert_success(self.run_script())
        self.assertFalse((self.w / "shared-data").is_symlink())
        self.assertEqual((self.w / "shared-data/value.txt").read_text(), "copy\n")

    def test_ignored_extra_and_excluded_paths_do_not_fail_staging(self):
        (self.repo / ".gitignore").write_text("assets/\nreference.txt\n")
        self.config.update({"EXTRA": "reference.txt", "PATCH_EXCLUDE": ":!*.png :!assets"})
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

    def test_verification_rule_is_consistent_in_worker_instructions(self):
        for path in (SKILL / "agents/pi-system.md", SKILL / "agents/claude.sh", SKILL / "herdr-run.sh"):
            with self.subTest(path=path.name):
                self.assertIn(VERIFICATION_RULE, path.read_text())

    def test_legacy_work_directory_is_supported(self):
        self.config.pop("HERDR_WORK")
        self.assert_success(self.run_script(CODEX_WORK=str(self.work)))

    def test_pi_channel_finish_advances_and_passes_named_wrapper(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", FAKE_SUPERVISOR="claude-271"))
        self.assertFalse((self.work / "done-impl-contract").exists())
        rows = [json.loads(line) for line in self.channel_log.read_text().splitlines()]
        self.assertEqual(rows[0]["kind"], "finish")
        self.assertEqual(rows[0]["from"], "impl-contract")
        self.assertIn("Fake implementation finished", (self.work / "herdr-contract.log").read_text())
        wrapper = self.work / "pi-channel-impl-contract.ts"
        self.assertFalse((self.w / "pi-channel-impl-contract.ts").exists())
        contents = wrapper.read_text()
        self.assertIn(json.dumps(str(self.channel_ext)), contents)
        self.assertIn(json.dumps(str(self.channel_log)), contents)
        self.assertIn(json.dumps("impl-contract"), contents)
        self.assertIn(json.dumps("claude-271"), contents)
        self.assertEqual(len(contents.splitlines()), 2)
        self.assertIn("宛先 claude-271", (self.work / "herdr-contract.log").read_text())
        self.assertIn(str(wrapper), self.starts()[0])
        self.assertIn("channel_finish", self.state()["prompts"][0][1])
        self.assertIn(VERIFICATION_RULE, self.state()["prompts"][0][1])
        self.assertIn("agents/pi-system.md", " ".join(self.starts()[0]))
        self.assertNotIn("touch ", self.state()["prompts"][0][1])

    def test_pi_supervisor_override_is_written_to_wrapper_and_logged(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", AGENT_CHANNEL_SUPERVISOR="claude-314", FAKE_SUPERVISOR="claude-271"))
        wrapper = (self.work / "pi-channel-impl-contract.ts").read_text()
        self.assertIn(json.dumps("claude-314"), wrapper)
        self.assertIn("宛先 claude-314", (self.work / "herdr-contract.log").read_text())

    def test_pi_missing_supervisor_stops_before_worktree_or_tab_creation(self):
        result = self.run_script(IMPL_AGENT="pi", REV_AGENT="codex")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertIn("宛先の Claude が見つからない。AGENT_CHANNEL_SUPERVISOR=claude-<PID> を付けて起動し直す", result.stderr)
        self.assertIn("channel supervisor の出力が空", self.log_text())
        self.assertIn("channel supervisor の出力が空", result.stderr)
        self.assertFalse(self.w.exists())
        self.assertEqual(self.state()["serial"], 0)
        self.assertEqual(self.state()["calls"], [])

    def test_pi_failed_supervisor_command_stops_before_worktree_or_tab_creation(self):
        result = self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", FAKE_SUPERVISOR_FAIL="1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertIn("宛先の Claude が見つからない。AGENT_CHANNEL_SUPERVISOR=claude-<PID> を付けて起動し直す", result.stderr)
        self.assertIn("channel supervisor が失敗", self.log_text())
        self.assertIn("channel supervisor が失敗", result.stderr)
        self.assertFalse(self.w.exists())
        self.assertEqual(self.state()["serial"], 0)
        self.assertEqual(self.state()["calls"], [])

    def test_old_pi_finish_before_snapshot_does_not_advance(self):
        self.channel_log.write_text(json.dumps({"id": "old", "kind": "finish", "from": "impl-contract", "body": "stale"}) + "\n")
        result = self.run_script(mode="old-finish", IMPL_AGENT="pi", REV_AGENT="codex", FAKE_SUPERVISOR="claude-271")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertEqual(len(self.state()["prompts"]), 3)
        self.assertTrue(any(self.state()["tabs"].values()))

    def test_pi_channel_can_be_disabled_and_codex_keeps_marker(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", PI_CHANNEL="0"))
        self.assertTrue((self.work / "herdr-contract.log").is_file())
        self.assertFalse(self.channel_log.exists())
        self.assertIn("touch ", self.state()["prompts"][0][1])
        self.assertFalse((self.work / "pi-channel-impl-contract.ts").exists())

    def test_pi_missing_channel_cli_falls_back_to_marker(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", CHANNEL_BIN=str(self.root / "missing-channel")))
        self.assertIn("touch ", self.state()["prompts"][0][1])
        self.assertFalse((self.work / "pi-channel-impl-contract.ts").exists())
        self.assertFalse(self.channel_log.exists())

    def test_pi_has_no_astra_restriction(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", PI_MODEL="gpt-6-astra", FAKE_SUPERVISOR="claude-271"))
        self.assertIn("gpt-6-astra", self.starts()[0])
        self.assertIn("pi", self.starts()[0])
        self.assertIn("gpt-6.1-sol", self.starts()[1])

    def test_pi_system_prompt_override_and_default(self):
        self.assert_success(self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", PI_CHANNEL="0"))
        start = self.starts()[0]
        self.assertEqual(start[start.index("--system-prompt") + 1], str(SKILL / "agents/pi-system.md"))

    def test_pi_system_prompt_explicit_override_precedes_legacy_setting(self):
        override = str(self.root / "custom-pi-system.md")
        result = self.run_script(IMPL_AGENT="pi", REV_AGENT="codex", PI_CHANNEL="0",
            PI_SYSTEM_PROMPT=override, PI_SYSTEM=str(self.root / "legacy-pi-system.md"))
        self.assert_success(result)
        start = self.starts()[0]
        self.assertEqual(start[start.index("--system-prompt") + 1], override)

    def ledger(self, *args):
        env = self.env | {"TASK_LEDGER_DB": str(self.root / "ledger.sqlite")}
        return subprocess.run([str(TASK_BIN), *args], env=env, text=True, capture_output=True, timeout=30)

    def ledger_task(self):
        added = self.ledger("add", "--repo", str(self.repo), "--title", "契約", "--why", "test", "--brief", f"handoff/{self.name}.md")
        self.assertEqual(added.returncode, 0, added.stderr)
        return added.stdout.split("\t")[0]

    def ledger_show(self, task_id):
        return json.loads(self.ledger("show", task_id).stdout.split("\n}")[0] + "}")

    def test_ledger_task_skips_peer_review_commits_and_waits_for_checks(self):
        task_id = self.ledger_task()
        result = self.run_script(TASK_ID=task_id, TASK_LEDGER_DB=str(self.root / "ledger.sqlite"))
        self.assertEqual(result.returncode, 0, (self.work / "herdr-contract.log").read_text())
        self.assertEqual(self.marker(), "implemented")
        self.assertEqual(len(self.starts()), 1)
        self.assertFalse(any(self.state()["tabs"].values()))
        task = self.ledger_show(task_id)
        self.assertEqual(task["status"], "確かめ中")
        self.assertEqual(task["agent"], "impl-contract")
        self.assertEqual(task["commit"], self.git("rev-parse", "HEAD", cwd=self.w).strip())
        self.assertNotEqual(task["commit"], self.initial_head)
        self.assertEqual((self.root / "systemctl-calls.txt").read_text().splitlines(),
            ["--user start --no-block task-ledger.service"])

    def test_ledger_kick_failure_does_not_change_script_exit_status(self):
        task_id = self.ledger_task()
        result = self.run_script(TASK_ID=task_id, TASK_LEDGER_DB=str(self.root / "ledger.sqlite"), FAKE_SYSTEMCTL_FAIL="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "systemctl-calls.txt").read_text().splitlines(),
            ["--user start --no-block task-ledger.service"])
        self.assertIn("task-ledger.service の起動に失敗した", (self.work / "herdr-contract.log").read_text())

    def test_no_task_or_disabled_kick_does_not_call_systemctl(self):
        self.assert_success(self.run_script(TASK_KICK="0"))
        self.assertFalse((self.root / "systemctl-calls.txt").exists())

    def test_issue_task_generates_brief_in_worker_copy_without_repo_brief(self):
        created = self.ledger("issue", "add", "--repo", str(self.repo), "--title", "Issue仕事", "--なぜ", "理由", "--今の状態", "確認済みの現状", "--関係する所", "baseline.txt")
        self.assertEqual(created.returncode, 0, created.stderr)
        issue_id = created.stdout.split("\t")[0]
        added = self.ledger("add", "--repo", str(self.repo), "--issue", issue_id)
        self.assertEqual(added.returncode, 0, added.stderr)
        task_id = added.stdout.split("\t")[0]
        held = self.ledger("hold", task_id, "テスト用の保留")
        self.assertEqual(held.returncode, 0, held.stderr)
        answered = self.ledger("answer", task_id, "判断待ちへの回答です")
        self.assertEqual(answered.returncode, 0, answered.stderr)
        (self.repo / ".herdr.env").write_text("".join(f"{k}={shlex.quote(v)}\n" for k, v in self.config.items()))
        env = self.env | {"FAKE_MODE": "normal", "FAKE_PREFIX": self.prefix, "TASK_ID": task_id,
            "TASK_ISSUE_ID": issue_id, "TASK_LEDGER_DB": str(self.root / "ledger.sqlite"), "TASK_RUN_AFTER": "0"}
        result = subprocess.run(["bash", str(SKILL / "herdr-run.sh"), issue_id], cwd=self.repo, env=env,
            stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=30)
        issue_work = self.work / "wt" / issue_id
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr + (self.work / f"herdr-{issue_id}.log").read_text())
        prompts = [text for agent, text in self.state()["prompts"] if agent.startswith("impl-")]
        self.assertTrue(prompts)
        self.assertIn("## 判断待ちへの答え\n判断待ちへの回答です", prompts[0])
        # The issue-specific prompt contains the task context exactly once, without an additional Issue context section.
        self.assertEqual(prompts[0].count("## 判断待ちへの答え"), 1)
        self.assertNotIn("## Issue\\n", prompts[0])
        brief = issue_work / "handoff" / f"{issue_id}.md"
        self.assertTrue(brief.is_file())
        content = brief.read_text()
        self.assertIn("## 今の状態", content)
        self.assertIn("## 関係する所", content)
        # task add --issue materializes the canonical brief in the repo; the worker copy
        # also receives it, but the brief must remain excluded from the worker commit.
        repo_brief = self.repo / "handoff" / f"{issue_id}.md"
        self.assertTrue(repo_brief.is_file())
        self.assertEqual(repo_brief.read_text().strip(), self.ledger("issue", "brief", issue_id).stdout.strip())
        committed = self.git("show", "--format=", "--name-only", "HEAD", cwd=issue_work)
        self.assertNotIn(f"handoff/{issue_id}.md", committed.splitlines())

    def test_ledger_task_stopped_by_design_waits_for_a_decision(self):
        task_id = self.ledger_task()
        result = self.run_script(mode="stop", TASK_ID=task_id, TASK_LEDGER_DB=str(self.root / "ledger.sqlite"), TASK_RUN_AFTER="0")
        self.assertEqual(result.returncode, 0)
        task = self.ledger_show(task_id)
        self.assertEqual(task["status"], "判断待ち")
        self.assertIn("STOP", task["note"])

    def test_task_missing_from_ledger_is_refused_before_anything_starts(self):
        result = self.run_script(TASK_ID="nothing-1", TASK_LEDGER_DB=str(self.root / "ledger.sqlite"))
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.w.exists())
        self.assertEqual(self.starts(), [])
        self.assertIn("走行中にできなかった", (self.work / "herdr-contract.log").read_text())

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

    def ledger_send_back(self, task_id, reason):
        # The same ledger write advance.ts's sendBack makes: back to 走行中 with a 「差し戻し: 」 note.
        script = ("import { Ledger } from %s; const l = new Ledger(process.env.TASK_LEDGER_DB);"
                  " l.setStatus(process.argv[1], '走行中', '差し戻し: ' + process.argv[2]); l.close();"
                  % json.dumps((SKILL.parents[1] / "tools/task-ledger/ledger.ts").as_uri()))
        done = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", script, task_id, reason],
            env=self.env | {"TASK_LEDGER_DB": str(self.root / "ledger.sqlite")}, text=True, capture_output=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_claude_sendback_resumes_and_sends_only_the_sendback_text(self):
        # Through the real ledger with a TASK_ID: the send-back reason reaches the worker only via `task context`.
        task_id = self.ledger_task()
        ledger = {"TASK_ID": task_id, "TASK_LEDGER_DB": str(self.root / "ledger.sqlite"), "TASK_RUN_AFTER": "0",
            "IMPL_AGENT": "claude", "REV_AGENT": "codex"}
        first = self.run_script(**ledger)
        self.assertEqual(first.returncode, 0, (self.work / "herdr-contract.log").read_text())
        self.ledger_send_back(task_id, "REASON-ONE: mul.js の符号を直す")
        self.run_script(RESUME="newtab", SEND_BACK="1", **ledger)
        self.ledger_send_back(task_id, "REASON-TWO: 報告に検査の出力を貼る")
        self.run_script(RESUME="newtab", SEND_BACK="1", **ledger)
        calls = [json.loads(line) for line in (self.root / "claude-calls.jsonl").read_text().splitlines()]
        self.assertEqual(len(calls), 3, (self.work / "herdr-contract.log").read_text())
        self.assertNotIn("--resume", calls[0]["args"])
        session = (self.work / "claude-contract.session").read_text().strip()
        for call in calls[1:]:
            self.assertIn("--resume", call["args"])
            self.assertEqual(call["args"][call["args"].index("--resume") + 1], session)
        full_prompt = (self.work / "claude-contract.full.md").read_text()
        # Each resumed call carries its own send-back reason, and not the whole request again.
        self.assertIn("REASON-ONE: mul.js の符号を直す", calls[1]["input"])
        self.assertIn("REASON-TWO: 報告に検査の出力を貼る", calls[2]["input"])
        self.assertNotIn("REASON-ONE", calls[2]["input"])
        for call in calls[1:]:
            self.assertLess(len(call["input"]), len(full_prompt) // 2)
            self.assertNotIn("その依頼どおりに作業し", call["input"])
            self.assertIn("handoff/contract-report.md", call["input"])
        self.assertIn("REASON-TWO", full_prompt)

    def test_failed_worker_resume_retries_once_with_full_prompt_without_resume(self):
        self.assert_success(self.run_script(IMPL_AGENT="claude", REV_AGENT="codex"))
        self.run_script(RESUME="newtab", SEND_BACK="1", IMPL_AGENT="claude", REV_AGENT="codex", FAKE_CLAUDE_RESUME_FAIL="1")
        calls = [json.loads(line) for line in (self.root / "claude-calls.jsonl").read_text().splitlines()]
        self.assertEqual(len(calls), 3)  # initial, failed --resume, fresh full-prompt retry
        self.assertIn("--resume", calls[1]["args"])
        self.assertNotIn("--resume", calls[2]["args"])
        self.assertEqual(calls[2]["input"], (self.work / "claude-contract.full.md").read_text())
        self.assertNotIn("差し戻しの文と現在の依頼文の差分だけ", calls[2]["input"])

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

    def test_refreshed_sendback_prompt_starts_with_read_the_updated_brief(self):
        self.run_script(mode="blocked")
        state = self.state()
        state["agents"] = {}
        state["tabs"] = {}
        self.state_path.write_text(json.dumps(state))
        self.assert_success(self.run_script(RESUME="newtab", SKIP_IMPL="1", SEND_BACK_BRIEF_REFRESHED="1"))
        prompt = self.state()["prompts"][-1][1]
        self.assertTrue(prompt.startswith("/goal 依頼文が変わった。読み直してから続ける\n"), prompt[:200])

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

    def log_text(self):
        return (self.work / ("herdr-" + self.name + ".log")).read_text()

    def test_preflight_detects_missing_check_command_before_starting_worker(self):
        result = self.run_script(TASK_CHECK="definitely-not-a-real-check-command")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.marker(), "environment-failed")
        self.assertEqual(self.starts(), [])
        log = (self.work / "herdr-contract.log").read_text()
        self.assertIn("起動前の確かめで環境の失敗（終了コード 127）", log)

    def test_preflight_allows_a_not_yet_created_script_to_start_worker(self):
        result = self.run_script(TASK_CHECK="bash tools/not-yet.sh")
        self.assert_success(result)
        self.assertGreaterEqual(len(self.state()["prompts"]), 1)
        self.assertTrue(self.starts())

    def test_preflight_copies_an_uncommitted_handoff_doc_the_request_names(self):
        (self.repo / "handoff" / "other-notes.md").write_text("notes\n")
        (self.repo / "handoff" / "contract.md").write_text("Read `handoff/other-notes.md` and write handoff/contract-report.md\n")
        self.assert_success(self.run_script())
        self.assertTrue((self.w / "handoff/other-notes.md").is_file())

    def test_preflight_stops_when_a_named_handoff_doc_exists_nowhere(self):
        (self.repo / "handoff" / "contract.md").write_text("Read handoff/missing-brief.md\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.marker(), "failed")
        self.assertIn("handoff/missing-brief.md が本体にも写しにも無い", self.log_text())
        self.assertEqual(len(self.state()["prompts"]), 0)

    def test_preflight_ignores_paths_quoted_in_code_blocks(self):
        (self.repo / "handoff" / "contract.md").write_text("Fix the flaky test.\n\n```\nAssertionError: 'handoff/missing-brief.md が無い'\n```\n")
        self.assert_success(self.run_script())
        self.assertNotIn("本体にも写しにも無い", self.log_text())

    def test_preflight_stops_a_task_marked_waiting_in_state(self):
        (self.repo / "STATE.md").write_text("- 待ち: contract は other の取り込み後に出す\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("「待ち」がある", self.log_text())
        self.assertEqual(len(self.state()["prompts"]), 0)
        self.git("worktree", "remove", "--force", str(self.w)); self.git("branch", "-D", "herdr/contract")
        self.assert_success(self.run_script(WAIT_OK="1"))

    def cleanup(self, *flags):
        return subprocess.run(["bash", str(SKILL / "herdr-run.sh"), "--cleanup", self.name, *flags], cwd=self.repo, env=self.env,
            stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=30)

    def test_cleanup_keeps_unmerged_work_unless_discarded_and_keeps_reports(self):
        self.assert_success(self.run_script())
        result = self.cleanup()
        self.assertEqual(result.returncode, 1)
        self.assertIn("取り込まれていない", result.stderr)
        self.assertTrue(self.w.is_dir())
        result = self.cleanup("--discard")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.w.exists())
        self.assertNotIn("herdr/contract", self.git("branch", "--list", "herdr/*"))
        self.assertTrue((self.repo / "handoff/contract-review.md").is_file())
        self.assertIn("片付けた（捨てた）", self.log_text())

    def test_cleanup_after_merge_needs_no_discard(self):
        self.assert_success(self.run_script())
        (self.repo / "handoff/contract.md").unlink()
        try: self.git("-c", "user.name=F", "-c", "user.email=f@f", "merge", "-q", "--no-edit", "herdr/contract")
        except subprocess.CalledProcessError as e: self.fail(e.output)
        result = self.cleanup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.w.exists())
        self.assertIn("片付けた（取り込み済み）", self.log_text())

    def test_cleanup_ignores_same_name_runner_in_another_repository(self):
        self.assert_success(self.run_script())
        (self.repo / "handoff/contract.md").unlink()
        try: self.git("-c", "user.name=F", "-c", "user.email=f@f", "merge", "-q", "--no-edit", "herdr/contract")
        except subprocess.CalledProcessError as e: self.fail(e.output)
        unrelated_repo = self.root / "unrelated-repo"
        unrelated_repo.mkdir()
        other = subprocess.Popen(["bash", "-c", 'exec -a "bash herdr-run.sh contract" /usr/bin/sleep 30'], cwd=unrelated_repo)
        try:
            result = self.cleanup()
        finally:
            other.kill()
            other.wait(timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.w.exists())

    def test_cleanup_refuses_same_name_runner_in_the_same_repository(self):
        self.assert_success(self.run_script())
        same_repo_runner = subprocess.Popen(["bash", "-c", 'exec -a "bash herdr-run.sh contract" /usr/bin/sleep 30'], cwd=self.repo)
        try:
            result = self.cleanup()
        finally:
            same_repo_runner.kill()
            same_repo_runner.wait(timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("台本 contract がまだ動いている", result.stderr)
        self.assertTrue(self.w.is_dir())

    def test_preflight_stops_when_a_running_task_touches_the_same_file(self):
        (self.repo / "handoff" / "other.md").write_text("Change src/app.tsx\n")
        (self.repo / "handoff" / "contract.md").write_text("Also edit `src/app.tsx`\n")
        other = subprocess.Popen(["bash", "-c", 'exec -a "bash herdr-run.sh other" /usr/bin/sleep 30'])
        def stop_other():
            try: other.kill()
            except ProcessLookupError: pass
            other.wait(timeout=5)
        self.addCleanup(stop_other)
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("動いている仕事 other と触るファイルが重なる: src/app.tsx", self.log_text())
        self.git("worktree", "remove", "--force", str(self.w)); self.git("branch", "-D", "herdr/contract")
        self.assert_success(self.run_script(OVERLAP_OK="1"))


if __name__ == "__main__":
    unittest.main()
