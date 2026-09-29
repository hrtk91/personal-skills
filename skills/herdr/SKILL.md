---
name: herdr
description: 実装を Codex や pi に振るとき、herdr のタブでエージェントの画面のまま「実装 → 別のエージェントのレビュー」を自動でつなぎ、Claude は最終チェックだけする。依頼文（handoff/<名>.md）を書き終えて、実装を別のエージェントに任せたいときに使う。ユーザーが herdr で見たい、Codex・pi に実装させたいと言ったときも使う。
---

# herdr でエージェントに実装させる（実装 → レビュー → Claude の最終チェック）

エージェントの画面をユーザーが herdr のタブで見られる形で、実装とレビューを自動でつなぐ。画面なしの `codex exec` は使わない。対応するエージェントは Codex と pi。`agents/<種類>.sh` を足せば増やせる。

## 流れ

1. Claude が依頼文 `handoff/<名>.md` を書く。何を作るか、触ってよい所、成功の証拠、画面やユーザー向けの文言があれば全文を書く。
   - 共通の決まりは `handoff/rules.md` に置く（守ること・書いてはいけない場所・GPU やネットの使用可否）。
   - レビューで見てほしい観点があれば `handoff/review-checklist.md` に置く。
2. 起動する。Bash ツールで **`run_in_background: true`・`dangerouslyDisableSandbox: true`** にして、台本をそのまま流す（nohup や & は付けない）。台本が終わると Claude に知らせが来る:
   ```bash
   IMPL_AGENT=codex bash <このスキル>/herdr-run.sh <名> < /dev/null
   ```
   - `< /dev/null` は必須。付けないと標準入力を待って止まる。
   - herdr の中（`HERDR_ENV=1`）で動かす。今のワークスペースにタブ「<名>」ができ、左が実装、右がレビュー。
   - 本体の git worktree `$HERDR_WORK/wt/<名>`（ブランチ `herdr/<名>`）を作る。**本体の未コミットの変更は写しに入らない**（依頼文・決まり・プロジェクトの説明だけは今の版を写しに入れる）。途中の作業も入れたいときは `COMMIT_DIRTY=1`（本体の全変更をコミットするので、無関係な変更があるときは使わない）。
   - 実装のエージェントは、書き始める前に設計の下見 `handoff/<名>-design.md` を書く。結論が `STOP` なら、台本はレビューに進まず `reviewed-<名>` に `stopped` と書いて終わる。Claude が下見を読み、組み直しを先にするか範囲を決め直すかを判断する。
   - 実装が終わる → パッチ → 右のペインで別のエージェントがレビューして直す → パッチを作り直し、ブランチにコミット → `reviewed-<名>` を置く。
3. 起動したら 1 回だけ、`$HERDR_WORK/herdr-<名>.log` と `herdr agent read impl-<名> --lines 20` を見て、依頼が届いて動いていることを確かめる。
4. Claude は台本の終わりの知らせを待つ。**実装だけ終わった時点では起きない。**
5. 最終チェック: レビューの報告 `handoff/<名>-review.md` と、要所の差分だけを読む。全文の差分読みやテストの流し直しは、レビューのエージェントに任せる。問題がなければ本体で `git merge herdr/<名>` し、`git worktree remove` とブランチの削除をする。`reviewed-<名>` が `failed`（頼み直しても終わらない）か `blocked`（確認の画面で止まった）なら、ログとペインを見て原因を調べる。
6. 使い終わったペインは閉じる。台本は、実装が終わると実装のペインを、レビューまで終わるとタブごと閉じる。止まったとき（failed・blocked）は残るので、片付けたら `herdr tab close <tab_id>`（ID はログにある）。

## エージェントの選び方

| 変数 | 意味 | 既定 |
| --- | --- | --- |
| `IMPL_AGENT` | 実装するエージェント（`codex` か `pi`） | `codex` |
| `REV_AGENT` | レビューするエージェント | `IMPL_AGENT` と同じ |

実装とレビューを別の種類にすると（例 `IMPL_AGENT=pi REV_AGENT=codex`）、同じ癖の見落としを避けられる。

- **Codex:** `/goal` で依頼を渡し、Codex のセッション記録（`~/.codex/sessions`）に目標が載ったかで確かめる。既定は `gpt-6-luna`・fast（`service_tier=priority`）・念入りさ `max`。設計の重い仕事は `CODEX_MODEL=gpt-6-astra CODEX_TIER=default`（fast は切る）。`-s danger-full-access -a never` で動かすので、書いてよい場所は依頼文で絞る。
- **pi:** 通常のプロンプトで依頼を渡す（`/goal` はない）。既定は `openai-codex/gpt-6-luna`・thinking `high`（`PI_PROVIDER`・`PI_MODEL`・`PI_THINKING`）。pi は `~/.pi/agent/SYSTEM.md` の「変更の前に提案して同意を取る」で止まるので、自動実行用の `agents/pi-system.md` を `--system-prompt` に渡して外す（ユーザーの SYSTEM.md は変えない）。ローカルモデルを使うときは、先に llama-server を起動しておく。

## 設定（プロジェクトごと）

リポジトリの `.herdr.env`（bash）に書く。無ければ既定で動く。

```bash
RULES="handoff/rules.md"            # 共通の決まりの文書（空白区切り。無いものは飛ばす）
CONTEXT_FILES="CLAUDE.md AGENTS.md" # 写しにも入れて読ませるプロジェクトの説明
CHECKLIST="handoff/review-checklist.md"
EXTRA_DIRS="saves/portraits"        # git の外にあって、写しにコピーしたいディレクトリ
PATCH_EXCLUDE=":!*.png :!saves"     # パッチに入れないパス
HANDOFF=handoff                     # 依頼文などを置くディレクトリ
```

その他の環境変数: `HERDR_WORK`（置き場。既定 `~/.cache/herdr-<リポジトリ名>`）、`REPO`、`EXTRA`（git の外の単体ファイルを読み取り専用で写しに置く）、`BASE`（前の写しの上で続ける）、`RESUME=1`（台本だけ付け替える）、`RESUME=newtab`（タブだけ作り直す）、`SKIP_IMPL=1`（レビューからやり直す）。

## 台本がしていること（困ったときに）

- 応答の完了は `herdr agent wait` で待つ（idle・done・blocked になった瞬間に返る。ポーリングしない）。
- **herdr の `done` は仕事の終わりではない。** 途中で質問して止まっても `done` になる。そこで、仕事の終わりはエージェントが最後に `touch $HERDR_WORK/done-<agent>` した印で判定する。印がないまま止まったら、「まだ終わっていない」を付けて同じ依頼を渡し直す（3 回まで）。
- 立ち上げ直後に送った文は落ちることがある。Codex は入力欄が出るのを待ち、記録に目標が載ったかで確かめる。pi は working になったかで確かめる。
- `blocked`（確認の画面で止まった）は判断が要る。台本は答えずに `blocked` を書いて終わる。Claude が起きてペインを読み、依頼文と決まりに照らして答え（`herdr agent send-keys`／`agent prompt`）、続きを見届ける。学習・生成・外部送信など、ユーザーの許可が要る決まりに当たるときだけユーザーに聞く。
- 台本を書き換えるときは、動いている間に直さない。止めるなら `pkill -f "[h]erdr-run.sh"`（パターンに自分のシェルが当たらない書き方）で止めてから `RESUME=1` で付け替える。動いているエージェントは止まらず、台本は終わりを待つところから続ける。

## コミット

作者は実装のエージェント（`codex`・`pi`）の架空のアドレス（`<名前>@noreply.invalid`）。Claude の作業と取り込みは Claude。依頼文の「コミットしない」は、エージェントが自分でコミットしないという意味。ブランチへのコミットは台本がする。

## 依頼文と決まりに書くこと

- 書いてはいけない場所（本体、ユーザーの設定ディレクトリ `~/.claude`・`~/.codex`・`~/.pi`）と、使ってはいけないもの（GPU、ネット、モデルのダウンロード、学習）。
- 画面の文言は、依頼文にあるものを一字一句使わせる。足りない文言は【仮】にして報告に並べさせ、Claude が書き直す。
- 確かめた結果と推測を分けて報告させる。テストは流した出力を貼らせる。失敗も残させる。未完了を完了と書かせない。
