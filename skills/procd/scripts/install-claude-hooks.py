#!/usr/bin/env python3
"""承認後に、明示した Claude 設定へ procd の未読フックを追加する。--dry-run は書き込まない。"""
import argparse
import copy
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import sys
import tempfile

TAG = " # procd-unread-helper"
EVENTS = ("SessionStart", "UserPromptSubmit")


def updated_settings(data, command, remove):
    if not isinstance(data, dict):
        raise ValueError("設定はJSON objectで指定してください")
    result = copy.deepcopy(data)
    hooks = result.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("hooks はJSON objectで指定してください")
    for event in EVENTS:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            raise ValueError(f"{event} は配列で指定してください")
        kept = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise ValueError(f"{event} のgroupは hooks 配列を持つobjectにしてください")
            if not all(isinstance(handler, dict) for handler in group["hooks"]):
                raise ValueError(f"{event} のhandlerはobjectにしてください")
            handlers = [handler for handler in group["hooks"]
                        if not (isinstance(handler.get("command"), str) and handler["command"].endswith(TAG))]
            if len(handlers) == len(group["hooks"]):
                kept.append(group)
            elif handlers:
                kept.append(dict(group, hooks=handlers))
        if not remove:
            group = {"hooks": [{"type": "command", "command": command, "timeout": 10}]}
            if event == "SessionStart":
                group["matcher"] = "startup|resume|clear|compact"
            kept.append(group)
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    if not hooks:
        result.pop("hooks", None)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--procd", type=Path, default=Path(__file__).resolve().with_name("procd.py"))
    parser.add_argument("--socket")
    parser.add_argument("--consumer", default="claude-hooks")
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    settings = args.settings.absolute()
    if settings.is_symlink():
        parser.error("設定のsymlinkは変更しません。対象の通常fileを明示してください")
    if not args.procd.is_file():
        parser.error("procd.py がありません")
    argv = [sys.executable, str(args.procd.resolve())]
    if args.socket:
        argv += ["--socket", args.socket]
    argv += ["unread", "--consumer", args.consumer, "--ack"]
    try:
        data = json.loads(settings.read_text()) if settings.exists() else {}
        result = updated_settings(data, shlex.join(argv) + TAG, args.remove)
        rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if args.dry_run:
            print(rendered, end="")
            return
        if result == data:
            print("変更なし")
            return
        settings.parent.mkdir(parents=True, exist_ok=True)
        backup = settings.with_name(settings.name + ".bak-procd")
        mode = stat.S_IMODE(settings.stat().st_mode) if settings.exists() else 0o600
        if settings.exists() and not backup.exists():
            shutil.copy2(settings, backup)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=settings.parent,
                                             prefix=settings.name + ".", delete=False) as stream:
                temporary = Path(stream.name)
                os.chmod(temporary, mode)
                stream.write(rendered)
            os.replace(temporary, settings)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print("フック:", {key: len(value) for key, value in result.get("hooks", {}).items() if key in EVENTS})
    except (OSError, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
