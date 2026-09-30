"""永続化。イベントの行は変更せず、閉じた区間だけを削除する。"""
from collections import deque
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

from config import ACTIVE, EVENT_GROWTH_BYTES, ProcdError


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def atomic_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except FileNotFoundError:
        return default


class Journal:
    def __init__(self, root, config):
        self.root, self.config = Path(root), config
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.meta_path = self.root / "sequence.json"
        meta = read_json(self.meta_path, {"seq": 0, "pruned_through": 0})
        self.seq, self.floor = meta["seq"], meta["pruned_through"]
        self.events = deque()
        self.failed = False
        self.active = None
        self.segments = []
        previous = 0
        paths = sorted(self.root.glob("events-*.jsonl"))
        for path in paths:
            last, complete = 0, True
            with path.open("rb") as stream:
                lines = stream.readlines()
            for index, line in enumerate(lines):
                try:
                    if not line.endswith(b"\n"):
                        raise ValueError("途切れた行")
                    event = json.loads(line)
                    seq = event["seq"]
                    if not isinstance(seq, int) or seq <= previous:
                        raise ProcdError(f"イベントの番号が不正です: {path.name}")
                except (ValueError, KeyError) as exc:
                    if index != len(lines) - 1 or (path != paths[-1] and ".partial." not in path.name):
                        raise ProcdError(f"イベントの途中が壊れています: {path.name}") from exc
                    complete = False
                    break
                previous = last = seq
                if seq > self.floor:
                    self.events.append(event)
            self.seq = max(self.seq, last)
            if not complete and ".partial." not in path.name:
                sealed = path.with_name(path.stem + ".partial.jsonl")
                path.rename(sealed)
                path = sealed
            self.segments.append([path, last])
            if complete and path == paths[-1] and ".partial." not in path.name:
                self.active = path
        self._meta()

    def _meta(self):
        atomic_json(self.meta_path, {"seq": self.seq, "pruned_through": self.floor})

    def require_writable(self):
        if self.failed:
            raise ProcdError("イベントの保存に失敗しました。保存先を直して常駐を再起動してください")

    def prepare(self, kind, job):
        seq = self.seq + 1
        job = dict(job, last_seq=seq)
        event = {"seq": seq, "time": utc_now(), "kind": kind, "job": job}
        encoded = (json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n").encode()
        return event, encoded

    def check_job_size(self, job):
        _, encoded = self.prepare("accepted", job)
        if len(encoded) + EVENT_GROWTH_BYTES > self.config.event_total_bytes:
            raise ProcdError("開始・終了の記録を収めるにはイベントの保存上限が足りません")

    def append(self, kind, job):
        self.require_writable()
        event, encoded = self.prepare(kind, job)
        seq = event["seq"]
        if len(encoded) > self.config.event_total_bytes:
            raise ProcdError("1件の出来事が保存上限を超えます")
        self.seq = seq
        try:
            self._meta()  # 書き込み失敗でも、この番号は再利用しない。
        except OSError:
            self.failed = True
            raise
        if (self.active is None or self.active.stat().st_size + len(encoded)
                > self.config.event_segment_bytes):
            self.active = self.root / f"events-{seq:020d}.jsonl"
            self.segments.append([self.active, 0])
        try:
            with self.active.open("ab", buffering=0) as stream:
                view = memoryview(encoded)
                while view:
                    written = stream.write(view)
                    if not written:
                        raise OSError("イベントを書き込めません")
                    view = view[written:]
                os.fsync(stream.fileno())
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            self.active = None  # 途切れた末尾に次の行をつながない。
            self.failed = True
            raise
        self.segments[-1][1] = seq
        self.events.append(event)
        # append が確定した後の片付け失敗は、新しい出来事を二度書く理由にしない。
        try:
            self.prune()
        except OSError:
            self.failed = True  # 片付けできないまま新しい区間を増やし続けない。
        return event

    def prune(self, now=None):
        now = time.time() if now is None else now
        total = sum(path.stat().st_size for path, _ in self.segments if path.exists())
        while len(self.segments) > 1:
            path, last = self.segments[0]
            old = now - path.stat().st_mtime >= self.config.event_retention_seconds
            if not old and total <= self.config.event_total_bytes:
                break
            size = path.stat().st_size
            self.floor = max(self.floor, last)
            self._meta()
            path.unlink()
            self.segments.pop(0)
            total -= size
        while self.events and self.events[0]["seq"] <= self.floor:
            self.events.popleft()

    def after(self, seq):
        gap = {"from": seq + 1, "to": self.floor} if seq < self.floor else None
        if not self.events or seq >= self.events[-1]["seq"]:
            return gap, []
        return gap, [event for event in self.events if event["seq"] > max(seq, self.floor)]


class Store:
    def __init__(self, root, config):
        self.root, self.config = Path(root), config
        if self.root.is_symlink():
            raise ProcdError("保存先にはシンボリックリンクを使えません")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.stat().st_uid != os.getuid() or self.root.stat().st_mode & 0o077:
            raise ProcdError("保存先は自分が所有する0700の専用ディレクトリにしてください")
        self.lock = (self.root / "daemon.lock").open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.lock.close()
            raise ProcdError("この保存先では常駐が既に動いています") from exc
        self.job_root = self.root / "jobs"
        self.job_root.mkdir(mode=0o700, exist_ok=True)
        self.journal = Journal(self.root / "events", config)
        self.cursor_path = self.root / "consumers.json"
        self.consumers = read_json(self.cursor_path, {})
        self.jobs = {}
        for path in self.job_root.glob("*/record.json"):
            job = read_json(path)
            self.jobs[job["id"]] = job
        # append と record.json の更新の間に落ちても、列から状態を復元する。
        for event in self.journal.events:
            job = event["job"]
            old = self.jobs.get(job["id"])
            if old and event["seq"] > old.get("last_seq", 0):
                self.save_job(dict(job, last_seq=event["seq"]))

    def directory(self, job):
        return self.job_root / job["id"]

    def save_job(self, job):
        atomic_json(self.directory(job) / "record.json", job)
        self.jobs[job["id"]] = job

    def emit(self, kind, job):
        event = self.journal.append(kind, job)
        # 列が正本。record の更新失敗でも、同じ終端を再度 append しない。
        self.jobs[job["id"]] = event["job"]
        try:
            self.save_job(event["job"])
        except OSError:
            # 状態を復元する前に、この確定行が次の追記で削除されるのを防ぐ。
            self.journal.failed = True
            raise
        return event

    def cursor(self, consumer):
        return self.consumers.get(consumer, {}).get("seq", 0)

    def acknowledge(self, consumer, seq):
        if consumer not in self.consumers and len(self.consumers) >= self.config.max_consumers:
            raise ProcdError("既読の保存先の数が上限に達しました")
        if seq > self.journal.seq or seq < 0:
            raise ProcdError("既読の番号が不正です")
        updated = dict(self.consumers)
        updated[consumer] = {"seq": max(self.cursor(consumer), seq), "updated": time.time()}
        atomic_json(self.cursor_path, updated)
        self.consumers = updated

    def cleanup(self, now=None, protected_consumers=(), protected_jobs=(), reserve_jobs=0):
        now = time.time() if now is None else now
        finished = sorted((job for job in self.jobs.values() if job["state"] not in ACTIVE),
                          key=lambda job: job["ended_epoch"])
        for index, job in enumerate(finished):
            if job["id"] in protected_jobs:
                continue
            if (now - job["ended_epoch"] >= self.config.job_retention_seconds
                    or len(finished) - index > self.config.max_finished_jobs):
                shutil.rmtree(self.directory(job))
                del self.jobs[job["id"]]
        # 実行中のログが今後伸びても合計枠を越えないよう、最大世代分を予約する。
        active_count = sum(job["state"] in ACTIVE for job in self.jobs.values()) + reserve_jobs
        total = active_count * 2 * self.config.log_bytes * (self.config.log_backups + 1)
        total += sum(path.stat().st_size for job in finished if job["id"] in self.jobs
                     for path in (self.directory(job) / "logs").glob("*.log*"))
        for job in finished:
            if total <= self.config.log_total_bytes:
                break
            if job["id"] not in self.jobs or job["id"] in protected_jobs:
                continue
            for path in (self.directory(job) / "logs").glob("*.log*"):
                total -= path.stat().st_size
                path.unlink()
            self.save_job(dict(job, logs_removed=True))
        if reserve_jobs and total > self.config.log_total_bytes:
            raise ProcdError("読み取り中のログを保持するとログの合計上限を超えます")
        retained = {key: value for key, value in self.consumers.items()
                    if key in protected_consumers or
                    now - value["updated"] < self.config.consumer_retention_seconds}
        if retained != self.consumers:
            atomic_json(self.cursor_path, retained)
            self.consumers = retained
        self.journal.prune(now)

    def close(self):
        self.lock.close()
