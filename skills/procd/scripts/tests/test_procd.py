"""CLI・実プロセス・保存物から振る舞いを確かめる。Linux 専用。"""
import ctypes
from dataclasses import asdict, replace
import errno
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

TOOL = Path(__file__).resolve().parents[1]
ROOT = TOOL.parents[1]
sys.path.insert(0, str(TOOL))
from config import Config, ProcdError
from daemon import Daemon
from process import identity, matches, signal_group
from procd import call
from storage import Journal, Store, atomic_json, read_json

# このテスト自身が孤児を回収する。systemd やホストの設定は変更しない。
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)


def eventually(check, timeout=8):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = check()
            if last:
                return last
        except (OSError, ProcdError):
            pass
        time.sleep(0.02)
    raise AssertionError(f"状態が揃いませんでした: {last!r}")


class LineReader:
    """Monitor 相当: 別プロセスの stdout を1行ずつ受け取る。"""
    def __init__(self, process):
        self.process, self.lines = process, queue.Queue()
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip("\n"))

    def take(self, predicate):
        collected = []
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            collected.append(line)
            if predicate(line):
                return collected
        raise AssertionError("通知が届きませんでした")


class Fixture:
    def __init__(self, config=None):
        self.temporary = tempfile.TemporaryDirectory(prefix=".procd-test-", dir=ROOT)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.address = "@procd-test-" + uuid.uuid4().hex
        self.config = self.root / "config.json"
        atomic_json(self.config, asdict(config or Config()))
        self.stderr = (self.root / "daemon.log").open("ab", buffering=0)
        self.daemon, self.children = None, []
        self.start()

    def start(self):
        self.daemon = subprocess.Popen(self.argv("serve", "--state-dir", str(self.state),
                                               "--config", str(self.config)),
                                       stdout=subprocess.DEVNULL, stderr=self.stderr,
                                       env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        try:
            eventually(lambda: call(self.address, {"op": "ping"}))
        except AssertionError as exc:
            raise AssertionError((self.root / "daemon.log").read_text()) from exc

    def halt(self, force=False):
        if self.daemon and self.daemon.poll() is None:
            self.daemon.send_signal(signal.SIGKILL if force else signal.SIGTERM)
            self.daemon.wait(timeout=5)

    def argv(self, *args):
        return [sys.executable, str(TOOL / "procd.py"), "--socket", self.address, *args]

    def cli(self, *args, code=0):
        completed = subprocess.run(self.argv(*args), capture_output=True, text=True, timeout=10)
        if completed.returncode != code:
            raise AssertionError(f"{args}: {completed.returncode}\n{completed.stdout}\n{completed.stderr}\n"
                                 + (self.root / "daemon.log").read_text())
        return completed

    def spawn_cli(self, *args):
        process = subprocess.Popen(self.argv(*args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True)
        self.children.append(process)
        return process

    def submit(self, name, code, *extra):
        return json.loads(self.cli("run", name, "--cwd", str(self.root), "--json", *extra,
                                  "--", sys.executable, "-c", code).stdout)

    def status(self, name):
        return json.loads(self.cli("status", name, "--json").stdout)

    def events(self, *args):
        return [json.loads(line) for line in self.cli("events", *args).stdout.splitlines()]

    def blocking(self, name, exit_code=0):
        code = ("from pathlib import Path; import time,sys; "
                f"Path('{name}.ready').touch(); "
                f"exec(\"while not Path('release').exists(): time.sleep(.02)\"); "
                f"print('{name} done', flush=True); sys.exit({exit_code})")
        self.submit(name, code)
        eventually(lambda: (self.root / f"{name}.ready").exists())
        return eventually(lambda: (job if (job := self.status(name))["state"] == "running" else None))

    def close(self):
        for child in self.children:
            if child.poll() is None:
                child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            child.stdout.close()
            child.stderr.close()
        self.halt()
        for directory in self.state.glob("jobs/*"):
            started = read_json(directory / "started.json", {})
            saved = started.get("process")
            signal_group(saved, signal.SIGKILL)
            worker = read_json(directory / "worker.json")
            if matches(worker):
                os.kill(worker["pid"], signal.SIGKILL)
            if worker:
                try:
                    os.waitpid(worker["pid"], 0)
                except ChildProcessError:
                    pass
            if saved:
                try:
                    os.waitpid(saved["pid"], os.WNOHANG)
                except ChildProcessError:
                    pass
        # 実行係を失ったテストの孫と通知コマンドも、このテストの子として回収する。
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    break
            except ChildProcessError:
                break
        self.stderr.close()
        self.temporary.cleanup()


class IntegrationTests(unittest.TestCase):
    def fixture(self, config=None):
        fixture = Fixture(config)
        self.addCleanup(fixture.close)
        return fixture

    def test_calling_shell_can_exit_while_job_runs_and_completion_is_recorded(self):
        fixture = self.fixture()
        code = "from pathlib import Path; import time; exec(\"while not Path('release').exists(): time.sleep(.02)\"); print('survived')"
        caller = subprocess.run(["/bin/bash", "-c", '"$@"', "caller", *fixture.argv(
            "run", "shell", "--cwd", str(fixture.root), "--", sys.executable, "-c", code)],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(caller.returncode, 0, caller.stderr)
        job = eventually(lambda: (job if (job := fixture.status("shell"))["state"] == "running" else None))
        self.assertTrue(matches(job["process"]))
        (fixture.root / "release").touch()
        fixture.cli("wait", "shell")
        events = fixture.events()
        self.assertEqual([event["kind"] for event in events], ["accepted", "started", "exited"])
        self.assertEqual(events[-1]["job"]["exit_code"], 0)
        self.assertIn("survived", fixture.cli("logs", "shell", "--stream", "stdout").stdout)
        if os.environ.get("PROCD_TEST_TRACE"):
            print("SHELL: caller=0; after-caller=running; events=accepted,started,exited; wait=0", flush=True)

    def test_exit_code_environment_metadata_and_both_logs_are_available_through_cli(self):
        fixture = self.fixture()
        fixture.submit("code7", "import os,sys; print(os.environ['MARK']); print('error-line',file=sys.stderr); sys.exit(7)",
                       "--env", "MARK=one=two", "--env", "SECRET_TOKEN=private-value", "--env", "PWD=wrong")
        fixture.cli("wait", "code7", code=7)
        job = fixture.status("code7")
        self.assertEqual(job["exit_code"], 7)
        self.assertEqual(job["cwd"], str(fixture.root))
        self.assertIn("started_at", job)
        self.assertIn("ended_at", job)
        self.assertIn("start_ticks", job["process"])
        self.assertEqual(job["env_summary"]["override_keys"], ["MARK", "PWD", "SECRET_TOKEN"])
        self.assertNotIn("private-value", json.dumps(job))
        self.assertEqual(fixture.cli("logs", "code7", "--stream", "stdout").stdout, "one=two\n")
        self.assertEqual(fixture.cli("logs", "code7", "--stream", "stderr").stdout, "error-line\n")
        self.assertEqual(json.loads(fixture.cli("ls", "--json").stdout)[0]["name"], "code7")

    def test_launch_failure_is_a_terminal_event_with_wait_code_127(self):
        fixture = self.fixture()
        fixture.cli("run", "missing", "--cwd", str(fixture.root), "--", "/no/such/procd-test-command")
        fixture.cli("wait", "missing", code=127)
        self.assertEqual(fixture.status("missing")["state"], "failed")
        self.assertEqual([event["kind"] for event in fixture.events()], ["accepted", "failed"])

    def test_duplicate_names_and_parallel_limit_reject_without_starting_another_job(self):
        fixture = self.fixture(replace(Config(), max_parallel=1))
        fixture.blocking("same")
        fixture.cli("run", "same", "--", "/bin/true", code=1)
        fixture.cli("run", "other", "--", "/bin/true", code=1)
        self.assertEqual(len(json.loads(fixture.cli("ls", "--json").stdout)), 1)
        fixture.cli("stop", "same", "--grace", "0.1")
        fixture.cli("run", "same", "--", "/bin/true", code=1)

    def test_stop_uses_graceful_signal_before_forcing(self):
        fixture = self.fixture()
        fixture.submit("gentle", "import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,lambda *_:exit(0)); Path('ready').touch(); time.sleep(30)")
        eventually(lambda: (fixture.root / "ready").exists())
        fixture.cli("stop", "gentle", "--grace", "0.5")
        job = fixture.status("gentle")
        self.assertEqual((job["state"], job["exit_code"], job["forced"]), ("stopped", 0, False))

    def test_stop_forces_term_ignoring_command_and_its_descendant(self):
        fixture = self.fixture()
        child = "import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path('child').write_text(str(__import__('os').getpid())); time.sleep(30)"
        parent = f"import signal,time,subprocess,sys; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); subprocess.Popen([sys.executable,'-c',{child!r}]); Path('ready').touch(); time.sleep(30)"
        fixture.submit("stubborn", parent)
        eventually(lambda: (fixture.root / "child").exists())
        descendant = identity(int((fixture.root / "child").read_text()))
        fixture.cli("stop", "stubborn", "--grace", "0.1")
        fixture.cli("wait", "stubborn", code=137)
        job = fixture.status("stubborn")
        self.assertEqual((job["state"], job["exit_code"], job["forced"]), ("stopped", -9, True))
        self.assertFalse(matches(descendant))
        self.assertEqual(sum(event["kind"] == "stopped" for event in fixture.events()), 1)

    def test_stop_preserves_descendant_grace_even_when_parent_exits_and_child_closes_output(self):
        fixture = self.fixture()
        child = "import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path('child').write_text(str(__import__('os').getpid())); time.sleep(30)"
        parent = f"import signal,time,subprocess,sys; signal.signal(signal.SIGTERM,lambda *_:exit(0)); subprocess.Popen([sys.executable,'-c',{child!r}], stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(30)"
        fixture.submit("child-grace", parent)
        eventually(lambda: (fixture.root / "child").exists())
        descendant = identity(int((fixture.root / "child").read_text()))
        stopper = fixture.spawn_cli("stop", "child-grace", "--grace", "0.5")
        eventually(lambda: fixture.status("child-grace")["state"] == "stopping")
        self.assertTrue(matches(descendant), "出力を閉じた子も停止の猶予中は生きている")
        stopper.wait(timeout=5)
        self.assertEqual(stopper.returncode, 0)
        self.assertFalse(matches(descendant))
        job = fixture.status("child-grace")
        self.assertEqual((job["state"], job["exit_code"], job["forced"]), ("stopped", 0, True))

    def test_live_jobs_and_cursors_survive_daemon_kill_and_resume_without_duplicate_start(self):
        fixture = self.fixture()
        original = fixture.blocking("resume", 9)
        initial = fixture.events("--consumer", "claude", "--ack")
        initial_lines = b"".join(path.read_bytes() for path in sorted((fixture.state / "events").glob("events-*.jsonl")))
        fixture.halt(force=True)
        self.assertTrue(matches(original["process"]))
        self.assertTrue(matches(original["worker"]))
        fixture.start()
        self.assertEqual(fixture.status("resume")["process"], original["process"])
        self.assertEqual(fixture.events("--consumer", "claude"), [])
        (fixture.root / "release").touch()
        fixture.cli("wait", "resume", code=9)
        unread = fixture.events("--consumer", "claude", "--ack")
        self.assertEqual([(event["kind"], event["job"]["exit_code"]) for event in unread], [("exited", 9)])
        self.assertGreater(unread[0]["seq"], initial[-1]["seq"])
        all_lines = b"".join(path.read_bytes() for path in sorted((fixture.state / "events").glob("events-*.jsonl")))
        self.assertTrue(all_lines.startswith(initial_lines))
        fixture.halt(force=True)
        fixture.start()
        self.assertEqual(fixture.events("--consumer", "claude"), [])
        self.assertEqual(sum(event["kind"] == "exited" for event in fixture.events()), 1)
        if os.environ.get("PROCD_TEST_TRACE"):
            print(f"RESTART: pid-and-start-ticks=unchanged; unread={[event['seq'] for event in unread]}; code=9; second-restart-unread=[]", flush=True)

    def test_completion_while_daemon_is_down_is_recovered_once(self):
        fixture = self.fixture()
        job = fixture.blocking("offline", 4)
        fixture.halt()
        (fixture.root / "release").touch()
        eventually(lambda: Path(job["log_dir"]).parent.joinpath("result.json").exists())
        fixture.start()
        fixture.cli("wait", "offline", code=4)
        self.assertEqual(sum(event["kind"] == "exited" for event in fixture.events()), 1)

    def test_missing_worker_and_process_become_lost_once_with_unknown_exit_code(self):
        fixture = self.fixture()
        job = fixture.blocking("lost")
        fixture.events("--consumer", "claude", "--ack")
        fixture.halt(force=True)
        os.kill(job["worker"]["pid"], signal.SIGKILL)
        os.waitpid(job["worker"]["pid"], 0)
        signal_group(job["process"], signal.SIGKILL)
        eventually(lambda: not matches(job["process"]))
        fixture.start()
        fixture.cli("wait", "lost", code=125)
        unread = fixture.events("--consumer", "claude", "--ack")
        self.assertEqual([event["kind"] for event in unread], ["lost"])
        self.assertIsNone(unread[0]["job"]["exit_code"])
        fixture.halt()
        fixture.start()
        self.assertEqual(sum(event["kind"] == "lost" for event in fixture.events()), 1)

    def test_orphan_remains_managed_until_it_disappears_and_exit_code_is_not_invented(self):
        fixture = self.fixture()
        job = fixture.blocking("orphan")
        os.kill(job["worker"]["pid"], signal.SIGKILL)
        eventually(lambda: fixture.status("orphan")["state"] == "orphaned")
        self.assertTrue(matches(job["process"]))
        fixture.cli("stop", "orphan", "--grace", "0.1")
        self.assertEqual(fixture.status("orphan")["state"], "lost")
        fixture.cli("wait", "orphan", code=125)
        self.assertFalse(matches(job["process"]))

    def test_watch_delivers_parallel_completions_as_single_lines_and_consumers_do_not_mix(self):
        fixture = self.fixture()
        watcher = fixture.spawn_cli("watch", "--consumer", "monitor-a")
        monitor = LineReader(watcher)
        first = fixture.blocking("one", 0)
        second = fixture.blocking("two", 7)
        self.assertTrue(matches(first["process"]) and matches(second["process"]))
        fixture.cli("unread", "--consumer", "monitor-a", "--ack", code=1)
        (fixture.root / "release").touch()
        lines = []
        ended = set()
        while len(ended) < 2:
            batch = monitor.take(lambda line: ": 終了;" in line)
            lines.extend(batch)
            ended.add(batch[-1].split(":", 1)[0].split(" ", 1)[1])
        self.assertEqual(ended, {"one", "two"})
        self.assertEqual(len(lines), 6)
        self.assertEqual(len({int(line.split(" ", 1)[0][1:]) for line in lines}), 6)
        self.assertTrue(all("ログ=" in line and "終了コード=" in line for line in lines))
        self.assertTrue(any("two: 終了; 終了コード=7" in line for line in lines))
        eventually(lambda: read_json(fixture.state / "consumers.json").get("monitor-a", {}).get("seq") == 6)
        watcher.send_signal(signal.SIGINT)
        watcher.wait(timeout=3)
        self.assertEqual(fixture.events("--consumer", "monitor-a"), [])
        other = fixture.events("--consumer", "monitor-b", "--ack")
        self.assertEqual(len(other), 6)
        self.assertEqual(sum(event["kind"] == "exited" for event in other), 2)
        self.assertEqual(fixture.events("--consumer", "monitor-b"), [])
        if os.environ.get("PROCD_TEST_TRACE"):
            print("WATCH: " + json.dumps([line.replace(str(fixture.root), "$TEST") for line in lines],
                                         ensure_ascii=False), flush=True)
            print("CONSUMERS: monitor-a-unread=0; monitor-b-first-read=6; monitor-b-unread=0", flush=True)

    def test_unread_can_peek_or_acknowledge_and_since_filters_numbers(self):
        fixture = self.fixture()
        fixture.submit("read", "print('done')")
        fixture.cli("wait", "read")
        peek = fixture.cli("unread", "--consumer", "peek", "--json").stdout
        self.assertEqual(fixture.cli("unread", "--consumer", "peek", "--json").stdout, peek)
        fixture.cli("unread", "--consumer", "peek", "--ack")
        self.assertEqual(fixture.cli("unread", "--consumer", "peek").stdout, "")
        self.assertEqual([event["kind"] for event in fixture.events("--since", "2")], ["exited"])

    def test_huge_stdout_and_stderr_rotate_without_blocking_and_stay_bounded(self):
        config = replace(Config(), log_bytes=100, log_backups=2, log_total_bytes=600, max_parallel=1)
        fixture = self.fixture(config)
        fixture.submit("loud", "import os; os.write(1,b'x'*20000); os.write(2,b'y'*20000)")
        fixture.cli("wait", "loud")
        directory = Path(fixture.status("loud")["log_dir"])
        files = list(directory.glob("*.log*"))
        self.assertEqual(len(files), 6)
        self.assertTrue(all(path.stat().st_size <= 100 for path in files))
        self.assertEqual(sum(path.stat().st_size for path in files), 600)
        self.assertEqual(fixture.cli("logs", "loud", "--stream", "stdout").stdout, "x" * 300)
        self.assertEqual(fixture.cli("logs", "loud", "--stream", "stderr").stdout, "y" * 300)

    def test_logs_follow_shows_existing_and_new_output_once(self):
        fixture = self.fixture()
        fixture.submit("follow", "from pathlib import Path; import time; print('first',flush=True); exec(\"while not Path('release').exists(): time.sleep(.02)\"); print('second',flush=True)")
        follower = fixture.spawn_cli("logs", "follow", "--stream", "stdout", "--follow")
        monitor = LineReader(follower)
        self.assertEqual(monitor.take(lambda line: line == "first"), ["first"])
        self.assertIsNone(follower.poll())
        (fixture.root / "release").touch()
        self.assertEqual(monitor.take(lambda line: line == "second"), ["second"])
        follower.wait(timeout=5)
        self.assertTrue(monitor.lines.empty())

    def test_notification_command_receives_terminal_event_locally(self):
        fixture = self.fixture()
        output = fixture.root / "notification.json"
        config = replace(Config(), notify_command=[sys.executable, "-c",
            "import os,sys; from pathlib import Path; Path(sys.argv[1]).write_text(os.environ['PROCD_EVENT'])",
            str(output)])
        fixture.halt()
        atomic_json(fixture.config, asdict(config))
        fixture.start()
        fixture.submit("notify", "raise SystemExit(3)")
        fixture.cli("wait", "notify", code=3)
        eventually(output.exists)
        self.assertEqual(read_json(output)["job"]["exit_code"], 3)
        self.assertEqual(read_json(output)["kind"], "exited")

    def test_notification_timeout_does_not_block_job_completion_or_event_delivery(self):
        fixture = self.fixture(replace(Config(), notify_timeout_seconds=0.1,
            notify_command=[sys.executable, "-c", "import time; time.sleep(30)"]))
        fixture.submit("notify-timeout", "print('finished')")
        fixture.cli("wait", "notify-timeout")
        self.assertEqual(fixture.events()[-1]["kind"], "exited")
        eventually(lambda: "通知できません" in (fixture.root / "daemon.log").read_text())
        fixture.submit("next", "pass")
        fixture.cli("wait", "next")

    def test_same_state_cannot_be_opened_by_two_daemons(self):
        fixture = self.fixture()
        result = subprocess.run([sys.executable, str(TOOL / "procd.py"), "--socket",
            "@procd-test-" + uuid.uuid4().hex, "serve", "--state-dir", str(fixture.state)],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("既に動いています", result.stderr)
        self.assertIn("pid", call(fixture.address, {"op": "ping"}))

    def test_anonymous_watch_emits_lines_without_creating_consumer_cursor(self):
        fixture = self.fixture()
        watcher = fixture.spawn_cli("watch")
        monitor = LineReader(watcher)
        fixture.submit("anonymous", "pass")
        lines = monitor.take(lambda line: ": 終了;" in line)
        self.assertEqual(len(lines), 3)
        self.assertFalse((fixture.state / "consumers.json").exists())

    def test_cli_reports_deleted_history_before_retained_events_and_acknowledges_gap(self):
        fixture = self.fixture(replace(Config(), event_segment_bytes=2048, event_total_bytes=8192))
        for index in range(4):
            fixture.submit(f"bounded{index}", "pass")
            fixture.cli("wait", f"bounded{index}")
        events = fixture.events("--consumer", "late", "--ack")
        self.assertEqual(events[0]["kind"], "gap")
        self.assertEqual(events[0]["from"], 1)
        self.assertGreater(events[0]["to"], 0)
        self.assertTrue(all(event["seq"] > events[0]["to"] for event in events[1:]))
        self.assertEqual(fixture.events("--consumer", "late"), [])
        total = sum(path.stat().st_size for path in (fixture.state / "events").glob("*.jsonl"))
        self.assertLessEqual(total, 8192)

    def test_too_small_event_budget_refuses_launch_without_keeping_an_unaccepted_job(self):
        fixture = self.fixture(replace(Config(), event_segment_bytes=128, event_total_bytes=256))
        fixture.cli("run", "refused", "--cwd", str(fixture.root), "--", "/bin/true", code=1)
        self.assertEqual(json.loads(fixture.cli("ls", "--json").stdout), [])
        self.assertEqual(fixture.events(), [])
        self.assertEqual(list((fixture.state / "jobs").iterdir()), [])

    def test_result_survives_journal_write_failure_and_is_recovered_after_repair_and_restart(self):
        fixture = self.fixture()
        job = fixture.blocking("disk-recovery", 6)
        fixture.events("--consumer", "reader", "--ack")
        events = fixture.state / "events"
        self.addCleanup(events.chmod, 0o700)
        events.chmod(0o500)  # このテストの列だけを書けなくする。結果の保存先は書ける。
        try:
            (fixture.root / "release").touch()
            result = Path(job["log_dir"]).parent / "result.json"
            eventually(result.exists)
            self.assertEqual(read_json(result)["exit_code"], 6)
            eventually(lambda: "記録を更新できません" in (fixture.root / "daemon.log").read_text())
            fixture.cli("status", "disk-recovery", code=1)
            fixture.halt()
        finally:
            events.chmod(0o700)
        fixture.start()
        fixture.cli("wait", "disk-recovery", code=6)
        unread = fixture.events("--consumer", "reader", "--ack")
        self.assertEqual([(event["kind"], event["job"]["exit_code"]) for event in unread], [("exited", 6)])


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".procd-storage-", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_event_size_and_retention_prune_closed_segments_and_report_unread_gap(self):
        config = replace(Config(), event_segment_bytes=512, event_total_bytes=2048,
                         event_retention_seconds=10)
        journal = Journal(self.root / "events", config)
        for index in range(40):
            journal.append("exited", {"id": str(index), "name": "bounded", "state": "exited", "exit_code": 0})
        self.assertLessEqual(sum(path.stat().st_size for path in journal.root.glob("*.jsonl")), 2048)
        gap, events = journal.after(0)
        self.assertGreater(gap["to"], 0)
        self.assertEqual(gap["from"], 1)
        self.assertEqual([event["seq"] for event in events], list(range(gap["to"] + 1, 41)))
        journal.prune(now=time.time() + 11)
        self.assertEqual(len(journal.segments), 1)
        reloaded = Journal(journal.root, config)
        self.assertEqual(reloaded.append("exited", {"id": "new"})["seq"], 41)

    def test_incomplete_tail_is_sealed_without_rewriting_and_seq_is_not_reused(self):
        config = Config()
        journal = Journal(self.root / "events", config)
        journal.append("exited", {"id": "first"})
        path = journal.active
        with path.open("ab") as stream:
            stream.write(b'{"seq":2')
        damaged = path.read_bytes()
        atomic_json(journal.meta_path, {"seq": 2, "pruned_through": 0})
        reloaded = Journal(journal.root, config)
        self.assertEqual(reloaded.append("exited", {"id": "second"})["seq"], 3)
        self.assertEqual(next(journal.root.glob("*.partial.jsonl")).read_bytes(), damaged)
        again = Journal(journal.root, config)
        self.assertEqual([event["seq"] for event in again.after(0)[1]], [1, 3])

    def test_disk_write_failure_is_reported_and_no_command_is_started(self):
        daemon = Daemon(self.root / "state", Config())
        self.addCleanup(daemon.store.close)
        with patch("storage.atomic_json", side_effect=OSError(errno.ENOSPC, "full")), \
                patch("daemon.subprocess.Popen") as launch:
            with self.assertRaises(OSError):
                daemon.run({"name": "full", "command": ["/bin/true"], "env": {}, "cwd": str(self.root)})
            launch.assert_not_called()
        journal = daemon.store.journal
        with patch("storage.atomic_json", side_effect=OSError(errno.ENOSPC, "full")):
            with self.assertRaises(OSError):
                journal.append("exited", {"id": "full"})
        self.assertEqual(journal.after(0)[1], [])
        with self.assertRaises(ProcdError):
            journal.append("exited", {"id": "retry"})

    def test_event_cleanup_failure_keeps_committed_event_and_refuses_further_growth(self):
        journal = Journal(self.root / "events", Config())
        with patch.object(journal, "prune", side_effect=OSError(errno.EPERM, "cannot delete")):
            committed = journal.append("exited", {"id": "committed"})
        self.assertEqual(journal.after(0)[1], [committed])
        with self.assertRaises(ProcdError):
            journal.append("exited", {"id": "rejected"})
        self.assertEqual(journal.after(0)[1], [committed])
        reloaded = Journal(journal.root, Config())
        self.assertEqual(reloaded.append("exited", {"id": "repaired"})["seq"], 2)

    def job(self, store, job_id, state, ended=0):
        job = {"id": job_id, "name": job_id, "state": state, "last_seq": 0, "ended_epoch": ended}
        directory = store.directory(job)
        directory.mkdir(mode=0o700)
        (directory / "logs").mkdir(mode=0o700)
        store.save_job(job)
        return job

    def test_finished_record_count_and_age_cleanup_preserve_running_jobs(self):
        config = replace(Config(), max_finished_jobs=1, job_retention_seconds=100)
        store = Store(self.root / "state", config)
        self.addCleanup(store.close)
        self.job(store, "active", "running")
        self.job(store, "older", "exited", 10)
        self.job(store, "newer", "exited", 20)
        store.cleanup(now=25)
        self.assertEqual(set(store.jobs), {"active", "newer"})
        self.assertFalse((store.job_root / "older").exists())
        store.cleanup(now=121)
        self.assertEqual(set(store.jobs), {"active"})
        self.assertFalse((store.job_root / "newer").exists())

    def test_total_log_cleanup_removes_finished_logs_and_preserves_active_logs(self):
        config = replace(Config(), log_bytes=16, log_backups=0, max_parallel=1, log_total_bytes=32)
        store = Store(self.root / "state", config)
        self.addCleanup(store.close)
        active = self.job(store, "active", "running")
        finished = self.job(store, "finished", "exited", time.time())
        for job in (active, finished):
            for stream in ("stdout", "stderr"):
                (store.directory(job) / "logs" / f"{stream}.log").write_bytes(b"x" * 16)
        store.cleanup()
        self.assertEqual(sum(path.stat().st_size for path in store.job_root.glob("*/logs/*.log")), 32)
        self.assertEqual(len(list((store.directory(active) / "logs").glob("*.log"))), 2)
        self.assertEqual(list((store.directory(finished) / "logs").glob("*.log")), [])
        self.assertTrue(store.jobs["finished"]["logs_removed"])

    def test_log_space_is_reserved_before_new_job_so_future_output_fits(self):
        config = replace(Config(), log_bytes=16, log_backups=0, max_parallel=1, log_total_bytes=32)
        store = Store(self.root / "state", config)
        self.addCleanup(store.close)
        finished = self.job(store, "finished", "exited", time.time())
        for stream in ("stdout", "stderr"):
            (store.directory(finished) / "logs" / f"{stream}.log").write_bytes(b"x" * 16)
        store.cleanup(reserve_jobs=1)
        self.assertEqual(list((store.directory(finished) / "logs").glob("*.log")), [])
        self.assertTrue(store.jobs["finished"]["logs_removed"])

    def test_consumer_limit_age_and_protected_watch_cursor_are_independent(self):
        config = replace(Config(), max_consumers=2, consumer_retention_seconds=10)
        store = Store(self.root / "state", config)
        self.addCleanup(store.close)
        store.acknowledge("one", 0)
        store.acknowledge("two", 0)
        with self.assertRaises(ProcdError):
            store.acknowledge("three", 0)
        store.cleanup(now=time.time() + 11, protected_consumers={"one"})
        self.assertEqual(set(read_json(store.cursor_path)), {"one"})
        store.acknowledge("three", 0)
        self.assertEqual(set(store.consumers), {"one", "three"})

    def test_newer_event_repairs_snapshot_after_crash_without_reemitting(self):
        store = Store(self.root / "state", Config())
        self.addCleanup(store.close)
        job = self.job(store, "repair", "running")
        store.journal.append("exited", dict(job, state="exited", exit_code=5, ended_epoch=time.time()))
        store.close()
        reloaded = Store(store.root, Config())
        self.addCleanup(reloaded.close)
        self.assertEqual(reloaded.jobs["repair"]["exit_code"], 5)
        self.assertEqual(len(reloaded.journal.after(0)[1]), 1)


class IdentityAndConfigTests(unittest.TestCase):
    def test_mismatched_pid_start_time_or_boot_id_never_receives_a_signal(self):
        saved = identity(os.getpid())
        self.assertTrue(matches(saved))
        with patch("process.os.killpg") as send:
            self.assertFalse(signal_group(dict(saved, start_ticks=saved["start_ticks"] + 1), signal.SIGTERM))
            self.assertFalse(signal_group(dict(saved, boot_id="previous-boot"), signal.SIGTERM))
            send.assert_not_called()

    def test_configuration_rejects_unknown_keys_and_impossible_log_budget(self):
        with tempfile.TemporaryDirectory(prefix=".procd-config-", dir=ROOT) as root:
            path = Path(root) / "config.json"
            for values in ({"unknown": 1}, {"max_parallel": 0}, {"log_total_bytes": 1},
                           {"event_total_bytes": 1}, {"stop_grace_seconds": float("inf")},
                           {"notify_command": "shell string"}):
                with path.open("w") as stream:
                    json.dump(values, stream)
                with self.assertRaises(ProcdError, msg=str(values)):
                    Config.load(path)


if __name__ == "__main__":
    unittest.main()
