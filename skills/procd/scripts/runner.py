"""一つのコマンドを預かる実行係。常駐の終了後も動く。"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from config import Config, POLL_SECONDS, error_summary
from process import exit_observed, group_has_live_members, identity, signal_group
from storage import atomic_json, read_json, utc_now


class RotatingLog:
    def __init__(self, path, limit, backups):
        self.path, self.limit, self.backups = Path(path), limit, backups
        self.stream = self.path.open("ab", buffering=0)
        self.size = self.path.stat().st_size

    def rotate(self):
        self.stream.close()
        if self.backups:
            for index in range(self.backups, 0, -1):
                source = self.path if index == 1 else Path(f"{self.path}.{index - 1}")
                if source.exists():
                    os.replace(source, Path(f"{self.path}.{index}"))
        else:
            self.path.unlink(missing_ok=True)
        self.stream = self.path.open("wb", buffering=0)
        self.size = 0

    def write(self, data):
        while data:
            if self.size == self.limit:
                self.rotate()
            piece, data = data[:self.limit - self.size], data[self.limit - self.size:]
            view = memoryview(piece)
            while view:
                written = self.stream.write(view)
                if not written:
                    raise OSError("ログを書き込めません")
                self.size += written
                view = view[written:]

    def close(self):
        self.stream.close()


def _drain(pipe, log, errors):
    try:
        while data := os.read(pipe.fileno(), 65536):
            log.write(data)
    except OSError as exc:
        # 保存先が満杯でもパイプを排水し、コマンドを出力待ちにしない。
        errors.append(error_summary(exc))
        try:
            while os.read(pipe.fileno(), 65536):
                pass
        except OSError:
            pass
    finally:
        log.close()


def run(directory):
    os.umask(0o077)
    directory = Path(directory)
    spec = read_json(directory / "spec.json")
    config = Config(**spec["config"])
    atomic_json(directory / "worker.json", identity(os.getpid()))
    logs = directory / "logs"
    logs.mkdir(mode=0o700, exist_ok=True)
    output = {key: RotatingLog(logs / f"{key}.log", config.log_bytes, config.log_backups)
              for key in ("stdout", "stderr")}
    env = dict(os.environ, **spec["env"])
    env["PWD"] = spec["cwd"]
    try:
        process = subprocess.Popen(spec["command"], cwd=spec["cwd"], env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True,
                                   close_fds=True, bufsize=0)
    except (OSError, ValueError) as exc:
        output["stderr"].write((str(exc) + "\n").encode())
        for log in output.values():
            log.close()
        atomic_json(directory / "result.json", {
            "state": "failed", "exit_code": 127, "ended_at": utc_now(),
            "ended_epoch": time.time(), "error": error_summary(exc),
        })
        return
    saved = identity(process.pid)
    try:
        atomic_json(directory / "started.json", {
            "process": saved, "started_at": utc_now(), "started_epoch": time.time(),
        })
    except OSError:
        signal_group(saved, signal.SIGKILL)
        process.wait()
        for log in output.values():
            log.close()
        raise
    errors, readers = [], []
    for key, pipe in (("stdout", process.stdout), ("stderr", process.stderr)):
        thread = threading.Thread(target=_drain, args=(pipe, output[key], errors), daemon=True)
        thread.start()
        readers.append(thread)
    stop_at, stopping, forced = None, False, False
    while True:
        if exit_observed(process.pid):
            break
        request = read_json(directory / "stop.json")
        if request and not stopping:
            stopping = signal_group(saved, signal.SIGTERM)
            if stopping:
                stop_at = time.monotonic() + request["grace_seconds"]
        if stop_at is not None and time.monotonic() >= stop_at and not forced:
            forced = signal_group(saved, signal.SIGKILL)
        time.sleep(POLL_SECONDS)
    # 子の pid を回収する前に、同じグループに残った子孫も片付ける。
    if group_has_live_members(saved):
        signal_group(saved, signal.SIGTERM)
        deadline = stop_at if stopping else time.monotonic() + 0.2
        while time.monotonic() < deadline and group_has_live_members(saved):
            time.sleep(POLL_SECONDS)
        if group_has_live_members(saved):
            sent = signal_group(saved, signal.SIGKILL)
            forced = forced or (stopping and sent)
    code = process.wait()
    for thread in readers:
        thread.join(timeout=1)
    result = {"state": "stopped" if stopping else "exited", "exit_code": code,
              "ended_at": utc_now(), "ended_epoch": time.time(),
              "forced": forced}
    if errors:
        result["log_error"] = errors[0]
    atomic_json(directory / "result.json", result)


if __name__ == "__main__":
    run(sys.argv[1])
