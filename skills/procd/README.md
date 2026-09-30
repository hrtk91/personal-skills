# procd — 処理と「終わった」の記録を預かる道具

長いコマンドを procd に預けると、起動を頼んだシェルやエージェントが終了しても処理が続きます。ログと終了コードが残り、Claude は戻ってきたときに未読を読むか、動いている間に `watch` の出力を受け取れます。Linux の Python 3 の標準ライブラリだけを使います。

```bash
procd run build --cwd "$PROJECT" --env MODE=check -- make check
procd status build
procd logs build --follow
procd wait build
procd unread --consumer claude-hooks             # 見るだけ
procd unread --consumer claude-hooks --ack       # 出力したものを既読にする
procd watch --consumer claude-monitor            # 未読と新着を1行ずつ出す
```

`wait` は処理の終了コードを返します。`logs` と `watch` は表示を止めても預かった処理を止めません。処理を止める操作は `procd stop build` です。同じ名前は記録を保持している間は使えません。別の名前を付けるか、記録の保存期限が過ぎるまで待ちます。

## 常駐を手で起動する

`PROCD_ROOT` にこのスキルの `scripts/` の絶対パスを指定し、専用の保存先とソケットを選びます。保存先は自分だけが読める 0700 のディレクトリが必要です。未作成なら procd が作ります。

```bash
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" serve --state-dir "$STATE_DIR"
```

別のシェルでは、同じソケットを指定して操作します。

```bash
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" run example --cwd "$PWD" -- python3 -c 'print("done")'
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" events --consumer example --ack
```

`--socket` はサブコマンドの前に置きます。既定のソケットは `$XDG_RUNTIME_DIR/procd.sock`、その変数が無いときは保存先の `procd.sock` です。保存先の既定は `$XDG_STATE_HOME/procd`、その変数が無いときは `$HOME/.local/state/procd` です。パスが Unix ソケットの長さ制限を超える場合は、短いパスか `@procd-example` のような Linux の抽象ソケットを指定します。同じユーザーの接続だけを受け付けます。

`serve` はシェルを占有します。実運用では後述のユーザーサービスで起動します。常駐の TERM・INT は受付を閉じるだけで、預かった処理は停止しません。強制終了してから起動し直しても、実行係が保存した結果を回収します。常駐が停止中でもログと結果は残りますが、イベント列への追加は常駐が戻ってからです。

## 操作

| コマンド | 結果 |
| --- | --- |
| `run 名前 [--cwd 場所] [--env K=V] -- コマンド 引数…` | 受付後に切り離して起動。`--env` は繰り返せます。シェル展開は行いません。必要なら `bash -c '…'` を明示します。 |
| `ls [--json]` | 実行中と保存している終了記録。 |
| `status 名前 [--json]` | PID、Linux の開始 tick、起動 ID、時刻、コマンド、作業場所、環境の要点、ログの場所、終了コードなど。 |
| `logs 名前 [--follow] [--stream stdout\|stderr\|both]` | 保存している世代を古い順に読みます。既定の `both` は出力元の見出しを付けます。二つの出力の相互の順番は復元しません。 |
| `stop 名前 [--grace 秒]` | グループへ TERM、猶予後に KILL。終了を待って返ります。既に終わった処理には何もしません。 |
| `wait 名前` | 終了まで待ち、その終了コードで返ります。シグナル終了は 128 + シグナル番号です。 |
| `events [--since SEQ] [--consumer 名前] [--ack]` | JSON Lines。`SEQ` より後の保存済みの出来事。consumer 指定時の既定はその既読位置から。表示だけでは既読にしません。 |
| `unread --consumer 名前 [--ack] [--json]` | 未読だけ。通常は読みやすい1行、`--json` は JSON Lines。 |
| `watch [--consumer 名前] [--since SEQ] [--json]` | 未読の後、新着を1行ずつ流し続けます。consumer があれば出力を flush した行を既読にします。無ければ位置を保存しません。 |

JSON の `exit_code` は、シグナル終了を負の番号で表します。起動失敗は 127、行方不明など終了コードを確かめられないときの `wait` は 125 です。常駐への接続や入力のエラーは 1 です。`run` の成功は受付が済んだことを表し、処理の成功は `wait` や終端の出来事で確認します。

環境変数は常駐の環境を引き継ぎ、`--env` で上書きします。`cwd` の既定は CLI を呼んだ場所です。環境の要点には上書きした変数の名前と PATH・LANG・LC_ALL・TZ を保存します。全ての変数の値は公開する状態に載せません。実行に必要な上書き値は専用保存先の `spec.json` に保存されます。

## Claude が拾う方法

動いている会話では、Claude の `Monitor` に次のコマンドを渡す案です。出力の1行が1通知になります。

```bash
procd watch --consumer claude-monitor
```

たとえば終了の通知は `#12 build: 終了; 終了コード=0; ログ=…` です。seq、名前、結果、終了コード、ログの場所を含みます。開始・受付・停止依頼・行方不明も同じ形式です。

戻ってきた会話では、次のコマンドで未読を読みます。

```bash
procd unread --consumer claude-hooks --ack
```

フックを使う場合は、承認後に [install-claude-hooks.py](scripts/install-claude-hooks.py) へ設定ファイルと本体・ソケットを明示します。既存設定とほかのフックを保持し、最初の内容は `.bak-procd` に控えます。まず `--dry-run` で追加内容を確認してください。

```bash
python3 "$PROCD_ROOT/install-claude-hooks.py" --settings "$CLAUDE_SETTINGS" \
  --procd "$PROCD_ROOT/procd.py" --socket "$SOCKET" --dry-run
```

ユーザーが設定変更を許可した後に `--dry-run` を外すと、`SessionStart`（startup/resume/clear/compact）と `UserPromptSubmit` に `unread --consumer claude-hooks --ack` が入ります。外すときは同じ引数に `--remove` を付けます。この補助が追加した handler だけを外し、この補助以外で登録した既存フックは自動で削除しません。

この二つのコマンドフックの標準出力を会話の文脈に入れる案です。実際の Claude の会話・Monitor・フックを使った受信は、この移植では未確認です。外から既存の会話へ直接メッセージを押し込む方法を前提にしません。設定は自動登録しません。

consumer は読み手ごとの名前です。Monitor とフックを別の consumer にすると、それぞれが全ての出来事を読めます。同じ consumer で watch や既読にする読み取りを同時に行うと、後の読み取りを断ります。watch を終了してから、同じ consumer の未読を読めば続きになります。

出力と既読の更新を一つの原子的な操作にはできません。flush の直後、既読が保存される前に読み手を強制終了すると、その行は再通知され得ます。厳密な一度だけの採用が必要な読み手は `--json` の seq を記録して照合します。常駐への再接続は watch を起動し直して行います。CLI は勝手に処理を再起動しません。

## エージェントの台本を預ける例

プロジェクトの台本と、必要な環境を明示して呼びます。台本は別の依頼を実行するため、以下は使い方の例です。この道具の検証ではエージェントを起動していません。

```bash
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" run agent-example --cwd "$PROJECT" \
  --env TASK="$TASK" -- bash "$AGENT_SCRIPT" "$TASK"
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" watch --consumer claude-monitor
python3 "$PROCD_ROOT/procd.py" --socket "$SOCKET" logs agent-example --follow
```

台本に渡す変数は必要に応じて追加します。herdr などを使う場合の台本・workspace・モデルはプロジェクト側の設定です。procd は台本の stdout と stderr、終了コードを預かり、台本の既存の処理や終わりの印は変更しません。

## 保存と再起動

専用保存先には `jobs/`（依頼・状態・ログ・実行係の結果）、`events/`（番号付き JSON Lines と番号の控え）、`consumers.json`（読み手別の既読位置）を置きます。保存先とソケットを切り替えれば独立した常駐を動かせます。同じ保存先の二重起動はロックで断ります。

コマンドごとの実行係は新しいセッション、コマンドはさらに別のセッションとプロセスグループで動きます。実行係が子を回収して終了コードを保存し、常駐だけが列に追記します。コマンドが終了すると、同じグループに残った子孫も片付けます。自分で別のセッションへ離れる子孫はこの管理範囲に含みません。

再起動では PID だけで判断せず、起動 ID と開始 tick を照合します。実行係が生きていればそのまま監視し、保存済みの結果があれば終端を一度だけ追記します。実行係だけを失ってコマンドが生きている場合は「実行係を失いました」と記録し、停止を頼めます。結果が無いままプロセスが消えた場合やホストが再起動した場合は「行方不明」とし、終了コードを推測しません。孤児では実行係が持っていたパイプや終了コードを取り戻せません。

停止を頼んだときは、同じグループの子孫の識別情報も保存します。親が先に回収されても、生きている子孫の開始 tick・起動 ID・グループとセッションを照合して停止を続けます。停止中の孤児は常駐の再起動後も停止を引き継ぎます。その場合の猶予は、復帰後に改めて単調時計で測ります。

イベントの番号は追記前に予約します。異常終了の後は番号が飛ぶことがありますが、同じ番号を再利用しません。書き込みが途中で切れた末尾は `.partial.jsonl` として閉じ、内容を変更せず次の区間を使います。途中の行まで壊れた列は起動を断ります。終了の行が保存されて状態ファイルの更新前に落ちた場合は、列から状態を復元します。

ディスクが書けない場合はエラーを出し、新しい処理を起動しません。列の書き込みや古い区間の削除、状態ファイルの更新に失敗した後は、保存先の問題を直して常駐を再起動します。列に確定した行は、状態ファイルの更新に失敗しても watch に届きます。復帰後は列と実行係の結果から回収します。失敗前に確定した出来事は保持し、同じ終端を再度書かず、新しい区間を増やし続けることも止めます。ログが書けなくなった場合も出力の排水を続け、結果に `log_error` を残します。結果自体を保存できず実行係が終了した場合は、終了コードを確定できないため行方不明になります。

時刻の記録は UTC、停止の猶予は単調時計です。保存期限は UTC の経過で判定します。時計が戻った場合は削除を遅らせます。ホストの再起動は起動 ID で区別します。

## 保存の上限と設定

既定は、同時実行 16 件、終了記録 1,000 件・7 日、stdout と stderr それぞれ 1 MiB × 4 世代です。ログ全体は 256 MiB、イベントは 1 MiB ごとの区間・合計 16 MiB・30 日、既読位置は 256 consumer・最後に読んでから30日です。読み取り中の watch の位置は期限で削除しません。片付けは既定で5秒ごとに行います。

イベントの保存上限では古い閉じた区間を丸ごと削除します。既読がその範囲より古い場合は、削除済みの seq の範囲を先に知らせます。JSON では `kind: "gap"` です。大きな出力の古いログは世代交代で失われます。終了済みのログを全体の上限で削除した後も、状態と終了コードは記録の保存期限まで残ります。

受付前に、開始・終了の情報が後から増える保存枠も確かめます。受付の行に加えて 4 KiB の枠が収まらない設定では起動を断ります。状態に保存するエラーの要約は 256 バイトまでです。コマンドを起動できなかった理由の全文は stderr のログで読めます。`wait`・`logs` の読み取り中は対象の記録とログを片付けず、読み取り後に期限を適用します。これらを保持したまま新しいログの枠を予約できない場合も、新しい起動を断ります。

設定を変えるときは JSON ファイルを用意し、`serve --config "$CONFIG_FILE"` を指定します。省略した項目は既定値になります。項目の定義は [config.py](scripts/config.py) にあります。

```json
{
  "log_bytes": 1048576,
  "log_backups": 3,
  "log_total_bytes": 268435456,
  "event_segment_bytes": 1048576,
  "event_total_bytes": 16777216,
  "job_retention_seconds": 604800,
  "event_retention_seconds": 2592000,
  "consumer_retention_seconds": 2592000,
  "max_finished_jobs": 1000,
  "max_consumers": 256,
  "max_parallel": 16,
  "stop_grace_seconds": 3,
  "cleanup_interval_seconds": 5,
  "notify_timeout_seconds": 5,
  "notify_command": []
}
```

ログの全体枠には、同時実行分の最大世代数を収める必要があります。新しい処理の受付前にも片付けを行い、実行中のログが伸びる分を予約して、残りの枠から終了済みのログを古い順に削除します。収まらない設定、未知の項目、不正な値は起動時に断ります。保持期間を過ぎた consumer は位置を失うので、次の読み取りは保存されている列の先頭からです。

通知の出口は `notify_command` の引数配列です。既定は空で、何も呼びません。`{name}`・`{state}`・`{exit_code}`・`{log_dir}`・`{seq}` を引数に差し込めます。シェルは使いません。全ての出来事の情報は環境変数 `PROCD_EVENT` に JSON で渡します。通知の成功・失敗を問わず列は先に保存されます。通知は時間制限付きで、失敗してもほかの処理を待たせません。通知の出口は補助で、常駐が落ちた瞬間の呼び出しを再送する保証はありません。列から未読を読む方法で回収します。herdr などを呼ぶ場合は、そのコマンドの引数を確認してから設定してください。

## systemd のユーザーサービス

雛形は [procd.service.in](assets/procd.service.in) です。`ExecStart` は本体の置き場を固定せず、[render-service.py](scripts/render-service.py) で選びます。`PROCD_ROOT` は長く保持する置き場を指定してください。一時 worktree の削除や移動でサービス・フックの参照が切れます。

```bash
python3 "$PROCD_ROOT/render-service.py" --procd-root "$PROCD_ROOT" \
  --socket "$SOCKET" --state-dir "$STATE_DIR" > "$SERVICE_FILE"
```

`--python` を省略すると生成に使った Python の絶対パスを使います。Python・保存先は絶対パス、ソケットは絶対パスか `@名前` を指定します。空白・引用符・systemd の `%` / `$` を含むパスは生成時にエスケープします。生成だけでは設置しません。

サービスの設置・有効化、フックの設定にはユーザーの許可が必要です。承認後、生成したファイルをユーザーサービスの置き場へ設置し、daemon-reload と enable を行います。PATH や linger も別のユーザー設定であり、自動変更しません。skill の導入は harnessctl の profile から行い、サービスやフックは別に設定します。

`KillMode=process` により常駐の再起動で実行係を巻き込みません。OS のシャットダウンやユーザー全体の終了までは処理の生存を保証しません。その後の起動で行方不明を記録します。

## 検証

このスキルのディレクトリで実行します。テストは使い捨ての保存先・ソケットを使い、終了時に今回の処理だけを片付けます。元の44件と、移植した補助の確認を分けています。本物のサービスや設定には触りません。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

既存のサービスやフックから切り替える際は、本体の置き場・ソケット・保存先を照合し、実行中の処理を確認してから参照を更新してください。
