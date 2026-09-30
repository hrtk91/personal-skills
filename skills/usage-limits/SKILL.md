---
name: usage-limits
description: ClaudeとCodexのローカル記録から使用量を確認し、Claudeの残量が少ないときに監督をCodexへ引き継ぐ。statuslineの控えの設定や、プロジェクトごとの監督交代手順を用意するときにも使う。
---

# Usage limits

使用量を確認し、Claude が残りわずかならプロジェクトの引継ぎ手順へ進む。確認自体はローカルファイルを読むだけで、API を呼ばない。詳細と statusline の追記は [README.md](README.md) を読む。

## 確認する

`LIMITS_ROOT` はこのスキルの `scripts/` の絶対パス。

```bash
python3 "$LIMITS_ROOT/limits.py" check
python3 "$LIMITS_ROOT/limits.py" claude --json
python3 "$LIMITS_ROOT/limits.py" codex --json
```

`check` は1行目に判定を出し、終了コードを返す。非ゼロは実行失敗とは限らない。

| 判定 | 終了コード | 次の判断 |
| --- | --- | --- |
| OK | 0 | 記録と残量を確認して作業を続ける。 |
| WARN | 1 | 残り15%以下。引継ぎの準備をする。Codexなら券の手動利用を検討する。 |
| HANDOFF | 2 | Claudeの残り5%以下。承認済みの手順でCodexへ監督を渡す。 |
| UNKNOWN | 3 | Claudeの控えが無い・古い等。残量を推測せず、理由を確認する。 |

Claude の five_hour / seven_day、Codex の primary / secondary のうち使用率が最も高い窓で判定する。Claude が不明でも Codex が少なければ WARN となる。Codex の記録だけが不明な場合は、Claude の判定に理由を添える。

- `LIMITS_CLAUDE_HANDOFF_PERCENT=5`、`LIMITS_WARN_PERCENT=15`、`LIMITS_CLAUDE_STALE_MINUTES=30` が既定値。
- `LIMITS_CLAUDE_SNAPSHOT`、`LIMITS_CODEX_SESSIONS` で読む場所を変えられる。
- Codex は最近更新された6ファイルから使用率を探す。控えの時刻も表示するが、Codexには鮮度による拒否を設けていない。古い記録は現在の残量と断定しない。
- **Codex はリセット券で回復する前提**。Codexの残量からHANDOFFにはしない。券の有無は確認できず、creditsとは別物。自動では券を使わない。利用できない場合や実際に尽きた場合は止まり、理由を残す。

## Claude の控えを用意する

使用率は statusline の標準入力の `rate_limits.five_hour` / `seven_day` から控えへ保存する。控えが無い・30分より古い場合は不明になる。

**statusline はユーザーの設定ファイルなので、ユーザーの許可を取ってから変更する。** [README.md の追記例](README.md#statusline-への追加許可を取ってから) は、表示を保ったまま `written_at` と `rate_limits` を一時ファイルへ書き、renameする。書き込み失敗でも表示は続ける。既存の設定・表示コードを丸ごと置き換えない。

## 監督を引き継ぐ

[監督の引継ぎ書](assets/supervisor-codex.md) と [環境設定の例](assets/handoff.env.example) をプロジェクトにコピーして埋める。読む資料、役割、編集範囲、承認済みの操作、禁止事項、止まる条件はプロジェクト側で決める。未記入の雛形では起動しない。

[handoff.sh](scripts/handoff.sh) は herdr 用の起動・受信確認の例。`REPO`、`HERDR_WORKSPACE_ID`、プロジェクト固有の `LIMITS_SUPERVISOR_NAME` が必要。`HANDOFF_FILE` はプロジェクトの引継ぎ書を指す。既定は gpt-6.1-sol / max / priority、danger-full-access / never。権限の広い起動なので、引継ぎ書に書いてよい範囲と承認境界を残す。

```bash
# プロジェクト設定を読み、送る依頼と起動引数だけ確認する
set -a
source "$PROJECT_HANDOFF_ENV"
set +a
bash "$LIMITS_ROOT/handoff.sh" --dry-run
```

Codex の起動・依頼送信は外部サービスのクォーターを消費する。**ユーザーが監督交代を明示的に指示した場合、またはその実行を含む承認済み手順がある場合だけ**、`--dry-run` を外す。HANDOFFという判定だけでは起動を許可しない。

実行時は新しい herdr の担当を作り、引継ぎID付きの `/goal` を送る。同じIDが `thread_goal_updated` に記録されたことを確認する。既存の同名担当があれば未送信で終了コード3、受信確認ができなければ1で返し、自動停止・再起動しない。受信確認の成功は監督業務の完了ではない。herdr 以外ではこの台本を使わず、同じ引継ぎ書を環境の承認済み起動方法へ渡す。

交代前に状態記録・稼働中の担当・判断待ちを更新する。Claude は交代後、新規の仕事を始めずに待つ。戻れる状態になった場合の返却方法も引継ぎ書に書く。

## 確認

このスキルのディレクトリで実行する。追加の台本確認は偽の herdr と使い捨てのセッション記録だけを使う。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
bash -n scripts/handoff.sh
```

移植元の判定テスト5件を保持する。実サービスの起動・statuslineの変更・実エージェントへの送信を検証用に行わない。
