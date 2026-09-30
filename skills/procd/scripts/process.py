"""Linux の PID を開始時刻と起動 ID で照合する。"""
import os
from pathlib import Path


def _stat_fields(pid):
    stat = Path(f"/proc/{pid}/stat").read_text()
    return stat[stat.rfind(")") + 2:].split()


def identity(pid):
    try:
        fields = _stat_fields(int(pid))
        return {
            "pid": int(pid),
            "start_ticks": int(fields[19]),
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "state": fields[0],
            "pgid": int(fields[2]),
            "session": int(fields[3]),
        }
    except (OSError, ValueError, IndexError):
        return None


def _same_process(saved, current, *, zombie=False):
    return bool(saved and current and all(current[key] == saved.get(key) for key in
                                         ("pid", "start_ticks", "boot_id"))
                and (zombie or current["state"] not in {"Z", "X"}))


def matches(saved, *, zombie=False):
    if not saved:
        return False
    current = identity(saved.get("pid", -1))
    return _same_process(saved, current, zombie=zombie)


def _group_matches(saved, anchors):
    if matches(saved, zombie=True):
        return True
    for anchor in anchors:
        if anchor.get("boot_id") != saved.get("boot_id"):
            continue
        current = identity(anchor.get("pid", -1))
        if (_same_process(anchor, current) and current["pgid"] == saved["pid"]
                and current["session"] == saved["pid"]):
            return True
    return False


def signal_group(saved, sig, *, anchors=()):
    # WNOWAIT で子を回収前に保つ実行係からは、ゾンビも識別できる。
    if not saved or not _group_matches(saved, anchors):
        return False
    try:
        os.killpg(saved["pid"], sig)
        return True
    except ProcessLookupError:
        return False


def exit_observed(pid):
    # 回収を後にすることで、残った同じグループへ安全に停止を送れる。
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def group_members(saved, *, anchors=()):
    if not saved or not _group_matches(saved, anchors):
        return []
    members = []
    for path in Path("/proc").iterdir():
        if not path.name.isdecimal():
            continue
        try:
            fields = _stat_fields(int(path.name))
            if int(fields[2]) == saved["pid"] and fields[0] not in {"Z", "X"}:
                current = identity(int(path.name))
                if (current and current["pgid"] == saved["pid"]
                        and current["session"] == saved["pid"] and current["state"] not in {"Z", "X"}):
                    members.append(current)
        except (OSError, ValueError, IndexError):
            continue
    return members


def group_has_live_members(saved, *, anchors=()):
    return bool(group_members(saved, anchors=anchors))
