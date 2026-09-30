# usage-limits — Claude と Codex の使用量を確かめる

Python 3 標準ライブラリだけで、手元の使用量記録を読む。使用量の確認は API を呼ばず、監督の交代を自動で起動しない。`LIMITS_ROOT` はこのスキルの `scripts/` の絶対パス。

```bash
python3 "$LIMITS_ROOT/limits.py" check        # 判定を1行目へ出す。終了コード0/1/2/3
python3 "$LIMITS_ROOT/limits.py" codex --json # Codexの直近の使用率・窓・リセット
python3 "$LIMITS_ROOT/limits.py" claude       # statuslineの控え
```

## 読む記録と判定

Codex は `CODEX_HOME` の `sessions` にある JSONL の `rate_limits` を読む。`CODEX_HOME` を指定しなければ標準の Codex 設定領域を使う。最近更新された6ファイルを順に調べ、最初に見つかったファイルの末尾側の記録を採用する。API経由の最新値ではない。記録の経過時間は表示するが、Codexの記録は古さで拒否しない。primary / secondary の使用率が高い方を使う。

Claude は statusline の標準入力にある `rate_limits.five_hour` / `seven_day` を控えへ保存する。保存先は `XDG_STATE_HOME` の `limits/claude.json`、未指定なら標準のユーザーstate領域。控えが無い・使用率が無い・30分より古い場合は不明。five_hour / seven_day の使用率が高い方を使う。

読む場所は `LIMITS_CODEX_SESSIONS` と `LIMITS_CLAUDE_SNAPSHOT` で上書きできる。テストや別の実行環境では専用の場所を指定する。

| 判定 | 終了コード | 条件 |
| --- | --- | --- |
| HANDOFF | 2 | Claudeの残りが5%以下。Codexへの監督交代を判断する。 |
| WARN | 1 | ClaudeまたはCodexの残りが15%以下。HANDOFFは優先する。 |
| UNKNOWN | 3 | Claudeが不明で、CodexのWARNも無い。 |
| OK | 0 | 上記に当たらない。Codexだけ不明な場合は、その理由を添える。 |

しきい値は `LIMITS_CLAUDE_HANDOFF_PERCENT`（5）、`LIMITS_WARN_PERCENT`（15）、`LIMITS_CLAUDE_STALE_MINUTES`（30）。いずれも残り割合・分数で指定する。

**Codexはリセット券で回復する前提**で、Codexの残量を理由にHANDOFFへはしない。券の有無はこの道具で確かめられず、`credits` は券の情報とは別物。WARNに券を手で使う目安を添えるだけで、自動使用しない。券が使えず実際に尽きた場合は、作業を止めて状態を残す。

## statusline への追加（許可を取ってから）

**statuslineはユーザーの設定ファイルなので、許可を取ってから変更する。** JavaScriptのstatuslineなら、既存の `render(input)` の冒頭に次の保存処理を追加する。既存の表示処理と設定を保つ。

```js
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
// render(input) の先頭に追加する
const snapshot = process.env.LIMITS_CLAUDE_SNAPSHOT ?? join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "limits", "claude.json"
);
const temporary = `${snapshot}.${process.pid}.tmp`;
try {
  mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify({
    written_at: Date.now() / 1000,
    rate_limits: input.rate_limits ?? null
  }), { mode: 0o600 });
  renameSync(temporary, snapshot);
} catch {
  try { unlinkSync(temporary); } catch {}
}
// ここから既存の表示処理を続ける
```

一時ファイルをrenameし、読み取り途中のJSONを避ける。書き込みが失敗しても表示は続く。`LIMITS_CLAUDE_SNAPSHOT` または `XDG_STATE_HOME` を変える場合、statusline側と読む側に同じ設定を渡す。JavaScript以外のstatuslineでも、同じ2項目を控えへ保存すればよい。

## プロジェクト側で用意するもの

[引継ぎ書の雛形](assets/supervisor-codex.md) をプロジェクトの引継ぎ書へコピーし、すべての `{{項目}}` を埋める。プロジェクトの資料・状態・計画・役割・編集範囲・承認済み操作・禁止事項・止まる条件・Claudeへの返却方法を決める。未記入の雛形を送らない。

[環境設定の例](assets/handoff.env.example) で次を設定する。

- `REPO`: 対象プロジェクト。スキルの配置から推測しない。
- `HERDR_WORKSPACE_ID`: 対象のherdr workspace。
- `LIMITS_SUPERVISOR_NAME`: 他のプロジェクトと区別できる担当名。
- `HANDOFF_FILE`: 引継ぎ書。相対指定ならREPOから解決する。省略時は `handoff/supervisor-codex.md`。
- `LIMITS_SUPERVISOR_MODEL` / `LIMITS_SUPERVISOR_EFFORT` / `LIMITS_SUPERVISOR_TIER`: 既定はgpt-6.1-sol / max / priority。
- `LIMITS_SUPERVISOR_SANDBOX` / `LIMITS_SUPERVISOR_APPROVAL`: 既定はdanger-full-access / never。広い権限で起動するため、引継ぎ書で作業範囲と承認境界を明示する。
- `LIMITS_CODEX_SESSIONS`: Codexの記録が標準と違う場合の受信確認先。

```bash
set -a
source "$PROJECT_HANDOFF_ENV"
set +a
bash "$LIMITS_ROOT/handoff.sh" --dry-run
```

## 監督の交代

[handoff.sh](scripts/handoff.sh) はherdr向けの起動・受信確認の例。dry-runでは設定と引継ぎ書を検査して起動引数を表示し、herdrへ接続・起動・送信・ファイル作成をしない。実行には、外部クォーターを消費する監督交代への明示的指示か、その実行を含む承認済み手順が必要。HANDOFFの判定だけでは許可にならない。

承認後に `--dry-run` を外すと、同名の担当の存在を確認し、新しいタブ・Codexを作る。入力欄を待ち、引継ぎID付きの `/goal` を送る。今回のIDと引継ぎ書が `event_msg` の `thread_goal_updated` に載ったことを、新しく更新されたローカル記録で確認する。ほかの目標や過去の同じ引継ぎ書だけでは成功にしない。

入力欄の待機は `LIMITS_HANDOFF_READY_SECONDS=60`、送信後の確認は1回ごとに `LIMITS_HANDOFF_CONFIRM_SECONDS=60`、入力欄の安定待ちは `LIMITS_HANDOFF_SETTLE_SECONDS=2`。送信は同じIDで最大3回。終了コード0は今回の目標の受信確認、3は同名担当が存在して未送信、1は入力欄・受信の未確認等、2は設定不備。herdr自身の失敗コードが返る場合もある。失敗時も作った担当を勝手に停止・再起動しない。実状態を確認してから判断する。

交代前にClaudeが状態記録を最新にし、稼働中の担当と判断待ちを残す。交代後は新しい仕事を始めずに待つ。受信確認は監督業務全体の完了ではない。herdr以外ではこの台本をそのまま使わず、引継ぎ書をその環境の承認済み起動方法へ渡す。

## 確認

このスキルのディレクトリで実行する。テストは使い捨てのファイルを使い、台本確認は偽のherdrだけを使う。実際の監督・外部API・ユーザー設定は使わない。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
bash -n scripts/handoff.sh
```
