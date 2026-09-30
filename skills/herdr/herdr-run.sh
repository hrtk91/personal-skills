#!/bin/bash
# 使い方: herdr-run.sh <依頼名>
#   $HANDOFF/$TASK_PREFIX<名>.md（既定 handoff/<名>.md）を、herdr のタブ「<名>」でエージェントに実装させ（左のペイン）、
#   終わったら別のエージェントにレビューして直させる（右のペイン）。どちらもエージェントの画面のまま見られる。
#   エージェントは agents/<種類>.sh に切り出してある（codex・pi）。IMPL_AGENT・REV_AGENT で選ぶ。
# 置き場 $HERDR_WORK（既定 ~/.cache/herdr-<リポジトリ名>）:
#   wt/<名>/             本体の写し（git worktree。エージェントが書いてよいのはここだけ）
#   patch-<名>.diff      実装のあとと、レビューのあとに作り直す
#   reviewed-<名>        終わりの印。中身は reviewed（レビューまで完了）・stopped（設計の下見が STOP）・failed・blocked
#   herdr-<名>.log       この台本の進み具合
# herdr の中（HERDR_ENV=1）で、Claude のサンドボックスの外から動かす。
# プロジェクトごとの設定は $REPO/.herdr.env（bash。SKILL.md の「設定」を参照）。
set -uo pipefail
[ "$#" = 1 ] || { echo "使い方: herdr-run.sh <依頼名>" >&2; exit 1; }
name=$1
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo "依頼名は英数字・_・-で指定してください" >&2; exit 1; }
SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=${REPO:-$(git rev-parse --show-toplevel)}
[ -f "${HERDR_CONF:-$REPO/.herdr.env}" ] && . "${HERDR_CONF:-$REPO/.herdr.env}"
WORK_NAME=${WORK_NAME:-herdr-$(basename "$REPO")}
WORK=${HERDR_WORK:-${CODEX_WORK:-$HOME/.cache/$WORK_NAME}}
W=$WORK/wt/$name
WS=${HERDR_WORKSPACE_ID:?herdr の中で動かしてください}
HANDOFF=${HANDOFF:-handoff}
RULES=${RULES-$HANDOFF/rules.md}                 # 共通の決まりの文書（空白区切り。無いものは飛ばす）
CONTEXT_FILES=${CONTEXT_FILES-"CLAUDE.md AGENTS.md"}  # 写しにも入れて読ませる、プロジェクトの説明
CHECKLIST=${CHECKLIST-$HANDOFF/review-checklist.md}   # あればレビューの観点に足す
DESIGN_RULES=${DESIGN_RULES:-}                    # 指定した文書の手順・結論の書式を、既定の下見より優先する
EXTRA_DIRS=${EXTRA_DIRS:-}                        # git の外にある、写しにコピーしたいディレクトリ
BASE_REFRESH_EXTRA_DIRS=${BASE_REFRESH_EXTRA_DIRS:-1} # BASE でも本体からコピーし直す。0 なら前の写しの在庫を保つ
PATCH_EXCLUDE=${PATCH_EXCLUDE:-}                  # パッチに入れないパス（例 ":!*.png :!saves"）
IMPL_AGENT=${IMPL_AGENT:-${AGENT:-codex}}; REV_AGENT=${REV_AGENT:-$IMPL_AGENT}
TASK_PREFIX=${TASK_PREFIX:-}; BRANCH_PREFIX=${BRANCH_PREFIX:-herdr}
BRANCH=$BRANCH_PREFIX/$name
REQ=$HANDOFF/$TASK_PREFIX$name.md; DESIGN=$HANDOFF/$TASK_PREFIX$name-design.md
REPORT=$HANDOFF/$TASK_PREFIX$name-report.md; REVIEW=$HANDOFF/$TASK_PREFIX$name-review.md
case $IMPL_AGENT in codex) author=Codex ;; pi) author=Pi ;; *) author=$IMPL_AGENT ;; esac
COMMIT_NAME=${COMMIT_NAME:-$author}; COMMIT_EMAIL=${COMMIT_EMAIL:-$IMPL_AGENT@noreply.invalid}
DIRTY_COMMIT_NAME=${DIRTY_COMMIT_NAME:-Claude}; DIRTY_COMMIT_EMAIL=${DIRTY_COMMIT_EMAIL:-claude@noreply.invalid}
mkdir -p "$WORK" || exit 1
L=$WORK/herdr-$name.log
log() { echo "$(date +%F' '%T) $*" >> "$L"; }
js() { python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }
for f in "$SKILL_DIR"/agents/*.sh; do . "$f"; done   # codex_start・codex_send・pi_start・pi_send ...

# 写しに入れる文書（本体の作業ツリーにある今の版。未コミットでもよい）
docs() { for f in $REQ $RULES $CONTEXT_FILES $CHECKLIST $DESIGN_RULES; do [ -f "$REPO/$f" ] && echo "$f"; done; }

setup() {
# 1. 作業場所を作る
[ ! -e "$W" ] || { log "写しが既にある: RESUME=1 または RESUME=newtab を使う"; return 1; }
[ -f "$REPO/$REQ" ] || { log "依頼文 $REQ がない"; return 1; }
mkdir -p "$(dirname "$W")" || return 1
if [ -n "${BASE:-}" ]; then
  # 前の写しの上で続ける（研究の続きなど）。BASE の git の最初の状態がそのまま基準になる
  # .git ファイルをそのままコピーすると、前の worktree の index を書き換えるので git は独立させる
  git clone -q --no-hardlinks --no-checkout -- "$BASE" "$W" || return 1
  tar -C "$BASE" --exclude=./.git -cf - . | tar -C "$W" -xf - || return 1
  git -C "$W" reset -q HEAD -- . || return 1
else
  # 本体の git worktree。本体の途中の作業は入れない（COMMIT_DIRTY=1 なら先にコミットする）
  if [ "${COMMIT_DIRTY:-}" = 1 ] && [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    git -C "$REPO" add -A && git -C "$REPO" -c "user.name=$DIRTY_COMMIT_NAME" -c "user.email=$DIRTY_COMMIT_EMAIL" commit -q -m "$BRANCH を起動する前の作業" || return 1
  fi
  # 同名の既存ブランチをリセットしない。続きは RESUME を使う
  git -C "$REPO" worktree add -q -b "$BRANCH" "$W" HEAD || return 1
fi
for f in $(docs); do mkdir -p "$W/$(dirname "$f")" && cp -f "$REPO/$f" "$W/$f" || return 1; done
if [ -z "${BASE:-}" ] || [ "$BASE_REFRESH_EXTRA_DIRS" != 0 ]; then
  for d in $EXTRA_DIRS; do
    [ -d "$REPO/$d" ] || continue
    mkdir -p "$W/$d" && cp -r "$REPO/$d/." "$W/$d/" || return 1
  done
fi
# git の外で読ませたいもの（例 EXTRA="runs/history.jsonl"）は、写しに読み取り専用で置く（パッチには入らない）
for f in ${EXTRA:-}; do mkdir -p "$W/$(dirname "$f")" && cp -f "$REPO/$f" "$W/$f" && chmod a-w "$W/$f" || return 1; done
log "写しを作った: $W（実装 $IMPL_AGENT・レビュー $REV_AGENT・追加: ${EXTRA:-なし}）"
}

make_tab() {
# 2. タブとペイン
local tab
local -a pane_env=()
[ -z "${CODEX_HOME:-}" ] || pane_env+=(--env "CODEX_HOME=$CODEX_HOME")
tab=$(herdr tab create --workspace "$WS" --label "$name" --cwd "$W" --no-focus "${pane_env[@]}") || return 1
p_impl=$(echo "$tab" | js result.root_pane.pane_id)
tab_id=$(echo "$tab" | js result.tab.tab_id)
p_rev=$(herdr pane split "$p_impl" --direction right --cwd "$W" --no-focus "${pane_env[@]}" | js result.pane.pane_id) || return 1
herdr pane rename "$p_impl" "実装" >/dev/null; herdr pane rename "$p_rev" "レビュー" >/dev/null
log "タブ: $tab_id（実装 $p_impl・レビュー $p_rev）"
}

# RESUME=1: 作業場所とタブはもうある（台本だけ付け替えるとき）。ログからタブとペインを読む
resume_tab() {
  local line; line=$(grep 'タブ: ' "$L" | tail -1)
  [ -n "$line" ] || { log "再開するタブの記録がない"; return 1; }
  tab_id=$(echo "$line" | sed -E 's/.*タブ: ([^（]+)（.*/\1/')
  p_impl=$(echo "$line" | sed -E 's/.*実装 ([^・]+)・.*/\1/')
  p_rev=$(echo "$line" | sed -E 's/.*レビュー ([^）]+)）.*/\1/')
  log "台本を付け替えた（タブ $tab_id・実装 $p_impl・レビュー $p_rev）"
}
make_patch() {
  local f
  local -a excludes
  read -r -a excludes <<< "$PATCH_EXCLUDE"
  for f in ${EXTRA:-}; do excludes+=(":(exclude,literal)$f"); done
  # 除外はパッチだけでなく、台本のコミットにも適用する
  (cd "$W" && git reset -q HEAD -- . &&
    git ls-files -z --cached --others --exclude-standard -- . "${excludes[@]}" |
      git --literal-pathspecs add -A --pathspec-from-file=- --pathspec-file-nul &&
    git diff --cached --binary -- . "${excludes[@]}" > "$WORK/patch-$name.diff")
}

status() {
  local result
  if result=$(herdr agent get "$1" 2>/dev/null); then
    echo "$result" | js result.agent.agent_status 2>/dev/null || echo unknown
  else
    # get の一時的な失敗と、担当が本当に消えたことを分ける
    result=$(herdr agent list 2>/dev/null) || { echo unknown; return; }
    python3 -c 'import json,sys
agents=json.load(sys.stdin)["result"]["agents"]
print(next((a["agent_status"] for a in agents if a.get("name")==sys.argv[1]), "gone"))' "$1" <<< "$result" 2>/dev/null || echo unknown
  fi
}

# エージェント（種類 $kind）を立ち上げ、依頼を送り、終わりの印（$WORK/done-<agent>）ができるまで見届ける。
# 依頼は 1 行にする。長い指示はファイルに書いて「読んで従う」と頼む。
# herdr の状態（idle・done）は仕事の終わりを意味しない（途中で質問して止まっても done になる）ので、終わりは印で判定する。
run_agent() {
  local kind=$1 agent=$2 pane=$3 task=$4 mark=$WORK/done-$2
  local goal="$task 途中で質問せず最後までやり切り、全部終わったら最後に touch $mark を実行する（この印で次の段に進む）。"
  local first=1 existing i s
  existing=$(herdr agent get "$agent" 2>/dev/null) || existing=
  if [ -n "$existing" ]; then
    [ "$(echo "$existing" | js result.agent.pane_id)" = "$pane" ] || { log "$agent: 別のペインのエージェントには触らない"; return 1; }
    first=0; log "$agent: もう動いているので、終わりを待つだけにする"
  else
    rm -f "$mark"
    "${kind}_start" "$agent" "$pane" "$W" || { log "$agent: 起動できなかった"; return 1; }
  fi
  for i in 1 2 3; do
    if [ "$first" = 1 ] || [ "$i" -gt 1 ]; then "${kind}_send" "$agent" "$goal" "$mark" || { log "$agent: 依頼が届かない"; return 1; }; fi
    # 応答の完了は herdr の出来事で待つ（idle・done・blocked になった瞬間に返る。ポーリングしない）
    # 送った直後はまだ idle・done のことがあり、そのまま待つとすぐ返った。先に working を待つ。
    # 手番の合間に一瞬 idle になることがある。20 秒おいてまた working なら、渡し直さずに待ち続ける
    while :; do
      [ -e "$mark" ] && break
      herdr agent wait "$agent" --until working --timeout 120000 >/dev/null 2>&1
      herdr agent wait "$agent" >/dev/null 2>&1
      [ -e "$mark" ] && break
      s=$(status "$agent"); [ "$s" = blocked ] && break
      sleep 20
      s=$(status "$agent")
      case $s in working|unknown) continue ;; *) break ;; esac
    done
    s=$(status "$agent")
    # 確認の画面で止まったら台本を終える（Claude がこの終わりで起きて、ペインを見て答える）
    [ "$s" = blocked ] && { log "$agent: 確認の画面で止まった"; return 2; }
    [ -e "$mark" ] && { log "$agent: 終わった"; rm -f "$mark"; return 0; }
    log "$agent: 印がないまま止まった（状態 $s、$i 回目）→ 同じ目標をもう一度"
    goal="まだ終わっていない。$goal"; first=1
    sleep 5
  done
  log "$agent: 3 回目標を渡しても終わらなかった"; return 1
}

main() {
  local short rules_read design_instruction checklist_line RT rc
  for kind in "$IMPL_AGENT" "$REV_AGENT"; do
    declare -F "${kind}_start" >/dev/null && declare -F "${kind}_send" >/dev/null || {
      log "未対応のエージェント: $kind"; echo failed > "$WORK/reviewed-$name"; return 1;
    }
  done
  git check-ref-format "$BRANCH" >/dev/null || { log "不正なブランチ名: $BRANCH"; return 1; }
  rm -f "$WORK/reviewed-$name"
  # RESUME=newtab: 写しは残っているがタブが無い（PC や herdr の再起動のあと）。タブだけ作り直す
  if [ -n "${RESUME:-}" ]; then
    [ -d "$W" ] || { log "再開する写しがない"; echo failed > "$WORK/reviewed-$name"; return 1; }
    if [ "$RESUME" = newtab ]; then make_tab; else resume_tab; fi
    rc=$?
  else
    setup && make_tab; rc=$?
  fi
  [ "$rc" = 0 ] || { echo failed > "$WORK/reviewed-$name"; log "準備で止まった"; return 1; }
short=$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-24)

# 3. 実装
# SKIP_IMPL=1: 実装は済んでいて、レビューからやり直すとき
rules_read=""; for f in $RULES $CONTEXT_FILES $DESIGN_RULES; do [ -f "$W/$f" ] && rules_read="$rules_read・$f"; done
design_instruction="10 行程度: 触るファイル・やり方・既存とかぶる所。最後に 1 行「結論: 続行」か「結論: STOP（理由）」。STOP は先に組み直さないと依頼が成り立たないときだけ。STOP ならそこで終える"
[ -z "$DESIGN_RULES" ] || design_instruction="$DESIGN_RULES の手順と結論の書式に従う。結論が STOP なら実装せずそこで終える"
if [ "${SKIP_IMPL:-}" != 1 ]; then
  run_agent "$IMPL_AGENT" "impl-$short" "$p_impl" "$REQ${rules_read} を読み、まず設計の下見を $DESIGN に書いてから（$design_instruction）、その依頼どおりに作業し、報告を $REPORT に書いてください（結論 3 行／変えたファイル／流したテストと出力／確かめたことと推測／残った問題）。作業場所はこの写し（$W）だけ。$REPO 本体には一切書き込まない。自分ではコミットしない。"
  rc=$?
  if [ "$rc" != 0 ]; then
    make_patch || log "パッチを作れなかった"
    if [ "$rc" = 2 ]; then echo blocked > "$WORK/reviewed-$name"; else echo failed > "$WORK/reviewed-$name"; fi
    log "実装で止まった"; return "$rc"
  fi
fi
make_patch || { echo failed > "$WORK/reviewed-$name"; log "実装のパッチを作れなかった"; return 1; }
log "実装のパッチ: $WORK/patch-$name.diff"
# 設計の下見が「STOP」なら、レビューに進まず Claude の判断を待つ
if grep -q '^結論: *STOP' "$W/$DESIGN" 2>/dev/null; then
  echo stopped > "$WORK/reviewed-$name"; log "設計の下見で STOP: $W/$DESIGN を読んで判断する"; return 0
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
run_agent "$REV_AGENT" "rev-$short" "$p_rev" "$RT を読み、その指示どおりにこの写しの実装をレビューして直し、レビューの報告を書く。"
rc=$?
if [ "$rc" != 0 ]; then
  make_patch || log "パッチを作れなかった"
  if [ "$rc" = 2 ]; then echo blocked > "$WORK/reviewed-$name"; else echo failed > "$WORK/reviewed-$name"; fi
  log "レビューで止まった"; return "$rc"
fi
make_patch || { echo failed > "$WORK/reviewed-$name"; log "レビューのパッチを作れなかった"; return 1; }
# worktree ならブランチにコミットする（作者は実装のエージェント）。Claude は最終チェックのあと本体へマージする
if [ -z "${BASE:-}" ]; then
  if ! git -C "$W" diff --cached --quiet; then
    git -C "$W" -c "user.name=$COMMIT_NAME" -c "user.email=$COMMIT_EMAIL" commit -q -m "$name（$IMPL_AGENT の実装と$REV_AGENT のレビュー）" || {
      echo failed > "$WORK/reviewed-$name"; log "コミットできなかった"; return 1;
    }
    log "ブランチ $BRANCH にコミットした（作者 $COMMIT_NAME <$COMMIT_EMAIL>）"
  fi
fi
herdr tab close "$tab_id" >/dev/null 2>&1 || { echo failed > "$WORK/reviewed-$name"; log "タブを閉じられなかった"; return 1; }
echo reviewed > "$WORK/reviewed-$name"
log "レビューまで終わった"
}

main "$@"; exit
