#!/bin/bash
# 使い方: herdr-run.sh <依頼名>
#   $HANDOFF/<名>.md（既定 handoff/<名>.md）を、herdr のタブ「<名>」でエージェントに実装させ（左のペイン）、
#   終わったら別のエージェントにレビューして直させる（右のペイン）。どちらもエージェントの画面のまま見られる。
#   エージェントは agents/<種類>.sh に切り出してある（codex・pi）。IMPL_AGENT・REV_AGENT で選ぶ。
# 置き場 $HERDR_WORK（既定 ~/.cache/herdr-<リポジトリ名>）:
#   wt/<名>/             本体の写し（git worktree。エージェントが書いてよいのはここだけ）
#   patch-<名>.diff      実装のあとと、レビューのあとに作り直す
#   reviewed-<名>        終わりの印。中身は reviewed（レビューまで完了）・stopped（設計の下見が STOP）・failed・blocked
#   herdr-<名>.log       この台本の進み具合
# herdr の中（HERDR_ENV=1）で、Claude のサンドボックスの外から動かす。
# プロジェクトごとの設定は $REPO/.herdr.env（bash。SKILL.md の「設定」を参照）。
set -u
name=$1
SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=${REPO:-$(git rev-parse --show-toplevel)}
[ -f "${HERDR_CONF:-$REPO/.herdr.env}" ] && . "${HERDR_CONF:-$REPO/.herdr.env}"
WORK=${HERDR_WORK:-${CODEX_WORK:-$HOME/.cache/herdr-$(basename "$REPO")}}
W=$WORK/wt/$name
WS=${HERDR_WORKSPACE_ID:?herdr の中で動かしてください}
HANDOFF=${HANDOFF:-handoff}
RULES=${RULES:-$HANDOFF/rules.md}                 # 共通の決まりの文書（空白区切り。無いものは飛ばす）
CONTEXT_FILES=${CONTEXT_FILES:-"CLAUDE.md AGENTS.md"}  # 写しにも入れて読ませる、プロジェクトの説明
CHECKLIST=${CHECKLIST:-$HANDOFF/review-checklist.md}   # あればレビューの観点に足す
EXTRA_DIRS=${EXTRA_DIRS:-}                        # git の外にある、写しにコピーしたいディレクトリ
PATCH_EXCLUDE=${PATCH_EXCLUDE:-}                  # パッチに入れないパス（例 ":!*.png :!saves"）
IMPL_AGENT=${IMPL_AGENT:-${AGENT:-codex}}; REV_AGENT=${REV_AGENT:-$IMPL_AGENT}
REQ=$HANDOFF/$name.md; DESIGN=$HANDOFF/$name-design.md; REPORT=$HANDOFF/$name-report.md; REVIEW=$HANDOFF/$name-review.md
mkdir -p "$WORK"
L=$WORK/herdr-$name.log
log() { echo "$(date +%F' '%T) $*" >> "$L"; }
js() { python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }
for f in "$SKILL_DIR"/agents/*.sh; do . "$f"; done   # codex_start・codex_send・pi_start・pi_send ...

# 写しに入れる文書（本体の作業ツリーにある今の版。未コミットでもよい）
docs() { for f in $REQ $RULES $CONTEXT_FILES $CHECKLIST; do [ -f "$REPO/$f" ] && echo "$f"; done; }

setup() {
# 1. 作業場所を作る
rm -rf "$W"; git -C "$REPO" worktree prune
if [ -n "${BASE:-}" ]; then
  # 前の写しの上で続ける（研究の続きなど）。BASE の git の最初の状態がそのまま基準になる
  cp -a "$BASE" "$W"
else
  # 本体の git worktree（ブランチ herdr/<名>）。本体の途中の作業は入れない（COMMIT_DIRTY=1 なら先にコミットする）
  if [ -n "${COMMIT_DIRTY:-}" ] && [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    git -C "$REPO" add -A && git -C "$REPO" -c user.name=Claude -c user.email=claude@noreply.invalid commit -q -m "herdr/$name を起動する前の作業"
  fi
  git -C "$REPO" worktree add -q -B "herdr/$name" "$W" HEAD
fi
for f in $(docs); do mkdir -p "$W/$(dirname "$f")" && cp "$REPO/$f" "$W/$f"; done
for d in $EXTRA_DIRS; do [ -d "$REPO/$d" ] && mkdir -p "$W/$(dirname "$d")" && cp -r "$REPO/$d" "$W/$d"; done
# git の外で読ませたいもの（例 EXTRA="runs/history.jsonl"）は、写しに読み取り専用で置く（パッチには入らない）
for f in ${EXTRA:-}; do mkdir -p "$W/$(dirname "$f")" && cp "$REPO/$f" "$W/$f" && chmod a-w "$W/$f"; done
[ -f "$REPO/$REQ" ] || log "警告: 依頼文 $REPO/$REQ がない"
log "写しを作った: $W（実装 $IMPL_AGENT・レビュー $REV_AGENT・追加: ${EXTRA:-なし}）"
}

make_tab() {
# 2. タブとペイン
local tab; tab=$(herdr tab create --workspace "$WS" --label "$name" --cwd "$W")
p_impl=$(echo "$tab" | js result.root_pane.pane_id)
tab_id=$(echo "$tab" | js result.tab.tab_id)
p_rev=$(herdr pane split "$p_impl" --direction right --cwd "$W" --no-focus | js result.pane.pane_id)
herdr pane rename "$p_impl" "実装" >/dev/null; herdr pane rename "$p_rev" "レビュー" >/dev/null
log "タブ: $tab_id（実装 $p_impl・レビュー $p_rev）"
}

# RESUME=1: 作業場所とタブはもうある（台本だけ付け替えるとき）。ログからタブとペインを読む
resume_tab() {
  local line; line=$(grep 'タブ: ' "$L" | tail -1)
  tab_id=$(echo "$line" | sed -E 's/.*タブ: ([^（]+)（.*/\1/')
  p_impl=$(echo "$line" | sed -E 's/.*実装 ([^・]+)・.*/\1/')
  p_rev=$(echo "$line" | sed -E 's/.*レビュー ([^）]+)）.*/\1/')
  log "台本を付け替えた（タブ $tab_id・実装 $p_impl・レビュー $p_rev）"
}
make_patch() { (cd "$W" && git add -A && git diff --cached --binary -- . $PATCH_EXCLUDE > "$WORK/patch-$name.diff"); }

status() { herdr agent get "$1" 2>/dev/null | js result.agent.agent_status 2>/dev/null || echo gone; }

# エージェント（種類 $kind）を立ち上げ、依頼を送り、終わりの印（$WORK/done-<agent>）ができるまで見届ける。
# 依頼は 1 行にする。長い指示はファイルに書いて「読んで従う」と頼む。
# herdr の状態（idle・done）は仕事の終わりを意味しない（途中で質問して止まっても done になる）ので、終わりは印で判定する。
run_agent() {
  local kind=$1 agent=$2 pane=$3 task=$4 mark=$WORK/done-$2
  local goal="$task 途中で質問せず最後までやり切り、全部終わったら最後に touch $mark を実行する（この印で次の段に進む）。"
  local first=1
  if herdr agent get "$agent" >/dev/null 2>&1; then
    first=0; log "$agent: もう動いているので、終わりを待つだけにする"
  else
    rm -f "$mark"
    "${kind}_start" "$agent" "$pane" "$W" || { log "$agent: 起動できなかった"; return 1; }
  fi
  for i in 1 2 3; do
    if [ $first = 1 ] || [ $i -gt 1 ]; then "${kind}_send" "$agent" "$goal" "$mark" || { log "$agent: 依頼が届かない"; return 1; }; fi
    # 応答の完了は herdr の出来事で待つ（idle・done・blocked になった瞬間に返る。ポーリングしない）
    # 送った直後はまだ idle・done のことがあり、そのまま待つとすぐ返った。先に working を待つ。
    # 手番の合間に一瞬 idle になることがある。20 秒おいてまた working なら、渡し直さずに待ち続ける
    while :; do
      herdr agent wait "$agent" --until working --timeout 120000 >/dev/null 2>&1
      herdr agent wait "$agent" >/dev/null 2>&1
      [ -e "$mark" ] && break
      s=$(status "$agent"); [ "$s" = blocked ] && break
      sleep 20; [ "$(status "$agent")" = working ] || break
    done
    s=$(status "$agent")
    # 確認の画面で止まったら台本を終える（Claude がこの終わりで起きて、ペインを見て答える）
    [ "$s" = blocked ] && { log "$agent: 確認の画面で止まった"; make_patch; echo blocked > "$WORK/reviewed-$name"; exit 2; }
    [ -e "$mark" ] && { log "$agent: 終わった"; rm -f "$mark"; return 0; }
    log "$agent: 印がないまま止まった（状態 $s、$i 回目）→ 同じ目標をもう一度"
    goal="まだ終わっていない。$goal"; first=1
    sleep 5
  done
  log "$agent: 3 回目標を渡しても終わらなかった"; return 1
}

main() {
  # RESUME=newtab: 写しは残っているがタブが無い（PC や herdr の再起動のあと）。タブだけ作り直す
  if [ "${RESUME:-}" = newtab ]; then make_tab; elif [ -n "${RESUME:-}" ]; then resume_tab; else setup; make_tab; fi
short=$(echo "$name" | tr -cd 'a-z0-9-' | cut -c1-24)

# 3. 実装
# SKIP_IMPL=1: 実装は済んでいて、レビューからやり直すとき
rules_read=""; for f in $RULES $CONTEXT_FILES; do [ -f "$W/$f" ] && rules_read="$rules_read・$f"; done
[ -n "${SKIP_IMPL:-}" ] || run_agent "$IMPL_AGENT" "impl-$short" "$p_impl" "$REQ${rules_read} を読み、まず設計の下見を $DESIGN に書いてから（10 行程度: 触るファイル・やり方・既存とかぶる所。最後に 1 行「結論: 続行」か「結論: STOP（理由）」。STOP は先に組み直さないと依頼が成り立たないときだけ。STOP ならそこで終える）、その依頼どおりに作業し、報告を $REPORT に書いてください（結論 3 行／変えたファイル／流したテストと出力／確かめたことと推測／残った問題）。作業場所はこの写し（$W）だけ。$REPO 本体には一切書き込まない。自分ではコミットしない。" \
  || { make_patch; echo failed > "$WORK/reviewed-$name"; log "実装で止まった"; exit 1; }
make_patch; log "実装のパッチ: $WORK/patch-$name.diff"
# 設計の下見が「STOP」なら、レビューに進まず Claude の判断を待つ
if grep -q '^結論: *STOP' "$W/$DESIGN" 2>/dev/null; then
  echo stopped > "$WORK/reviewed-$name"; log "設計の下見で STOP: $W/$DESIGN を読んで判断する"; exit 0
fi
herdr pane close "$p_impl" >/dev/null 2>&1   # 使い終わったペインは閉じる

# 4. レビュー（別のエージェント）。指示は写しの外のファイルに置く（パッチに入れない）
RT=$WORK/review-task-$name.md
checklist_line=""; [ -f "$W/$CHECKLIST" ] && checklist_line="$CHECKLIST の観点も使う。"
cat > "$RT" <<EOT
あなたはレビュー担当です。写し（$W）には、依頼 $REQ に対する別の担当の実装が入っています（最初の状態との差分は git diff HEAD、新しいファイルは git status で分かる）。次の順で作業してください。
1. 依頼文${rules_read}と、実装の担当が書いた設計の下見 $DESIGN を読み、差分を全部読む。下見と実物を照らす: 寄せると書いたのに寄せていない、同じ処理が 2 か所以上に増えた、は直す。${checklist_line}
2. 依頼の要件を 1 つずつ満たしているか確かめる。依頼文に書かれた文言を一字一句使っているか（勝手な言い換え・【仮】の付け忘れ・付けすぎ）。共通の決まりの「守ること」を破っていないか。
3. 不具合・抜け・テストの穴・報告と実際の食い違いを探す。実際にテストを流して確かめる（報告を信じない）。
4. 見つけた問題は、この写しの中で直す。直せないもの・判断が要るものは直さずに書く。
5. レビューの報告を $REVIEW に書く: 結論 3 行（取り込んでよいか）／見つけた問題と直したこと（ファイルと行）／直していない問題と理由／依頼との食い違い／流したテストと出力／確かめたことと推測。実装の報告（$REPORT）に誤りがあれば、そこも直す。
作業場所はこの写しだけ。$REPO 本体には一切書き込まない。自分ではコミットしない。
EOT
run_agent "$REV_AGENT" "rev-$short" "$p_rev" "$RT を読み、その指示どおりにこの写しの実装をレビューして直し、レビューの報告を書く。" \
  || { make_patch; echo failed > "$WORK/reviewed-$name"; log "レビューで止まった"; exit 1; }
make_patch
# worktree ならブランチにコミットする（作者は実装のエージェント）。Claude は最終チェックのあと本体へマージする
if [ -z "${BASE:-}" ]; then
  (cd "$W" && git add -A && git -c "user.name=$IMPL_AGENT" -c "user.email=$IMPL_AGENT@noreply.invalid" commit -q -m "$name（$IMPL_AGENT の実装と$REV_AGENT のレビュー）") && log "ブランチ herdr/$name にコミットした"
fi
echo reviewed > "$WORK/reviewed-$name"
log "レビューまで終わった"
herdr tab close "$tab_id" >/dev/null 2>&1   # 終わったらタブごと閉じる。止まったとき（failed・blocked）は Claude が見るので残す
}

main "$@"; exit
