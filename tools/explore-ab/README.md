# 探索のお願いの A/B（explore-first）

作業役（Pi）のシステムプロンプトに「取り掛かる前に隅々まで読んで把握する」の 1 項を足すと、仕事の出来が上がるかを、
random-image-genarator の過去の仕事 4 本（台帳 -2・-6・-9・-12）で比べる台本。依頼は `handoff/explore-first-ab.md`。

    python3 tools/explore-ab/run.py                      # 4 本 × A・B（順は 6・12・9・2）
    python3 tools/explore-ab/run.py --tasks 6 --resume   # result.json がある回は飛ばす

## 流れ（1 回ごと）
1. `~/.cache/explore-ab/ws/<無作為の名前>/project` に本体を `git clone --shared` し、origin を外して、その仕事の出発点
   （1 回目の実装のコミットの親）を取り出す。依頼文は 1 回目に渡した版に戻し、本体に無ければ「依頼文」のコミットにする。
   `npm ci` のキャッシュは `~/.cache/explore-ab/npm-cache`（リポジトリの外）。
2. Pi を `--provider openai --model gpt-6-luna --thinking high`（fast なし）、`nice -n 10` で流す。依頼は herdr-run.sh の
   実装の依頼と同じ形。A は `skills/herdr/agents/pi-system.md` のまま、B は「## 基本方針」の先頭に依頼文の 1 項を足したもの。
   システムプロンプトは `results/<仕事>/<A|B>/pi-system.md`、Pi のセッションは `~/.cache/explore-ab/sessions/` に置く
   （どちらも作業用のコピーの外）。
3. 依頼文を除いた変更を Pi の名前でコミットし（herdr-run.sh と同じ）、`git diff <出発点> HEAD` を `results/.../diff.log` に残す。
4. 台帳の `check` を流す。落ちたら 1 回だけ流し直す（台帳の `checkTwice` と同じ）。
5. 台帳と同じ文面・同じ呼び方で Opus のレビューを呼ぶ（`tools/task-ledger/advance.ts` の `reviewPrompt` と
   `realAdvanceDeps.review`: フック無し・MCP 無し・読む道具と git の読み取りだけ）。作業場所はそのコピー、差分と確かめの出力は
   `ws/<名前>/logs/`。どちらのパスにも A・B の文字や B の文言は入らない。確かめが 2 回とも落ちた回は、台帳ならレビューに
   進まず差し戻すので「直す（確かめが落ちた）」と記録し、参考に同じレビューも呼ぶ（rubric の「すでに通っています」の 1 文だけ
   「落ちました」に替える）。
6. `result.json` に時間・トークン・答えを書き、作業用のコピーを消す。

同じ仕事の A と B は同時に流す。実装と確かめは同時に 2 本まで（次の組は前の組の確かめが終わってから）。レビューは次の組と
重なってよい。新しい組を出す前に、1 分の負荷が 19（`LOAD_LIMIT`）を超えていれば待つ。

`results-invalid-1st/` は 1 回目の 8 回（盲検に穴があり差分も無い。比べる証拠に使わない）の答えと報告だけを残したもの。
全部の記録は `~/.cache/explore-ab/invalid-1st/`（リポジトリの外）。
