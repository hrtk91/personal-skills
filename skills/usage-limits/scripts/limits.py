#!/usr/bin/env python3
"""Claude と Codex の使用量の残りを確かめる。

使い方:
  limits.py check            両方を見て、1 行の判定（OK / WARN / HANDOFF）を出す。終了コード 0=OK 1=WARN 2=HANDOFF 3=不明
  limits.py codex [--json]   Codex の直近の記録から、使用率・窓・リセット時刻
  limits.py claude [--json]  Claude の使用率（statusline が書いた控えを読む。控えが無い・古いときは不明）

しきい値（環境変数）:
  LIMITS_CLAUDE_HANDOFF_PERCENT   Claude の残りがこれ以下で HANDOFF（既定 5）
  LIMITS_WARN_PERCENT             残りがこれ以下で WARN（既定 15）
  LIMITS_CLAUDE_STALE_MINUTES     Claude の控えがこれより古いと不明（既定 30）

Codex は、リセット券で回復できる前提（このスキルの運用前提）なので、残りが少なくても HANDOFF にしない。
警告（WARN）に、リセット券を使う目安を添えるだけ。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from pathlib import Path

CLAUDE_SNAPSHOT = Path(os.environ.get("LIMITS_CLAUDE_SNAPSHOT", Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "limits/claude.json"))
CODEX_SESSIONS = Path(os.environ.get("LIMITS_CODEX_SESSIONS", Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"))


def _envf(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _fmt_reset(epoch) -> str:
    if not epoch:
        return "不明"
    return time.strftime("%m/%d %H:%M", time.localtime(float(epoch)))


def read_codex(now: float | None = None, max_files: int = 6) -> dict:
    """最近更新された Codex のセッション記録から、いちばん新しい rate_limits を拾う。"""
    now = now or time.time()
    files = sorted(glob.glob(str(CODEX_SESSIONS / "**/*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)[:max_files]
    best = None
    for path in files:
        try:
            lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            payload = obj.get("payload") or {}
            limits = payload.get("rate_limits") or (payload.get("info") or {}).get("rate_limits")
            if not limits:
                continue
            if best is None or os.path.getmtime(path) > best[0]:
                best = (os.path.getmtime(path), limits, path)
            break
        if best:
            break
    if not best:
        return {"source": "codex", "known": False, "reason": "記録が見つからない"}
    mtime, limits, path = best
    windows = []
    for key in ("primary", "secondary"):
        w = limits.get(key)
        if w:
            windows.append({"name": key, "used_percent": float(w.get("used_percent", 0)),
                            "window_minutes": w.get("window_minutes"), "resets_at": w.get("resets_at"),
                            "resets": _fmt_reset(w.get("resets_at"))})
    worst = max((w["used_percent"] for w in windows), default=None)
    return {"source": "codex", "known": worst is not None, "windows": windows,
            "remaining_percent": None if worst is None else round(100 - worst, 1),
            "credits": limits.get("credits"), "plan": limits.get("plan_type"),
            "reached": limits.get("rate_limit_reached_type"),
            "age_minutes": round((now - mtime) / 60, 1), "file": path}


def read_claude(now: float | None = None) -> dict:
    """statusline が書き出した控え（LIMITS_CLAUDE_SNAPSHOT または標準のstate保存先）を読む。"""
    now = now or time.time()
    stale = _envf("LIMITS_CLAUDE_STALE_MINUTES", 30)
    if not CLAUDE_SNAPSHOT.exists():
        return {"source": "claude", "known": False,
                "reason": "控えが無い（statusline から書き出す設定が要る。usage-limits の README.md）"}
    try:
        data = json.loads(CLAUDE_SNAPSHOT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"source": "claude", "known": False, "reason": "控えを読めない"}
    age = (now - float(data.get("written_at", 0))) / 60
    windows = []
    for key in ("five_hour", "seven_day"):
        w = (data.get("rate_limits") or {}).get(key)
        if w and w.get("used_percentage") is not None:
            windows.append({"name": key, "used_percent": float(w["used_percentage"]),
                            "resets_at": w.get("resets_at"), "resets": _fmt_reset(w.get("resets_at"))})
    if not windows:
        return {"source": "claude", "known": False, "reason": "控えに使用率が無い", "age_minutes": round(age, 1)}
    if age > stale:
        return {"source": "claude", "known": False, "reason": f"控えが古い（{age:.0f} 分前）", "windows": windows,
                "age_minutes": round(age, 1)}
    worst = max(w["used_percent"] for w in windows)
    return {"source": "claude", "known": True, "windows": windows, "remaining_percent": round(100 - worst, 1),
            "age_minutes": round(age, 1)}


def judge(claude: dict, codex: dict) -> tuple[str, int, list[str]]:
    handoff = _envf("LIMITS_CLAUDE_HANDOFF_PERCENT", 5)
    warn = _envf("LIMITS_WARN_PERCENT", 15)
    notes: list[str] = []
    state, code = "OK", 0
    if claude.get("known"):
        left = claude["remaining_percent"]
        if left <= handoff:
            state, code = "HANDOFF", 2
            notes.append(f"Claude の残り {left}% ≤ {handoff}%: 監督を Codex へ交代する（usage-limits の scripts/handoff.sh。プロジェクト設定と実行承認が必要）")
        elif left <= warn:
            state, code = "WARN", 1
            notes.append(f"Claude の残り {left}%（{warn}% 以下）")
    else:
        notes.append("Claude の残りは不明: " + claude.get("reason", ""))
        if code == 0:
            state, code = "UNKNOWN", 3
    if codex.get("known"):
        left = codex["remaining_percent"]
        if left <= warn and state in ("OK", "UNKNOWN"):
            state, code = "WARN", 1
        if left <= warn:
            notes.append(f"Codex の残り {left}%。リセット券で回復する前提（自動では使わない。必要なら手で使う）")
    else:
        notes.append("Codex の残りは不明: " + codex.get("reason", ""))
    return state, code, notes


def describe(info: dict) -> str:
    name = "Claude" if info["source"] == "claude" else "Codex"
    if not info.get("known"):
        return f"{name}: 不明（{info.get('reason', '')}）"
    parts = [f"{w['name']} 使用 {w['used_percent']:.0f}%（リセット {w['resets']}）" for w in info["windows"]]
    return f"{name}: 残り {info['remaining_percent']}%（" + "・".join(parts) + f"、記録は {info['age_minutes']} 分前）"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["check", "codex", "claude"])
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "codex":
        info = read_codex(); print(json.dumps(info, ensure_ascii=False) if a.json else describe(info)); return 0 if info.get("known") else 3
    if a.cmd == "claude":
        info = read_claude(); print(json.dumps(info, ensure_ascii=False) if a.json else describe(info)); return 0 if info.get("known") else 3
    claude, codex = read_claude(), read_codex()
    state, code, notes = judge(claude, codex)
    if a.json:
        print(json.dumps({"state": state, "claude": claude, "codex": codex, "notes": notes}, ensure_ascii=False))
    else:
        print(state); print(describe(claude)); print(describe(codex))
        for n in notes: print("- " + n)
    return code


if __name__ == "__main__":
    sys.exit(main())
