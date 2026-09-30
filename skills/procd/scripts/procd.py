#!/usr/bin/env python3
"""procd の CLI と常駐の入口。依存は Python の標準ライブラリだけ。"""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import sys

from config import ACTIVE, Config, ProcdError, REQUEST_BYTES, wait_code
from daemon import Daemon, socket_address


LABELS = {"accepted": "受付", "starting": "受付済み", "started": "開始", "running": "実行中",
          "stopping": "停止を依頼", "exited": "終了", "failed": "失敗", "stopped": "停止",
          "lost": "行方不明", "orphaned": "実行係を失いました"}


def one_line(value):
    return json.dumps(str(value), ensure_ascii=False)[1:-1]


def describe(job, kind=None, seq=None):
    prefix = f"#{seq} " if seq is not None else ""
    code = job.get("exit_code")
    return (f"{prefix}{one_line(job['name'])}: {LABELS.get(kind or job['state'], kind or job['state'])}"
            f"; 終了コード={code if code is not None else '不明'}; ログ={one_line(job['log_dir'])}")


class Client:
    def __init__(self, address, request):
        self.socket = socket.socket(socket.AF_UNIX)
        try:
            self.socket.connect(socket_address(address))
        except OSError:
            self.socket.close()
            raise
        self.reader = self.socket.makefile("rb")
        self.write(request)

    def write(self, value):
        encoded = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode()
        if len(encoded) > REQUEST_BYTES:
            raise ProcdError("入力が大きすぎます")
        self.socket.sendall(encoded)

    def read(self):
        line = self.reader.readline(REQUEST_BYTES * 2)
        if not line:
            raise ProcdError("常駐との接続が閉じました。既読は保存されています")
        value = json.loads(line)
        if not value.get("ok"):
            raise ProcdError(value.get("error", "操作できません"))
        return value

    def close(self):
        self.reader.close()
        self.socket.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def call(address, request):
    with Client(address, request) as client:
        return client.read()["value"]


def parser():
    result = argparse.ArgumentParser(description="処理と完了の記録を預かる見張り役")
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "procd"
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    result.add_argument("--socket", default=str(Path(runtime) / "procd.sock") if runtime else str(state / "procd.sock"),
                        help="Unix ソケット。@で始めると Linux の抽象ソケット")
    commands = result.add_subparsers(dest="op", required=True)
    serve = commands.add_parser("serve", help="常駐を起動")
    serve.add_argument("--state-dir", default=str(state), help="専用の保存先")
    serve.add_argument("--config", help="JSON の設定ファイル")
    run = commands.add_parser("run", help="処理を預ける（最後に -- コマンド… を指定）")
    run.add_argument("name")
    run.add_argument("--cwd", default=os.getcwd())
    run.add_argument("--env", action="append", default=[], metavar="K=V")
    run.add_argument("--json", action="store_true")
    listing = commands.add_parser("ls", help="実行中と保存している終了記録")
    listing.add_argument("--json", action="store_true")
    status = commands.add_parser("status", help="一つの処理を確認")
    status.add_argument("name")
    status.add_argument("--json", action="store_true")
    stop = commands.add_parser("stop", help="穏やかに停止し、猶予後に強制停止")
    stop.add_argument("name")
    stop.add_argument("--grace", type=float)
    wait = commands.add_parser("wait", help="終了を待って終了コードを返す")
    wait.add_argument("name")
    logs = commands.add_parser("logs", help="保存しているログを読む")
    logs.add_argument("name")
    logs.add_argument("--follow", action="store_true")
    logs.add_argument("--stream", choices=("stdout", "stderr", "both"), default="both")
    for op, help_text in (("events", "出来事を読む"), ("unread", "consumer の未読を読む"),
                          ("watch", "未読を出してから新しい出来事を1行ずつ流す")):
        command = commands.add_parser(op, help=help_text)
        command.add_argument("--consumer", required=op == "unread")
        command.add_argument("--since", type=int)
        command.add_argument("--json", action="store_true", help="JSON Lines で出力")
        if op != "watch":
            command.add_argument("--ack", action="store_true", help="出力した行を既読にする")
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command = None
    if "--" in argv:
        split = argv.index("--")
        command, argv = argv[split + 1:], argv[:split]
    arguments = parser()
    args = arguments.parse_args(argv)
    try:
        if args.op == "serve":
            os.umask(0o077)
            daemon = Daemon(Path(args.state_dir).absolute(), Config.load(args.config))
            try:
                asyncio.run(daemon.serve(args.socket))
            finally:
                daemon.store.close()
            return 0
        request = {"op": "events" if args.op == "unread" else args.op}
        if hasattr(args, "name"):
            request["name"] = args.name
        if args.op == "run":
            if not command:
                arguments.error("run の最後に -- コマンド… を指定してください")
            env = {}
            for entry in args.env:
                key, equal, value = entry.partition("=")
                if not equal:
                    raise ProcdError("環境変数は K=V の形で指定してください")
                env[key] = value
            request.update(command=command, cwd=str(Path(args.cwd).absolute()), env=env)
        elif command is not None:
            arguments.error("-- コマンド… は run で指定してください")
        if args.op == "stop" and args.grace is not None:
            request["grace"] = args.grace
        if args.op in {"events", "unread", "watch"}:
            request.update(consumer=args.consumer, since=args.since,
                           ack=args.op == "watch" or args.ack)
            with Client(args.socket, request) as client:
                while True:
                    row = client.read()
                    if row.get("done"):
                        break
                    event = row["event"]
                    if args.json or args.op == "events":
                        print(json.dumps(event, ensure_ascii=False), flush=True)
                    elif event["kind"] == "gap":
                        print(f"#{event['seq']} 保存期限・上限で削除済み: {event['from']}〜{event['to']}", flush=True)
                    else:
                        print(describe(event["job"], event["kind"], event["seq"]), flush=True)
                    if request["consumer"] and request["ack"]:
                        client.write({"ack": event["seq"]})
                        client.read()
            return 0
        if args.op == "logs":
            request.update(follow=args.follow, stream=args.stream)
            with Client(args.socket, request) as client:
                previous = None
                while True:
                    row = client.read()
                    if row.get("done"):
                        if row.get("logs_removed"):
                            print("保存上限でログを削除しました", file=sys.stderr)
                        break
                    if args.stream == "both" and previous != row["stream"]:
                        sys.stdout.buffer.write(f"\n[{row['stream']}]\n".encode())
                        previous = row["stream"]
                    sys.stdout.buffer.write(base64.b64decode(row["data"]))
                    sys.stdout.buffer.flush()
            return 0
        if args.op == "ls":
            jobs = []
            with Client(args.socket, request) as client:
                while True:
                    row = client.read()
                    if row.get("done"):
                        break
                    if args.json:
                        jobs.append(row["job"])
                    else:
                        print(describe(row["job"]))
            if args.json:
                print(json.dumps(jobs, ensure_ascii=False))
            return 0
        value = call(args.socket, request)
        if args.op == "stop" and value["state"] in ACTIVE:
            value = call(args.socket, {"op": "wait", "name": args.name})
        if getattr(args, "json", False):
            print(json.dumps(value, ensure_ascii=False))
        else:
            print(describe(value))
        return wait_code(value) if args.op == "wait" else 0
    except BrokenPipeError:
        return 0
    except (ProcdError, OSError, ValueError) as exc:
        print(f"procd: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
