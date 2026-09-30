"""停止と保存・読み取りの境界の回帰。"""
import asyncio
import base64
from dataclasses import replace
import errno
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

from test_procd import Fixture, LineReader, ROOT, eventually
from config import Config, ERROR_BYTES, ProcdError
from daemon import Daemon, receive, send
from process import identity, matches, signal_group
from procd import call
from storage import atomic_json, read_json


class ReviewIntegrationTests(unittest.TestCase):
    def fixture(self, config=None):
        fixture = Fixture(config)
        self.addCleanup(fixture.close)
        return fixture

    def test_orphan_stop_resumes_after_daemon_and_worker_are_lost(self):
        fixture = self.fixture()
        fixture.submit("resume-stop", "import signal,time; from pathlib import Path; "
                       "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                       "Path('ready').touch(); time.sleep(30)")
        eventually(lambda: (fixture.root / "ready").exists())
        job = eventually(lambda: (job if (job := fixture.status("resume-stop"))["state"] == "running" else None))
        call(fixture.address, {"op": "stop", "name": "resume-stop", "grace": 0.4})
        fixture.halt(force=True)
        os.kill(job["worker"]["pid"], signal.SIGKILL)
        os.waitpid(job["worker"]["pid"], 0)
        self.assertTrue(matches(job["process"]))
        fixture.start()
        eventually(lambda: fixture.status("resume-stop")["state"] == "lost", timeout=3)
        self.assertFalse(matches(job["process"]))
        fixture.cli("wait", "resume-stop", code=125)
        self.assertEqual(sum(event["kind"] == "lost" for event in fixture.events()), 1)

    def test_orphan_stop_keeps_descendant_managed_after_parent_is_reaped_and_daemon_restarts(self):
        fixture = self.fixture()
        child = ("import signal,time,os; from pathlib import Path; "
                 "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                 "Path('child').write_text(str(os.getpid())); time.sleep(30)")
        parent = ("import signal,time,subprocess,sys; "
                  "signal.signal(signal.SIGTERM,lambda *_:exit(0)); "
                  f"subprocess.Popen([sys.executable,'-c',{child!r}], "
                  "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(30)")
        fixture.submit("orphan-child", parent)
        eventually(lambda: (fixture.root / "child").exists())
        job = eventually(lambda: (job if (job := fixture.status("orphan-child"))["state"] == "running" else None))
        descendant = identity(int((fixture.root / "child").read_text()))
        try:
            os.kill(job["worker"]["pid"], signal.SIGKILL)
            eventually(lambda: fixture.status("orphan-child")["state"] == "orphaned")
            call(fixture.address, {"op": "stop", "name": "orphan-child", "grace": 0.8})
            eventually(lambda: not matches(job["process"]))
            os.waitpid(job["process"]["pid"], 0)  # 親の PID の照合だけでは、子へ KILL を送れない条件。
            self.assertTrue(matches(descendant))
            self.assertEqual(fixture.status("orphan-child")["state"], "stopping")
            fixture.halt(force=True)
            fixture.start()
            fixture.cli("stop", "orphan-child", "--grace", "0.1")
            self.assertFalse(matches(descendant))
            fixture.cli("wait", "orphan-child", code=125)
            self.assertEqual(sum(event["kind"] == "lost" for event in fixture.events()), 1)
        finally:
            if matches(descendant):
                os.kill(descendant["pid"], signal.SIGKILL)
            try:
                os.waitpid(descendant["pid"], 0)
            except ChildProcessError:
                pass

    def test_committed_completion_reaches_watch_when_snapshot_write_fails(self):
        fixture = self.fixture()
        watcher = fixture.spawn_cli("watch", "--consumer", "snapshot-reader")
        monitor = LineReader(watcher)
        job = fixture.blocking("snapshot", 6)
        monitor.take(lambda line: ": 開始;" in line)
        directory = Path(job["log_dir"]).parent
        fixture.daemon.send_signal(signal.SIGSTOP)
        try:
            (fixture.root / "release").touch()
            eventually(lambda: (directory / "result.json").exists())
            self.assertEqual(read_json(directory / "result.json")["exit_code"], 6)
            directory.chmod(0o500)  # 列には書けるが、record.json の原子的な更新はできない。
            fixture.daemon.send_signal(signal.SIGCONT)
            rows = monitor.take(lambda line: ": 終了;" in line)
            self.assertEqual(len(rows), 1)
            self.assertIn("終了コード=6", rows[0])
            seq = int(rows[0].split(" ", 1)[0][1:])
            eventually(lambda: read_json(fixture.state / "consumers.json")["snapshot-reader"]["seq"] == seq)
            eventually(lambda: "記録を更新できません" in (fixture.root / "daemon.log").read_text())
        finally:
            directory.chmod(0o700)
            fixture.daemon.send_signal(signal.SIGCONT)
        fixture.cli("run", "refused-after-snapshot-error", "--", "/bin/true", code=1)
        self.assertEqual(len(list((fixture.state / "jobs").iterdir())), 1)
        watcher.send_signal(signal.SIGINT)
        watcher.wait(timeout=3)
        fixture.halt()
        fixture.start()
        self.assertEqual(fixture.events("--consumer", "snapshot-reader"), [])
        self.assertEqual(sum(event["kind"] == "exited" for event in fixture.events()), 1)

    def test_budget_that_only_fits_acceptance_refuses_launch_before_recording(self):
        fixture = self.fixture()
        fixture.submit("budget", "pass")
        fixture.cli("wait", "budget")
        accepted = fixture.events()[0]
        acceptance_bytes = len((json.dumps(accepted, ensure_ascii=False) + "\n").encode())
        limited = self.fixture(replace(Config(), event_segment_bytes=acceptance_bytes + 32,
                                       event_total_bytes=acceptance_bytes + 32))
        limited.cli("run", "budget", "--cwd", str(limited.root), "--",
                    sys.executable, "-c", "pass", code=1)
        self.assertEqual(json.loads(limited.cli("ls", "--json").stdout), [])
        self.assertEqual(limited.events(), [])
        self.assertEqual(list((limited.state / "jobs").iterdir()), [])

    def test_launch_error_summary_is_bounded_while_stderr_keeps_full_error(self):
        fixture = self.fixture()
        command = "missing-" + "x" * 12000
        fixture.cli("run", "long-error", "--cwd", str(fixture.root), "--", command)
        fixture.cli("wait", "long-error", code=127)
        job = fixture.status("long-error")
        self.assertLessEqual(len(job["error"].encode()), ERROR_BYTES)
        self.assertIn(command, fixture.cli("logs", "long-error", "--stream", "stderr").stdout)
        self.assertEqual([event["kind"] for event in fixture.events()], ["accepted", "failed"])


class ReviewStorageTests(unittest.TestCase):
    def test_group_signal_requires_matching_descendant_identity_boot_and_membership(self):
        leader = {"pid": 101, "start_ticks": 5, "boot_id": "boot"}
        anchor = {"pid": 102, "start_ticks": 6, "boot_id": "boot"}
        current = dict(anchor, pgid=101, session=101, state="S")
        for invalid in (dict(current, start_ticks=7), dict(current, boot_id="other"),
                        dict(current, pgid=103), dict(current, session=103)):
            with self.subTest(invalid=invalid), patch("process.identity", side_effect=lambda pid: invalid if pid == 102 else None), \
                    patch("process.os.killpg") as send_signal:
                self.assertFalse(signal_group(leader, signal.SIGKILL, anchors=[anchor]))
                send_signal.assert_not_called()
        with patch("process.identity", side_effect=lambda pid: current if pid == 102 else None), \
                patch("process.os.killpg") as send_signal:
            self.assertTrue(signal_group(leader, signal.SIGKILL, anchors=[anchor]))
            send_signal.assert_called_once_with(101, signal.SIGKILL)

    def test_started_metadata_preserves_stop_requested_before_start_was_observed(self):
        with tempfile.TemporaryDirectory(prefix=".procd-review-", dir=ROOT) as temporary:
            root = Path(temporary)
            daemon = Daemon(root / "state", Config())
            saved = identity(os.getpid())
            job = {"id": "early-stop", "name": "early-stop", "state": "stopping", "last_seq": 0,
                   "worker": saved, "process": None, "exit_code": None,
                   "stop_request": {"grace_seconds": 1, "requested_at": "now"}}
            directory = daemon.store.directory(job)
            directory.mkdir(mode=0o700)
            daemon.store.save_job(job)
            atomic_json(directory / "started.json", {"process": saved, "started_at": "now", "started_epoch": time.time()})
            try:
                refreshed = daemon.refresh(job)
                self.assertEqual(refreshed["state"], "stopping")
                self.assertEqual(refreshed["process"], saved)
                self.assertEqual([event["kind"] for event in daemon.store.journal.after(0)[1]], ["started"])
                self.assertEqual(read_json(directory / "stop.json"), job["stop_request"])
            finally:
                daemon.store.close()

    def test_failed_journal_refuses_runs_without_allocating_job_records(self):
        with tempfile.TemporaryDirectory(prefix=".procd-review-", dir=ROOT) as temporary:
            root = Path(temporary)
            daemon = Daemon(root / "state", Config())
            try:
                daemon.store.journal.failed = True
                with patch("daemon.subprocess.Popen") as launch:
                    for index in range(3):
                        with self.assertRaises(ProcdError):
                            daemon.run({"name": f"refused{index}", "command": ["/bin/true"],
                                        "env": {}, "cwd": str(root)})
                    launch.assert_not_called()
                self.assertEqual(daemon.store.jobs, {})
                self.assertEqual(list(daemon.store.job_root.iterdir()), [])
            finally:
                daemon.store.close()

    def test_protected_finished_logs_refuse_new_reservation_until_reader_releases(self):
        config = replace(Config(), max_parallel=1, log_bytes=16, log_backups=0,
                         log_total_bytes=32)
        with tempfile.TemporaryDirectory(prefix=".procd-review-", dir=ROOT) as temporary:
            root = Path(temporary)
            daemon = Daemon(root / "state", config)
            job = {"id": "reading", "name": "reading", "state": "exited", "last_seq": 0,
                   "ended_epoch": time.time()}
            directory = daemon.store.directory(job)
            directory.mkdir(mode=0o700)
            (directory / "logs").mkdir(mode=0o700)
            for stream in ("stdout", "stderr"):
                (directory / "logs" / f"{stream}.log").write_bytes(b"x" * 16)
            daemon.store.save_job(job)
            try:
                with daemon.hold_job("reading"):
                    with self.assertRaises(ProcdError):
                        daemon.cleanup(reserve_jobs=1)
                    self.assertEqual(sum(path.stat().st_size for path in directory.glob("logs/*")), 32)
                daemon.cleanup(reserve_jobs=1)
                self.assertEqual(list(directory.glob("logs/*")), [])
            finally:
                daemon.store.close()


class ReviewReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_logs_follow_keeps_record_until_last_output_is_delivered(self):
        class SlowWriter:
            def __init__(self):
                self.rows, self.entered, self.release = [], asyncio.Event(), asyncio.Event()

            def write(self, data):
                self.rows.append(json.loads(data))

            async def drain(self):
                if not self.entered.is_set():
                    self.entered.set()
                    await self.release.wait()

        with tempfile.TemporaryDirectory(prefix=".procd-review-", dir=ROOT) as temporary:
            root = Path(temporary)
            daemon = Daemon(root / "state", replace(Config(), job_retention_seconds=0.001))
            job = {"id": "following", "name": "following", "state": "running", "last_seq": 0,
                   "worker": identity(os.getpid()), "process": None, "exit_code": None,
                   "log_dir": str(daemon.store.job_root / "following" / "logs")}
            directory = daemon.store.directory(job)
            (directory / "logs").mkdir(mode=0o700, parents=True)
            stdout = directory / "logs" / "stdout.log"
            stdout.write_bytes(b"first\n")
            daemon.store.save_job(job)
            writer = SlowWriter()
            task = asyncio.create_task(daemon.logs({"name": "following", "stream": "stdout", "follow": True}, writer))
            try:
                await asyncio.wait_for(writer.entered.wait(), timeout=2)
                with stdout.open("ab") as stream:
                    stream.write(b"second\n")
                atomic_json(directory / "result.json", {"state": "exited", "exit_code": 0,
                    "ended_epoch": time.time() - 1, "ended_at": "now"})
                daemon.refresh(job)
                daemon.cleanup()
                self.assertTrue(stdout.exists())
                writer.release.set()
                await asyncio.wait_for(task, timeout=2)
                data = b"".join(base64.b64decode(row["data"]) for row in writer.rows if "data" in row)
                self.assertEqual(data, b"first\nsecond\n")
                self.assertTrue(writer.rows[-1]["done"])
                daemon.cleanup()
                self.assertNotIn("following", daemon.store.jobs)
            finally:
                writer.release.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                daemon.store.close()

    async def test_wait_receives_exit_code_before_short_retention_removes_record(self):
        with tempfile.TemporaryDirectory(prefix=".procd-review-", dir=ROOT) as temporary:
            root = Path(temporary)
            daemon = Daemon(root / "state", replace(Config(), job_retention_seconds=0.001))
            job = {"id": "waiting", "name": "waiting", "state": "running", "last_seq": 0,
                   "worker": identity(os.getpid()), "process": None, "exit_code": None,
                   "log_dir": str(daemon.store.job_root / "waiting" / "logs")}
            daemon.store.directory(job).mkdir(mode=0o700)
            daemon.store.save_job(job)
            address = "\0procd-review-" + uuid.uuid4().hex
            server = await asyncio.start_unix_server(daemon.client, path=address)
            reader, writer = await asyncio.open_unix_connection(address)
            entered = asyncio.Event()
            original_refresh = daemon.refresh

            def observe_wait(job):
                refreshed = original_refresh(job)
                if refreshed["id"] == "waiting" and refreshed["state"] == "running":
                    entered.set()
                return refreshed

            try:
                with patch.object(daemon, "refresh", side_effect=observe_wait):
                    await send(writer, {"op": "wait", "name": "waiting"})
                    await asyncio.wait_for(entered.wait(), timeout=2)
                atomic_json(daemon.store.directory(job) / "result.json", {
                    "state": "exited", "exit_code": 7, "ended_epoch": time.time() - 1,
                    "ended_at": "2026-09-30T00:00:00+00:00"})
                daemon.refresh(job)
                # 次の run は保存期限の片付けを実行する。待っている CLI への返答より先に行う。
                with patch("daemon.subprocess.Popen", side_effect=OSError(errno.ENOENT, "test worker")):
                    daemon.run({"name": "next", "command": ["/bin/true"], "env": {}, "cwd": str(root)})
                response = await asyncio.wait_for(receive(reader), timeout=2)
                self.assertTrue(response["ok"], response)
                self.assertEqual(response["value"]["exit_code"], 7)
            finally:
                writer.close()
                await writer.wait_closed()
                server.close()
                await server.wait_closed()
                daemon.store.close()


if __name__ == "__main__":
    unittest.main()
