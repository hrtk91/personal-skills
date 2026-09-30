---
name: herdr
description: 実装を Codex や pi に振るとき、herdr のタブでエージェントの画面のまま「実装 → 別のエージェントのレビュー」を自動でつなぎ、Claude は最終チェックだけする。依頼文を書き終えて実装を別のエージェントに任せたいとき、ユーザーが herdr で見たい、Codex・pi に実装させたいと言ったときに使う。
---

# herdr で実装とレビューをつなぐ

エージェントの画面を herdr のタブで見られる形で、実装とレビューを自動でつなぐ。画面なしの `codex exec` は使わない。対応するエージェントは Codex と pi。`agents/<種類>.sh` を足せば増やせる。

## 流れ

1. Claude が依頼文を書く。既定は `handoff/<名>.md`。何を作るか、触ってよい所、成功の証拠、画面やユーザー向けの文言があれば全文を書く。
   - 共通の決まりは `RULES`、設計の下見の手順は `DESIGN_RULES`、追加のレビュー観点は `CHECKLIST` で指定できる。
   - 依頼名は英数字で始まる英数字・`_`・`-`。エージェント名には小文字化して英数字・`-` だけを残した先頭24文字を使う。同時に動かす依頼では、この部分が重ならない名前にする。
2. Bash ツールで **`run_in_background: true`・`dangerouslyDisableSandbox: true`** にして台本を流す（nohup や & は付けない）。台本が終わると Claude に知らせが来る。

   ```bash
   IMPL_AGENT=codex bash <このスキル>/herdr-run.sh <名> < /dev/null
   ```

   - `< /dev/null` は必須。herdr の中（`HERDR_ENV=1`）で動かす。今のワークスペースにタブ「<名>」ができ、左が実装、右がレビュー。既存のタブの選択は変えない。
   - 本体の git worktree `$HERDR_WORK/wt/<名>` を作る。既定のブランチは `herdr/<名>`。本体の未コミットの変更は写しに入らない。依頼文・決まり・プロジェクトの説明は本体の今の版をコピーする。
   - 未コミットの作業も含める必要がある場合だけ `COMMIT_DIRTY=1` を使う。本体の全変更を先にコミットするため、対象を確認し、無関係な変更があるときは使わない。
   - 実装のエージェントはコードを書く前に設計の下見を書く。`DESIGN_RULES` があれば、その手順と結論の書式を優先する。無ければ10行程度で触るファイル・やり方・既存とかぶる所を書き、最後に `結論: 続行` または `結論: STOP（理由）` を置く。
   - 下見の行頭が `結論: STOP` なら、レビューに進まず `reviewed-<名>` に `stopped` と書く。Claude が下見を読んで次の判断をする。
   - 実装 → パッチ → 別のエージェントによるレビューと修正 → パッチ更新 → ブランチへのコミット → タブを閉じる → `reviewed-<名>` に `reviewed` を書く。
3. 起動したら一度、`$HERDR_WORK/herdr-<名>.log` と `herdr agent read impl-<名> --lines 20` を見て依頼が届いていることを確かめる。ログには Codex のモデル・tier・effort と目標の受信確認が残る。
4. Claude は台本の終わりの知らせを待つ。実装だけ終わった時点では最終チェックに進まない。
5. レビュー報告と要所の差分を読む。全文の差分読みやテストの流し直しはレビューのエージェントに任せる。取り込む承認があれば本体で `git merge <BRANCH_PREFIX>/<名>` し、今回の worktree とブランチを片付ける。`BASE` の写しは自動コミットしないためパッチを取り込む。
6. `failed`・`blocked`・`stopped` ではタブを残す。ログと該当ペインを読んで対応し、用が済んだ今回のタブだけを `herdr tab close <tab_id>` で閉じる（ID はログにある）。

## エージェントとモデル

| 変数 | 意味 | 既定 |
| --- | --- | --- |
| `IMPL_AGENT` | 実装するエージェント | `codex` |
| `REV_AGENT` | レビューするエージェント | `IMPL_AGENT` と同じ |
| `CODEX_MODEL` | 設計の下見と実装のモデル | `gpt-6.1-sol` |
| `CODEX_TIER` | Codex の service tier | `default`（fast なし） |
| `CODEX_EFFORT` | Codex の念入りさ | `max` |
| `CODEX_REV_MODEL` / `CODEX_REV_TIER` / `CODEX_REV_EFFORT` | レビューの設定 | 対応する実装の設定を継承 |

Codex は設計・実装・レビューを一旦 `gpt-6.1-sol / default / max` に一本化する。`gpt-6-astra` は `CODEX_MODEL=gpt-6-astra` または `CODEX_REV_MODEL=gpt-6-astra` と明示すれば使える。設計専用の制限や起動拒否はない。台本の外で設計だけ頼む場合も同じ既定を使う。

旧名 `MODEL`・`TIER`・`EFFORT` も、対応する `CODEX_*` が無い場合に読む。レビュー専用の指定が最優先。`/goal` で依頼を渡し、セッション記録の目標イベントに今回の印のパスが載ったことを確かめる。`-s danger-full-access -a never` で動かすため、書いてよい場所は依頼文で絞る。worktree と元の Git ルートの信頼指定は起動引数に渡し、ユーザーの設定ファイルは編集しない。

pi は通常のプロンプトを使い、`/goal` は使わない。既定は `openai-codex/gpt-6-luna`・thinking `high`（`PI_PROVIDER`・`PI_MODEL`・`PI_THINKING`）。モデル名による起動拒否はない。自動実行用の `agents/pi-system.md` を `--system-prompt` に渡す。ユーザーの SYSTEM.md は変えない。ローカルモデルを使う場合は、許可されたランタイムを先に起動しておく。

## プロジェクトごとの設定

本体の `.herdr.env` は Bash として読み込む。`HERDR_CONF` で別の設定ファイルを選べる。以下は、既存の `codex/*` ブランチと依頼文の接頭辞を使うプロジェクトの例。

```bash
HANDOFF=${HANDOFF:-handoff}
TASK_PREFIX=${TASK_PREFIX:-codex-project-}
BRANCH_PREFIX=${BRANCH_PREFIX:-codex}
WORK_NAME=${WORK_NAME:-project-codex}
RULES=${RULES-"handoff/evidence.md handoff/design-first.md"}
DESIGN_RULES=${DESIGN_RULES:-handoff/design-first.md}
CONTEXT_FILES=${CONTEXT_FILES-"CLAUDE.md AGENTS.md"}
CHECKLIST=${CHECKLIST-handoff/review-checklist.md}
EXTRA_DIRS=${EXTRA_DIRS:-assets/cache}
BASE_REFRESH_EXTRA_DIRS=${BASE_REFRESH_EXTRA_DIRS:-0}
PATCH_EXCLUDE=${PATCH_EXCLUDE-":!*.png :!assets"}
COMMIT_DIRTY=${COMMIT_DIRTY:-0}
COMMIT_NAME=${COMMIT_NAME:-Codex}
COMMIT_EMAIL=${COMMIT_EMAIL:-codex@noreply.invalid}
```

| 設定 | 既定と用途 |
| --- | --- |
| `HANDOFF` | `handoff`。文書のディレクトリ |
| `TASK_PREFIX` | 空。依頼・設計・実装報告・レビュー報告すべてに同じ接頭辞を付ける |
| `BRANCH_PREFIX` | `herdr`。ブランチは `<接頭辞>/<名>`。同名の既存ブランチは上書きしない |
| `WORK_NAME` | `herdr-<リポジトリ名>`。キャッシュ内の既定の置き場の名前 |
| `HERDR_WORK` | 置き場全体。旧名 `CODEX_WORK` より優先し、両方無ければユーザーのキャッシュ内の `WORK_NAME` を使う |
| `RULES` | `handoff/rules.md`。共通の決まり。無い文書はコピーを省略 |
| `DESIGN_RULES` | 空。指定時は設計の手順・結論の書式を優先し、両担当に読ませる |
| `CONTEXT_FILES` | `CLAUDE.md AGENTS.md`。本体の今の版をコピーして両担当に読ませる |
| `CHECKLIST` | `handoff/review-checklist.md`。あれば追加のレビュー観点に使う |
| `EXTRA_DIRS` | 空。git の外にあるディレクトリをリンクせずコピーする |
| `BASE_REFRESH_EXTRA_DIRS` | `1`。`BASE` でも本体から追加ディレクトリをコピーする。`0` なら前の写しの在庫を保持する |
| `EXTRA` | 空。git の外の単体ファイルを読み取り専用でコピーし、パッチ・コミットから除外する |
| `PATCH_EXCLUDE` | 空。Git の除外 pathspec をパッチとコミットの両方に適用する |
| `COMMIT_NAME` / `COMMIT_EMAIL` | `Codex <codex@noreply.invalid>` または `Pi <pi@noreply.invalid>`。台本のコミット作者 |
| `DIRTY_COMMIT_NAME` / `DIRTY_COMMIT_EMAIL` | `Claude <claude@noreply.invalid>`。`COMMIT_DIRTY=1` の事前コミット作者 |
| `CODEX_HOME` | Codex の標準の設定・セッション置き場。指定時は両ペインに渡し、受信確認も同じ場所で行う |

文書・追加ファイル・除外 pathspec の一覧は空白区切り。ファイル名そのものに空白は使わない。設定例の `${変数:-既定}` は起動時の環境変数を優先するための書き方。`RULES`・`CONTEXT_FILES`・`CHECKLIST`・`PATCH_EXCLUDE` は空文字で無効にできる。

例の依頼名が `sample` なら依頼は `handoff/codex-project-sample.md`、設計は同じ名前の `-design.md`、実装報告は `-report.md`、レビュー報告は `-review.md`。ブランチは `codex/sample`。既定の `herdr/*` と併用でき、既存の別名の `codex/*` ブランチも保持する。

置き場には `wt/<名>/`、`patch-<名>.diff`、`reviewed-<名>`、`herdr-<名>.log`、レビュー依頼 `review-task-<名>.md` を置く。レビュー依頼は写しの外に置き、パッチには含めない。

## 再開と完了判定

- `BASE=<前の写し>`: Git 履歴を独立したローカルの写しにし、未コミット・未追跡の内容もコピーする。依頼文・決まり・説明は本体の今の版で入れ直す。元が worktree でも元の index を共有しない。レビュー後は自動コミットしない。
- `RESUME=1`: ログから既存のタブとペインを読み、動いている担当を止めずに待つ。ログと写しが必要。
- `RESUME=newtab`: 既存の写しを残し、タブだけ作り直す。以前のタブとエージェントが無い場合に使う。
- `SKIP_IMPL=1`: 実装を飛ばしてレビューから進める。通常は `RESUME` と組み合わせる。`BASE` の続きなら `BASE` も再指定する。
- `herdr agent wait` の観測タイムアウトは担当の終了を意味しない。working 中や状態取得に失敗した場合は同じ担当を待つ。
- herdr の `done` は仕事の完了を保証しない。担当が最後に `touch` で作る `done-<agent>` を見て次へ進み、確認後に印を消す。印がないまま応答が終わったら同じ目標を3回まで渡す。
- Codex は herdr の入力準備状態を待ち、セッション記録の `thread_goal_updated` で受信を確かめる。pi は working になったことで受信を確かめる。
- `blocked` では台本が確認画面に答えず、`reviewed-<名>` に `blocked` と書いて終了コード2で終わる。Claude が該当ペインを読み、依頼文と決まりに照らして対応する。追加の許可が必要な操作はユーザーの許可を得る。
- 起動・送信・パッチ・コミット・タブの片付けに失敗した場合は `failed`、設計で STOP なら `stopped`、レビューとコミットとタブの片付けが完了した場合だけ `reviewed`。マーカーの存在だけで取り込み可と判断しない。
- 台本を付け替える場合は今回の台本の PID だけを止め、`RESUME=1` で再開する。動いているエージェントや無関係な台本・タブは止めない。同名の担当が別のペインにいた場合も、その担当には触らず失敗として報告する。

## 依頼文と決まりに書くこと

- 書いてはいけない場所（本体やユーザーの設定）と、GPU・ネット・ダウンロード・学習などの使用条件。
- 画面の文言を一字一句使うこと。足りない文言は【仮】にして報告へ並べ、Claude が書き直すこと。
- 確かめた結果と推測を分け、テストの出力と失敗を残すこと。未完了を完了と書かないこと。
- エージェント自身はコミットしないこと。台本がパッチの対象をコミットする。Claude の取り込み作業は別途承認された範囲で行う。

スキルの変更確認は `python3 -m unittest discover -s skills/herdr/tests -v` と `bash -n` を使う。実 Codex の通し確認は別途許可された使い捨てリポジトリで行う。
