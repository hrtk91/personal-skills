#!/usr/bin/env python3
"""選んだ置き場の procd ユーザーサービスを標準出力へ生成する。設置・起動はしない。"""
import argparse
from pathlib import Path
import sys


def unit_argument(value):
    if any(char in value for char in "\x00\n\r"):
        raise ValueError("パスに改行やNULは使えません")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--procd-root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()
    script = args.procd_root.resolve() / "procd.py"
    if not script.is_file():
        parser.error("procd-root に procd.py がありません")
    for value in (args.python, args.state_dir):
        if not Path(value).is_absolute():
            parser.error("Python と保存先は絶対パスで指定してください")
    if not (Path(args.socket).is_absolute() or (args.socket.startswith("@") and len(args.socket) > 1)):
        parser.error("ソケットは絶対パスか @名前 で指定してください")
    values = {"@PYTHON@": args.python, "@PROCD_SCRIPT@": str(script),
              "@SOCKET@": args.socket, "@STATE_DIR@": args.state_dir}
    template = (Path(__file__).resolve().parents[1] / "assets" / "procd.service.in").read_text()
    try:
        # 一度だけ置換し、パス中の文字列をテンプレートとして再解釈しない。
        import re
        result = re.sub(r"@(?:PYTHON|PROCD_SCRIPT|SOCKET|STATE_DIR)@",
                        lambda match: unit_argument(values[match.group()]), template)
    except ValueError as exc:
        parser.error(str(exc))
    print(result, end="")


if __name__ == "__main__":
    main()
