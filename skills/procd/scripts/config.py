"""設定と、入口で共有する小さな契約。外部依存はない。"""
from dataclasses import asdict, dataclass
import json
import math
import re


class ProcdError(Exception):
    pass


ACTIVE = frozenset({"starting", "running", "stopping", "orphaned"})
TERMINAL = frozenset({"exited", "failed", "stopped", "lost"})
REQUEST_BYTES = 65536
ERROR_BYTES = 256
# 開始・停止・終端の識別情報と、上限付きのエラーが後から加わる保存枠。
EVENT_GROWTH_BYTES = 4096
POLL_SECONDS = 0.05
START_GRACE_SECONDS = 5.0
MAX_STOP_GRACE_SECONDS = 300
NAME = re.compile(r"[\w][\w.-]{0,63}\Z", re.UNICODE)
ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def valid_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise ProcdError("名前は英数字・日本語・_・.・-の64文字以内で指定してください")
    return value


def wait_code(job):
    code = job.get("exit_code")
    if code is None:
        return 125
    return min(code, 255) if code >= 0 else min(128 - code, 255)


def error_summary(error):
    return str(error).encode("utf-8")[:ERROR_BYTES].decode("utf-8", errors="ignore")


@dataclass(frozen=True)
class Config:
    log_bytes: int = 1048576
    log_backups: int = 3
    log_total_bytes: int = 268435456
    event_segment_bytes: int = 1048576
    event_total_bytes: int = 16777216
    job_retention_seconds: float = 604800
    event_retention_seconds: float = 2592000
    consumer_retention_seconds: float = 2592000
    max_finished_jobs: int = 1000
    max_consumers: int = 256
    max_parallel: int = 16
    stop_grace_seconds: float = 3.0
    cleanup_interval_seconds: float = 5.0
    notify_timeout_seconds: float = 5.0
    notify_command: tuple = ()

    @classmethod
    def load(cls, path=None):
        if path is None:
            return cls()
        try:
            with open(path, encoding="utf-8") as stream:
                values = json.load(stream)
            if not isinstance(values, dict) or set(values) - set(asdict(cls())):
                raise ValueError("未知の設定項目があります")
            config = cls(**values)
            for key, default in asdict(cls()).items():
                value = getattr(config, key)
                if key == "notify_command":
                    if not isinstance(value, (list, tuple)) or not all(
                        isinstance(arg, str) and "\0" not in arg for arg in value
                    ):
                        raise ValueError("notify_command は文字列の配列です")
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"{key} は数値です")
                if isinstance(default, int) and not isinstance(value, int):
                    raise ValueError(f"{key} は整数です")
                if value < (0 if key in {"log_backups", "stop_grace_seconds"} else 0.001):
                    raise ValueError(f"{key} の値が小さすぎます")
                if not math.isfinite(value):
                    raise ValueError(f"{key} は有限の数です")
            if config.event_segment_bytes > config.event_total_bytes:
                raise ValueError("イベントの区間は合計の上限以下にしてください")
            live_logs = config.max_parallel * 2 * config.log_bytes * (config.log_backups + 1)
            if live_logs > config.log_total_bytes:
                raise ValueError("ログの合計上限には同時実行分の保存枠が必要です")
            if config.stop_grace_seconds > MAX_STOP_GRACE_SECONDS:
                raise ValueError(f"停止の猶予は{MAX_STOP_GRACE_SECONDS}秒以下にしてください")
            return config
        except (OSError, ValueError, TypeError) as exc:
            raise ProcdError(f"設定を読めません: {exc}") from exc
