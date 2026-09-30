"""Unix ソケットの受付。列と consumer の状態を更新する唯一の所有者。"""
import asyncio
import base64
from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid

from config import (ACTIVE, ENV_KEY, MAX_STOP_GRACE_SECONDS, POLL_SECONDS, ProcdError, REQUEST_BYTES,
                    START_GRACE_SECONDS, TERMINAL, error_summary, valid_name)
from process import group_has_live_members, group_members, identity, matches, signal_group
from storage import Store, atomic_json, read_json, utc_now


def socket_address(value):
    return "\0" + value[1:] if value.startswith("@") else value


async def send(writer, value):
    writer.write((json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode())
    await writer.drain()


async def receive(reader):
    try:
        line = await reader.readline()
        if not line:
            raise EOFError
        if len(line) > REQUEST_BYTES:
            raise ValueError("入力が大きすぎます")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("入力は JSON のオブジェクトです")
        return value
    except (ValueError, UnicodeError) as exc:
        raise ProcdError(f"入力が不正です: {exc}") from exc


class Daemon:
    def __init__(self, root, config):
        self.config = config
        self.store = Store(root, config)
        self.listeners = set()
        self.leases, self.workers, self.tasks = {}, {}, set()
        self.job_readers, self.orphan_stops = {}, {}
        self.starting_since = {key: time.monotonic() for key in self.store.jobs}
        self.last_cleanup = time.monotonic()
        self.last_error = 0.0

    def task(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def find(self, name):
        valid_name(name)
        for job in self.store.jobs.values():
            if job["name"] == name:
                return job
        raise ProcdError(f"見つかりません: {name}")

    def emit(self, kind, job):
        previous = self.store.journal.seq
        try:
            event = self.store.emit(kind, job)
        finally:
            # 列に確定した後の record.json の失敗でも、読み手にその行を届ける。
            events = self.store.journal.events
            if events and events[-1]["seq"] > previous:
                committed = events[-1]
                for wake in self.listeners:
                    wake.set()
                if committed["job"]["state"] in TERMINAL and self.config.notify_command:
                    self.task(self.notify(committed))
        return event["job"]

    @contextmanager
    def hold_job(self, name):
        job = self.find(name)
        key = job["id"]
        self.job_readers[key] = self.job_readers.get(key, 0) + 1
        try:
            yield job
        finally:
            self.job_readers[key] -= 1
            if not self.job_readers[key]:
                del self.job_readers[key]

    def cleanup(self, reserve_jobs=0):
        self.store.cleanup(protected_consumers=set(self.leases),
                           protected_jobs=set(self.job_readers), reserve_jobs=reserve_jobs)
        self.starting_since = {key: value for key, value in self.starting_since.items()
                               if key in self.store.jobs}

    def run(self, request):
        name = valid_name(request.get("name"))
        self.store.journal.require_writable()
        if any(job["name"] == name for job in self.store.jobs.values()):
            raise ProcdError(f"この名前は既にあります: {name}")
        if sum(job["state"] in ACTIVE for job in self.store.jobs.values()) >= self.config.max_parallel:
            raise ProcdError("同時実行の上限に達しました")
        command, env, cwd = request.get("command"), request.get("env", {}), request.get("cwd")
        if (not isinstance(command, list) or not command or not all(
                isinstance(arg, str) and "\0" not in arg for arg in command)):
            raise ProcdError("コマンドは空でない文字列の配列で指定してください")
        if (not isinstance(env, dict) or not all(isinstance(key, str) and ENV_KEY.fullmatch(key)
                and isinstance(value, str) and "\0" not in value for key, value in env.items())):
            raise ProcdError("環境変数は K=V の形で指定してください")
        if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
            raise ProcdError("作業場所は存在する絶対パスで指定してください")
        if len(json.dumps({"command": command, "env": env}).encode()) > REQUEST_BYTES // 4:
            raise ProcdError("コマンドと環境変数が大きすぎます")
        job_id = uuid.uuid4().hex
        directory = self.store.job_root / job_id
        merged = dict(os.environ, **env)
        job = {"id": job_id, "name": name, "state": "starting", "command": command,
               "cwd": cwd, "env_summary": {"override_keys": sorted(env),
                   "inherited_key_count": len(os.environ),
                   **{key: merged[key] for key in ("PATH", "LANG", "LC_ALL", "TZ") if key in merged}},
               "accepted_at": utc_now(), "accepted_epoch": time.time(),
               "log_dir": str(directory / "logs"), "process": None,
               "worker": None, "exit_code": None, "last_seq": 0}
        self.store.journal.check_job_size(job)
        self.cleanup(reserve_jobs=1)
        directory.mkdir(mode=0o700)
        try:
            atomic_json(directory / "spec.json", {"command": command, "env": env, "cwd": cwd,
                                                  "config": asdict(self.config)})
            self.store.save_job(job)
            job = self.emit("accepted", job)  # 保存できなければ起動しない。
        except (OSError, ProcdError):
            recorded = self.store.jobs.get(job_id, {}).get("last_seq", 0)
            if not recorded and not self.store.journal.failed:
                self.store.jobs.pop(job_id, None)
                shutil.rmtree(directory)
            # 列の保存が途中で失敗した場合は、不確かな受付を再起動時に照合する。
            raise
        try:
            worker = subprocess.Popen([sys.executable, str(Path(__file__).with_name("runner.py")),
                                       str(directory)], start_new_session=True,
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, close_fds=True)
        except OSError as exc:
            return self.emit("failed", dict(job, state="failed", exit_code=127,
                ended_at=utc_now(), ended_epoch=time.time(), error=error_summary(exc)))
        self.workers[job_id] = worker
        self.starting_since[job_id] = time.monotonic()
        job = dict(job, worker=identity(worker.pid))
        self.store.save_job(job)
        return job

    def refresh(self, job):
        if job["state"] not in ACTIVE:
            return job
        directory = self.store.directory(job)
        started = read_json(directory / "started.json")
        worker = read_json(directory / "worker.json") or job.get("worker")
        result = read_json(directory / "result.json")
        if started and "started_at" not in job:
            state = "running" if job["state"] == "starting" else job["state"]
            job = self.emit("started", dict(job, **started, worker=worker, state=state))
        if result:
            return self.emit(result["state"], dict(job, **result, worker=worker))
        if matches(worker):
            if job["state"] == "stopping":
                self.ensure_stop(job)
            return job
        anchors = read_json(directory / "stop-members.json", []) if job["state"] == "stopping" else []
        if (matches(job.get("process")) or (job["state"] == "stopping"
                and group_has_live_members(job.get("process"), anchors=anchors))):
            if job["state"] not in {"orphaned", "stopping"}:
                job = self.emit("orphaned", dict(job, state="orphaned", worker=worker,
                                               error="実行係が見つかりません"))
            if job["state"] == "stopping":
                self.ensure_orphan_stop(job)
            return job
        if job["state"] == "starting":
            since = self.starting_since.setdefault(job["id"], time.monotonic())
            if time.monotonic() - since < START_GRACE_SECONDS:
                return job
        return self.emit("lost", dict(job, state="lost", worker=worker, exit_code=None,
            ended_at=utc_now(), ended_epoch=time.time(), error="照合できるプロセスと終了結果がありません"))

    def ensure_stop(self, job):
        self.retain_stop_members(job)
        path = self.store.directory(job) / "stop.json"
        if read_json(path) != job["stop_request"]:
            atomic_json(path, job["stop_request"])

    def retain_stop_members(self, job):
        path = self.store.directory(job) / "stop-members.json"
        previous = read_json(path, [])
        members = [{key: value for key, value in member.items() if key != "state"}
                   for member in group_members(job.get("process"), anchors=previous)]
        if members and members != previous:
            atomic_json(path, members)
        return members or previous

    def stop(self, name, grace):
        job = self.refresh(self.find(name))
        if job["state"] not in ACTIVE:
            return job
        if (isinstance(grace, bool) or not isinstance(grace, (int, float))
                or not 0 <= grace <= MAX_STOP_GRACE_SECONDS):
            raise ProcdError(f"停止の猶予は0〜{MAX_STOP_GRACE_SECONDS}秒で指定してください")
        if job["state"] != "stopping":
            job = self.emit("stopping", dict(job, state="stopping", stop_request={
                "grace_seconds": grace, "requested_at": utc_now()}))
        self.ensure_stop(job)
        if not matches(read_json(self.store.directory(job) / "worker.json") or job.get("worker")):
            self.ensure_orphan_stop(job)
        return job

    def ensure_orphan_stop(self, job):
        key = job["id"]
        anchors = self.retain_stop_members(job)
        if key not in self.orphan_stops:
            task = self.task(self.stop_orphan(job, anchors))
            self.orphan_stops[key] = task
            task.add_done_callback(lambda _: self.orphan_stops.pop(key, None))

    async def stop_orphan(self, job, anchors):
        if not signal_group(job.get("process"), signal.SIGTERM, anchors=anchors):
            return
        await asyncio.sleep(job["stop_request"]["grace_seconds"])
        anchors = read_json(self.store.directory(job) / "stop-members.json", anchors)
        signal_group(job.get("process"), signal.SIGKILL, anchors=anchors)
        # 実行係を失ったときの終了コードは推測しない。refresh が lost を記録する。

    async def monitor(self):
        while True:
            try:
                for key, worker in list(self.workers.items()):
                    if worker.poll() is not None:
                        del self.workers[key]
                for job in list(self.store.jobs.values()):
                    self.refresh(job)
                if time.monotonic() - self.last_cleanup >= self.config.cleanup_interval_seconds:
                    self.cleanup()
                    self.last_cleanup = time.monotonic()
            except (OSError, ProcdError, ValueError) as exc:
                if time.monotonic() - self.last_error >= 5:
                    print(f"記録を更新できません（結果は保持します）: {exc}", file=sys.stderr, flush=True)
                    self.last_error = time.monotonic()
            await asyncio.sleep(POLL_SECONDS)

    async def notify(self, event):
        process = None
        saved = None
        try:
            job = event["job"]
            values = {"name": job["name"], "state": job["state"], "seq": str(event["seq"]),
                      "exit_code": str(job["exit_code"]), "log_dir": job["log_dir"]}
            command = [arg.format_map(values) for arg in self.config.notify_command]
            process = await asyncio.create_subprocess_exec(*command, start_new_session=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=dict(os.environ, PROCD_EVENT=json.dumps(event, ensure_ascii=False)))
            saved = identity(process.pid)
            code = await asyncio.wait_for(process.wait(), self.config.notify_timeout_seconds)
            if code:
                raise ProcdError(f"通知コマンドの終了コード: {code}")
        except (OSError, ValueError, KeyError, ProcdError, asyncio.TimeoutError) as exc:
            print(f"通知できません（出来事は保存済み）: {exc}", file=sys.stderr, flush=True)
        finally:
            if process and process.returncode is None:
                signal_group(saved, signal.SIGKILL)
                await process.wait()

    async def feed(self, request, reader, writer):
        consumer = request.get("consumer")
        ack = request.get("ack", False) or request["op"] == "watch"
        if consumer:
            valid_name(consumer)
        if request.get("ack") and not consumer and request["op"] != "watch":
            raise ProcdError("既読にするには consumer を指定してください")
        since = request.get("since")
        if since is None:
            since = self.store.cursor(consumer) if consumer else 0
        if isinstance(since, bool) or not isinstance(since, int) or since < 0:
            raise ProcdError("since は0以上の整数です")
        lease = consumer if consumer and ack else None
        if lease:
            if lease in self.leases:
                raise ProcdError(f"この consumer は別の読み取りで使用中です: {lease}")
            self.store.acknowledge(lease, self.store.cursor(lease))
            self.leases[lease] = writer
        wake = asyncio.Event()
        self.listeners.add(wake)
        try:
            while True:
                wake.clear()
                gap, events = self.store.journal.after(since)
                rows = ([{"kind": "gap", "seq": gap["to"], **gap}] if gap else []) + events
                for event in rows:
                    await send(writer, {"ok": True, "event": event})
                    if lease:
                        response = await receive(reader)
                        if response != {"ack": event["seq"]}:
                            raise ProcdError("既読の返答が不正です")
                        self.store.acknowledge(lease, event["seq"])
                        await send(writer, {"ok": True, "acked": event["seq"]})
                    since = event["seq"]
                if request["op"] != "watch":
                    await send(writer, {"ok": True, "done": True})
                    return
                # 接続が閉じたことも見張り、出来事が無くても lease を解放する。
                change = asyncio.create_task(wake.wait())
                disconnect = asyncio.create_task(reader.read(1))
                try:
                    done, _ = await asyncio.wait({change, disconnect},
                                                      return_when=asyncio.FIRST_COMPLETED)
                    if disconnect in done:
                        return
                finally:
                    for task in (change, disconnect):
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(change, disconnect, return_exceptions=True)
        finally:
            self.listeners.discard(wake)
            if lease:
                self.leases.pop(lease, None)

    async def logs(self, request, writer):
        with self.hold_job(request.get("name")) as job:
            await self.read_logs(job, request, writer)

    async def read_logs(self, job, request, writer):
        stream = request.get("stream", "both")
        if stream not in {"both", "stdout", "stderr"}:
            raise ProcdError("ログは stdout・stderr・both のどれかです")
        seen = {}
        final_pass = False
        while True:
            visible = set()
            for key in ("stdout", "stderr"):
                if stream != "both" and key != stream:
                    continue
                paths = list(Path(job["log_dir"]).glob(f"{key}.log*"))
                paths.sort(key=lambda path: -(int(path.suffix[1:]) if path.suffix[1:].isdigit() else 0))
                for path in paths:
                    try:
                        with path.open("rb") as data:
                            details = os.fstat(data.fileno())
                            inode = (details.st_dev, details.st_ino)
                            visible.add(inode)
                            offset = seen.get(inode, 0)
                            if details.st_size < offset:
                                offset = 0
                            data.seek(offset)
                            while chunk := data.read(16384):
                                await send(writer, {"ok": True, "stream": key,
                                    "data": base64.b64encode(chunk).decode()})
                            seen[inode] = data.tell()
                    except FileNotFoundError:
                        continue  # 世代交代・保存期限との競合。
            seen = {inode: offset for inode, offset in seen.items() if inode in visible}
            job = self.refresh(self.find(job["name"]))
            if request.get("follow") and job["state"] not in ACTIVE and not final_pass:
                final_pass = True
                continue  # 結果が保存された後のログを、もう一度最後まで読む。
            if not request.get("follow") or final_pass:
                await send(writer, {"ok": True, "done": True, "logs_removed": job.get("logs_removed", False)})
                return
            await asyncio.sleep(POLL_SECONDS)

    async def client(self, reader, writer):
        try:
            credentials = writer.get_extra_info("socket").getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            if struct.unpack("3i", credentials)[1] != os.getuid():
                raise ProcdError("同じユーザーからの接続だけを受け付けます")
            request = await asyncio.wait_for(receive(reader), timeout=10)
            op = request.get("op")
            if op in {"events", "watch"}:
                await self.feed(request, reader, writer)
                return
            if op == "logs":
                await self.logs(request, writer)
                return
            if op == "ping":
                value = {"pid": os.getpid(), "seq": self.store.journal.seq}
            elif op == "run":
                value = self.run(request)
            elif op == "ls":
                for job in list(self.store.jobs.values()):
                    await send(writer, {"ok": True, "job": job})
                await send(writer, {"ok": True, "done": True})
                return
            elif op == "status":
                value = self.refresh(self.find(request.get("name")))
            elif op == "wait":
                with self.hold_job(request.get("name")) as job:
                    job = self.refresh(job)
                    while job["state"] in ACTIVE:
                        await asyncio.sleep(POLL_SECONDS)
                        job = self.refresh(self.store.jobs[job["id"]])
                    value = job
            elif op == "stop":
                value = self.stop(request.get("name"), request.get("grace", self.config.stop_grace_seconds))
            else:
                raise ProcdError("不明な操作です")
            await send(writer, {"ok": True, "value": value})
        except (ProcdError, OSError, ValueError, asyncio.TimeoutError) as exc:
            try:
                await send(writer, {"ok": False, "error": str(exc)})
            except (OSError, ConnectionError):
                pass
        except (EOFError, ConnectionError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (OSError, ConnectionError):
                pass

    async def serve(self, address):
        path = None if address.startswith("@") else Path(address)
        if path and path.exists():
            details = path.lstat()
            if not stat.S_ISSOCK(details.st_mode) or details.st_uid != os.getuid():
                raise ProcdError("ソケットの場所に別のファイルがあります")
            probe = socket.socket(socket.AF_UNIX)
            try:
                probe.connect(str(path))
            except ConnectionRefusedError:
                path.unlink()
            else:
                raise ProcdError("このソケットでは常駐が既に動いています")
            finally:
                probe.close()
        server = await asyncio.start_unix_server(self.client, path=socket_address(address),
                                                limit=REQUEST_BYTES + 1)
        if path:
            path.chmod(0o600)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        self.task(self.monitor())
        try:
            async with server:
                await stop.wait()
        finally:
            for task in list(self.tasks):
                task.cancel()
            await asyncio.gather(*list(self.tasks), return_exceptions=True)
            if path:
                path.unlink(missing_ok=True)
            self.store.close()
