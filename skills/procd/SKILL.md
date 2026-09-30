---
name: procd
description: 長いコマンドやエージェントの台本、学習を依頼元から切り離して預け、ログ・終了コード・完了通知を回収する。Claudeで終了通知をwatchや未読フックから受け取りたいときにも使う。
---

# procd

Linux の Python 3 標準ライブラリだけで、処理と追記専用のイベント列を預かる。[README.md](README.md) に操作・保存上限・復旧の詳細がある。

## 処理を預ける

`PROCD_ROOT` はこのスキルの `scripts/` の絶対パス。既存の常駐を使うなら、そのソケットと保存先を確認する。独立した確認では専用の `SOCKET` と `STATE_DIR` を選ぶ。起動だけでは保存先を共有しない。

```bash
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" serve --state-dir "$STATE_DIR"
# 別のシェルで、同じ SOCKET を指定する
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" run build --cwd "$PROJECT" -- make check
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" logs build --follow
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" wait build
```

`serve` はシェルを占有する。常用する場合は後述のサービスを使う。`--socket` はサブコマンドより前に置く。`run` は受付の成功、`wait` は処理の終了コードを返す。台本は `-- bash "$AGENT_SCRIPT" "$TASK"` のように指定し、必要な環境は繰り返しの `--env K=V` で渡す。

依頼済みの処理だけを預ける。この道具は学習・生成・外部API利用を新たに許可しない。既存のCPU制限を使うなら、預けるコマンド自体もその制限で包む。

## Claude で受け取る

動いている会話では、Claude の `Monitor` に次のコマンドを渡す。出力の1行が1通知になる。

```bash
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" watch --consumer claude-monitor
```

会話へ戻るときは `unread --consumer claude-hooks --ack` で未読を読む。承認後、[フックの補助](scripts/install-claude-hooks.py) で `SessionStart` と `UserPromptSubmit` にそのコマンドを追加できる。

```bash
python3 "$PROCD_ROOT/install-claude-hooks.py" --settings "$CLAUDE_SETTINGS" \
  --procd "$PROCD_ROOT/procd.py" --socket "$SOCKET" --dry-run
# ユーザーが設定変更を許可した後、同じ引数から --dry-run を外す
```

補助は明示した設定だけを変更し、既存設定・他のフックを保持する。最初の内容は `.bak-procd` に保存する。削除は同じ引数に `--remove` を付け、この補助が追加したものだけを外す。この補助以外で登録した既存フックは自動で消さない。

Monitor とフックは別の consumer を使う。同じ consumer の同時読み取りは断られる。出力直後の異常終了では再通知され得るため、厳密な重複排除には `--json` の `seq` を使う。Claude の実会話での受信は、CLI の確認とは別に確かめる。

## 常用する場合

[サービス雛形](assets/procd.service.in) は置き場を固定しない。[render-service.py](scripts/render-service.py) で Python・本体・ソケット・保存先を選び、設置前に生成結果を確認する。

```bash
python3 "$PROCD_ROOT/render-service.py" --procd-root "$PROCD_ROOT" \
  --socket "$SOCKET" --state-dir "$STATE_DIR" > "$SERVICE_FILE"
```

ユーザーサービスの設置・有効化、PATH、Claude のフック、linger の変更はユーザーの許可後に行う。skill を profile に追加しても、サービスやフックは導入されない。

`KillMode=process` を保つ。常駐の再起動で実行係を巻き込まないための設定で、ログアウト・OS終了まで生存を保証するものではない。

## 保存と停止

- 同名の依頼は記録を保持している間は再利用できない。別名を付けるか、保存期限を待つ。
- 既定は終了記録1,000件・7日、イベント16 MiB・30日、consumer 256件・最終読取から30日。ログは stdout/stderr 各1 MiB×4世代、全体256 MiB。期限・上限で古い記録が失われる。
- `logs`・`watch` の終了は処理を止めない。停止は `stop 名前`。再接続で処理を再実行しない。
- 常駐の停止中も実行係は結果を保存し、復帰後に列へ追記する。行方不明の終了コードは推測せず、`wait` は125を返す。

## 確認

このスキルのディレクトリで、実運用と別の保存先・ソケットを使う。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

前者は移植元の44件、後者はフック・サービス生成の確認。実サービスやユーザー設定を検証用に変更しない。
