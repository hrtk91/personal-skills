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
#   herdr-run.sh --cleanup <名> [--discard]   使い終わった写し・ブランチ・タブを片付ける（--discard は取り込んでいない仕事を捨てる）
#   herdr-run.sh --stale                      24 時間より古く、台本の動いていない写しを並べる
# TASK_ID=<台帳の id> を付けると、台帳（tools/task-ledger）に始まりと終わりを書く。そのときは作業役どうしのレビューを
#   飛ばし、実装をブランチにコミットして「確かめ中」にする（確かめとレビューはハーネスの次の段がやる）。
set -uo pipefail
# bash は台本を読みながら動くので、動いている最中にこのファイルを書き換えると、動いている台本が壊れる
# （10/28、書き換えで走行中の台本が構文エラーで止まり、台帳に終わりを書けなかった）。自分の写しから動かす。
if [ -z "${HERDR_RUN_SELF:-}" ]; then
  HERDR_RUN_SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  copy=$(mktemp -d "${TMPDIR:-/tmp}/herdr-run.XXXXXX") && cp "${BASH_SOURCE[0]}" "$copy/herdr-run.sh" \
    && HERDR_RUN_SELF=$HERDR_RUN_SELF exec bash "$copy/herdr-run.sh" "$@"
fi
mode=run discard=0
case ${1:-} in
  --cleanup) mode=cleanup; shift; [ "${2:-}" = --discard ] && { discard=1; set -- "$1"; } ;;
  --stale) mode=stale; shift; set -- stale-list ;;
esac
[ "$#" = 1 ] || { echo "使い方: herdr-run.sh <依頼名> | --cleanup <名> [--discard] | --stale" >&2; exit 1; }
name=$1
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo "依頼名は英数字・_・-で指定してください" >&2; exit 1; }
SKILL_DIR=$HERDR_RUN_SELF
REPO=${REPO:-$(git rev-parse --show-toplevel)}
[ -f "${HERDR_CONF:-$REPO/.herdr.env}" ] && . "${HERDR_CONF:-$REPO/.herdr.env}"
WORK_NAME=${WORK_NAME:-herdr-$(basename "$REPO")}
WORK=${HERDR_WORK:-${CODEX_WORK:-$HOME/.cache/$WORK_NAME}}
W=$WORK/wt/$name
if [ "$mode" = run ]; then WS=${HERDR_WORKSPACE_ID:?herdr の中で動かしてください}; fi
HANDOFF=${HANDOFF:-handoff}
RULES=${RULES-$HANDOFF/rules.md}                 # 共通の決まりの文書（空白区切り。無いものは飛ばす）
CONTEXT_FILES=${CONTEXT_FILES-"CLAUDE.md AGENTS.md"}  # 写しにも入れて読ませる、プロジェクトの説明
CHECKLIST=${CHECKLIST-$HANDOFF/review-checklist.md}   # あればレビューの観点に足す
DESIGN_RULES=${DESIGN_RULES:-}                    # 指定した文書の手順・結論の書式を、既定の下見より優先する
EXTRA_DIRS=${EXTRA_DIRS:-}                        # git の外にある、写しにコピーしたいディレクトリ
BASE_REFRESH_EXTRA_DIRS=${BASE_REFRESH_EXTRA_DIRS:-1} # BASE でも本体からコピーし直す。0 なら前の写しの在庫を保つ
PATCH_EXCLUDE=${PATCH_EXCLUDE:-}                  # パッチに入れないパス（例 ":!*.png :!assets"）
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
TASK_BIN=${TASK_BIN:-$SKILL_DIR/../../tools/task-ledger/bin/task}

# 写しに入れる文書（本体の作業ツリーにある今の版。未コミットでもよい）
docs() { for f in $REQ $RULES $CONTEXT_FILES $CHECKLIST $DESIGN_RULES; do [ -f "$REPO/$f" ] && echo "$f"; done; }

setup() {
# 1. 作業場所を作る
[ ! -e "$W" ] || { log "写しが既にある: RESUME=1 または RESUME=newtab を使う"; return 1; }
if [ -n "${TASK_ISSUE_ID:-}" ]; then
  [ -n "${TASK_ID:-}" ] || { log "Issue 仕事には TASK_ID が必要"; return 1; }
else
  [ -f "$REPO/$REQ" ] || { log "依頼文 $REQ がない"; return 1; }
fi
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
if [ -n "${TASK_ISSUE_ID:-}" ]; then
  mkdir -p "$W/$(dirname "$REQ")" || return 1
  "$TASK_BIN" issue brief "$TASK_ISSUE_ID" > "$W/$REQ" || { log "Issue $TASK_ISSUE_ID の依頼文を作れない"; return 1; }
  # The Issue-generated prompt is run input, not a repository artifact; keep it out of the patch and commit.
  PATCH_EXCLUDE="${PATCH_EXCLUDE:+$PATCH_EXCLUDE }:!$REQ"
fi
if [ -z "${BASE:-}" ] || [ "$BASE_REFRESH_EXTRA_DIRS" != 0 ]; then
  for d in $EXTRA_DIRS; do
    [ -d "$REPO/$d" ] || continue
    mkdir -p "$W/$d" && cp -r "$REPO/$d/." "$W/$d/" || return 1
  done
fi
# git の外で読ませたいもの（例 EXTRA="data/history.jsonl"）は、写しに読み取り専用で置く（パッチには入らない）
for f in ${EXTRA:-}; do mkdir -p "$W/$(dirname "$f")" && cp -f "$REPO/$f" "$W/$f" && chmod a-w "$W/$f" || return 1; done
log "写しを作った: $W（実装 $IMPL_AGENT・レビュー $REV_AGENT・追加: ${EXTRA:-なし}）"
preflight || return 1
# 作業役を起こす前に、worktree 上で確かめを一度流して依存コマンドの欠落を検出する。
# 実装前に不成立な通常の検査 (多くは終了 1) は続行し、command not found (127) のみ環境失敗にする。
if [ -n "${TASK_CHECK:-}" ]; then
  local_check_output=$(cd "$W" && timeout 300 bash -c "$TASK_CHECK" 2>&1); local_check_rc=$?
  if [ "$local_check_rc" = 127 ] && grep -qi 'command not found' <<< "$local_check_output"; then
    log "起動前の確かめで環境の失敗（終了コード 127）: $local_check_output"
    echo environment-failed > "$WORK/reviewed-$name"
    return 2
  fi
  log "起動前の部品確認: 終了コード $local_check_rc（0 以外は実装前の未完了として続行）"
fi
}

# 依頼文が名指すファイル（src/a.ts や handoff/b.md の形）
named_files() { grep -oE '(^|[^A-Za-z0-9_./-])[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+' "$1" 2>/dev/null | sed -E 's/^[^A-Za-z0-9_.-]//' | sort -u; }

# 動いているほかの herdr の台本の依頼名
running_tasks() {
  local pid args
  for pid in $(pgrep -f 'herdr-run\.sh [A-Za-z0-9]'); do
    [ "$pid" = $$ ] && continue
    args=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null) || continue
    [[ "$args" =~ herdr-run\.sh\ ([A-Za-z0-9][A-Za-z0-9_-]*)( |$) ]] && [ "${BASH_REMATCH[1]}" != "$name" ] && echo "${BASH_REMATCH[1]}"
  done | sort -u
}

# 起動前の確かめ（2026-10-26: 写しに無い依頼文を指した・自分で「待ち」と書いた仕事を出した・同じファイルを触る仕事を重ねた）
preflight() {
  local f other theirs overlap
  # 1. 依頼文が指す handoff の文書が写しに無ければ、本体からコピーする。どこにも無ければ止める（自分の出力の報告・下見・レビューは除く）
  for f in $(named_files "$W/$REQ" | grep "^$HANDOFF/"); do
    case $f in "$DESIGN"|"$REPORT"|"$REVIEW") continue ;; esac
    [ -e "$W/$f" ] && continue
    if [ -e "$REPO/$f" ]; then mkdir -p "$W/$(dirname "$f")" && cp -r "$REPO/$f" "$W/$f" && log "依頼文が指す $f を本体から写しにコピーした（本体で未コミット）"
    else case $f in *-report.md|*-design.md|*-review.md|*-shots*) continue ;; esac
      log "依頼文が指す $f が本体にも写しにも無い。依頼文を直してから出す"; return 1; fi
  done
  # 2. STATE に「待ち」と書いた仕事は出さない（WAIT_OK=1 で出す）
  if [ "${WAIT_OK:-}" != 1 ] && [ -f "$REPO/${STATE_FILE:-STATE.md}" ] && grep -E '待ち' "$REPO/${STATE_FILE:-STATE.md}" | grep -qF "$name"; then
    log "${STATE_FILE:-STATE.md} にこの仕事の「待ち」がある: $(grep -E '待ち' "$REPO/${STATE_FILE:-STATE.md}" | grep -F "$name" | head -1 | cut -c1-160)。条件を確かめて WAIT_OK=1 で出し直す"; return 1
  fi
  # 3. 動いているほかの仕事と、触るファイルが重なれば止める（OVERLAP_OK=1 で出す）
  # 台帳から出た仕事は、台帳が宣言した触るファイルで重なりを見てから出している。依頼文に読む物として
  # 名前が出ただけのファイルで止めないよう、ここでは見ない（10/28、調べ物の依頼文が src を名指ししていて止まった）
  [ -n "${TASK_ID:-}" ] && return 0
  for other in $(running_tasks); do
    theirs=$( { named_files "$REPO/$HANDOFF/$TASK_PREFIX$other.md"
      git -C "$WORK/wt/$other" diff --name-only HEAD 2>/dev/null
      git -C "$WORK/wt/$other" ls-files --others --exclude-standard 2>/dev/null; } | grep -v "^$HANDOFF/" | sort -u)
    overlap=$(comm -12 <(named_files "$W/$REQ" | grep -v "^$HANDOFF/") <(echo "$theirs") | tr '\n' ' ')
    if [ -n "$overlap" ] && [ "${OVERLAP_OK:-}" != 1 ]; then
      log "動いている仕事 $other と触るファイルが重なる: $overlap。先に $other を取り込むか、OVERLAP_OK=1 で出す"; return 1
    fi
  done
  return 0
}

# 片付け: 写し・ブランチ・タブ。取り込んでいないブランチは --discard のときだけ消す
cleanup_task() {
  local line tab f merged=0
  if running_tasks | grep -qx "$name" || pgrep -f "herdr-run\.sh $name( |\$)" | grep -vx $$ >/dev/null; then
    echo "台本 $name がまだ動いている。止めてから片付ける" >&2; return 1
  fi
  git -C "$REPO" rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null && git -C "$REPO" merge-base --is-ancestor "$BRANCH" HEAD && merged=1
  if git -C "$REPO" rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null && [ "$merged" = 0 ] && [ "$discard" = 0 ]; then
    echo "ブランチ $BRANCH は取り込まれていない。捨てるなら --discard を付ける" >&2; return 1
  fi
  # 報告・下見・レビューは本体に無ければ残す（後で振り返るため）
  for f in "$DESIGN" "$REPORT" "$REVIEW"; do
    [ -f "$W/$f" ] && [ ! -e "$REPO/$f" ] && cp "$W/$f" "$REPO/$f" && echo "残した: $f"
  done
  line=$(grep 'タブ: ' "$L" 2>/dev/null | tail -1)
  tab=$(echo "$line" | sed -nE 's/.*タブ: ([^（]+)（.*/\1/p')
  [ -z "$tab" ] || herdr tab close "$tab" >/dev/null 2>&1
  if [ -d "$W" ]; then
    chmod -R u+w "$W" 2>/dev/null
    git -C "$REPO" worktree remove --force "$W" 2>/dev/null || rm -rf "${W:?}"
  fi
  git -C "$REPO" worktree prune
  if git -C "$REPO" rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then git -C "$REPO" branch -q -D "$BRANCH"; fi
  rm -f "$WORK/done-impl-$name" "$WORK/done-rev-$name"
  if [ "$merged" = 1 ]; then log "片付けた（取り込み済み）"; else log "片付けた（捨てた）"; fi
  echo "片付けた: $name"
}

stale_tasks() {
  local d n
  for d in "$WORK"/wt/*/; do
    [ -d "$d" ] || continue; n=$(basename "$d")
    [ -n "$(find "$d" -maxdepth 0 -mmin +1440)" ] || continue
    pgrep -f "herdr-run\.sh $n( |\$)" >/dev/null && continue
    echo "$n $(cat "$WORK/reviewed-$n" 2>/dev/null || echo 印なし)"
  done
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
  # 作業役が git rm --cached で記録から外したファイルは、reset で記録に戻るので、足し直した後にもう一度外す
  # （10/29、前の回のコミットに入ったリンクを作業役が外しても、ここで戻されて差し戻しが続いた）
  local untracked="$WORK/untracked-by-worker-$name"
  (cd "$W" && git diff --cached --name-only -z --diff-filter=D -- . > "$untracked" &&
    git reset -q HEAD -- . &&
    git ls-files -z --cached --others --exclude-standard -- . "${excludes[@]}" |
      git --literal-pathspecs add -A --pathspec-from-file=- --pathspec-file-nul &&
    { [ ! -s "$untracked" ] || git --literal-pathspecs rm -q --cached --ignore-unmatch --pathspec-from-file="$untracked" --pathspec-file-nul; } &&
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

# Pi のチャンネル完了判定を使う場合、親への宛先は作業場所やタブを作る前に確定する。
pi_channel_enabled() {
  [ "${PI_CHANNEL:-1}" != 0 ] &&
    [ -f "${PI_CHANNEL_EXT:-$SKILL_DIR/channel/pi/extension.ts}" ] &&
    [ -f "${CHANNEL_BIN:-$SKILL_DIR/channel/bin/channel}" ]
}
resolve_pi_supervisor() {
  local channel_bin=${CHANNEL_BIN:-$SKILL_DIR/channel/bin/channel}
  local supervisor=${AGENT_CHANNEL_SUPERVISOR:-} reason detail
  reason='宛先の Claude が見つからない。AGENT_CHANNEL_SUPERVISOR=claude-<PID> を付けて起動し直す'
  if [ -z "$supervisor" ]; then
    if supervisor=$("$channel_bin" supervisor 2>/dev/null); then
      [ -n "$supervisor" ] || detail='channel supervisor の出力が空'
    else
      detail='channel supervisor が失敗'
    fi
    if [ -n "${detail:-}" ]; then
      log "$reason（$detail）"
      echo "$reason（$detail）" >&2
      return 1
    fi
  fi
  AGENT_CHANNEL_SUPERVISOR=$supervisor
}

# エージェント（種類 $kind）を立ち上げ、依頼を送り、印またはチャンネルの完了を見届ける。
# 依頼は 1 行にする。長い指示はファイルに書いて「読んで従う」と頼む。
# herdr の状態（idle・done）は仕事の終わりを意味しない（途中で質問して止まっても done になる）ので、終わりは印またはチャンネルで判定する。
run_agent() {
  local kind=$1 agent=$2 pane=$3 task=$4 mark=$WORK/done-$2
  local use_channel=0 channel_bin=${CHANNEL_BIN:-$SKILL_DIR/channel/bin/channel}
  local channel_log=${AGENT_CHANNEL:-$HOME/.cache/agent-channel/channel.jsonl} after_id= goal body supervisor=${AGENT_CHANNEL_SUPERVISOR:-}
  local first=1 existing i s context
  if [ "$kind" = claude ]; then
    goal="$task"
    if [ -n "${TASK_ID:-}" ]; then
      context=$("$TASK_BIN" context "$TASK_ID" 2>/dev/null) || context=
      [ -z "$context" ] || goal=$(printf '%s\n\n%s' "$context" "$goal")
    fi
    goal="$goal 途中で質問せず最後までやり切り、報告ファイルを書き終えてください。"
    rm -f "$mark"
    claude_send "$agent" "$goal" "$mark" "$pane" || { log "$agent: Claude -p が正常終了し報告を書くまで完了しなかった"; return 1; }
    log "$agent: Claude -p の終端結果と報告を確認した（session_id $(cat "$WORK/claude-$name.session" 2>/dev/null)）"
    return 0
  fi
  if [ "$kind" = pi ] && [ "${PI_CHANNEL:-1}" != 0 ] && [ -f "${PI_CHANNEL_EXT:-$SKILL_DIR/channel/pi/extension.ts}" ] && [ -f "$channel_bin" ]; then
    channel_log=$(python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$channel_log")
    if after_id=$("$channel_bin" --log "$channel_log" last-id 2>/dev/null); then
      use_channel=1
      if [ -z "$supervisor" ]; then
        local reason='宛先の Claude が見つからない。AGENT_CHANNEL_SUPERVISOR=claude-<PID> を付けて起動し直す'
        log "$agent: $reason（宛先が未解決）"
        echo "$reason（宛先が未解決）" >&2
        return 1
      fi
      log "$agent: 完了判定=channel_finish（宛先 $supervisor、$channel_log、基準 ${after_id:-空}）"
    else
      log "$agent: channel last-id に失敗したため完了判定=印"
    fi
  else
    log "$agent: 完了判定=印"
  fi
  if [ "$use_channel" = 1 ]; then
    goal="$task"
    if [ -n "${TASK_ID:-}" ]; then
      context=$("$TASK_BIN" context "$TASK_ID" 2>/dev/null) || context=
      [ -z "$context" ] || goal=$(printf '%s\n\n%s' "$context" "$goal")
    fi
    goal="$goal 途中で質問せず最後までやり切り、全部終わったら最後に channel_finish の道具を 1 回呼ぶ（これで次の段に進む）。"
  else
    goal="$task"
    if [ -n "${TASK_ID:-}" ]; then
      context=$("$TASK_BIN" context "$TASK_ID" 2>/dev/null) || context=
      [ -z "$context" ] || goal=$(printf '%s\n\n%s' "$context" "$goal")
    fi
    goal="$goal 途中で質問せず最後までやり切り、全部終わったら最後に touch $mark を実行する（この印で次の段に進む）。"
  fi
  channel_finished() {
    local rows
    local -a args=(tail --log "$channel_log" --kind finish --from "$agent")
    [ -z "$after_id" ] || args+=(--after "$after_id")
    rows=$("$channel_bin" "${args[@]}" 2>/dev/null) || return 1
    [ -n "$rows" ] || return 1
    body=$(printf '%s\n' "$rows" | python3 -c 'import json,sys; rows=[json.loads(x) for x in sys.stdin if x.strip()]; print(" ".join(rows[-1].get("body", "").split()))' 2>/dev/null) || return 1
    [ -n "$body" ]
  }
  completed() { if [ "$use_channel" = 1 ]; then channel_finished; else [ -e "$mark" ]; fi; }
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
      completed && break
      herdr agent wait "$agent" --until working --timeout 120000 >/dev/null 2>&1
      herdr agent wait "$agent" >/dev/null 2>&1
      completed && break
      s=$(status "$agent"); [ "$s" = blocked ] && break
      sleep 20
      s=$(status "$agent")
      case $s in working|unknown) continue ;; *) break ;; esac
    done
    s=$(status "$agent")
    # 確認の画面で止まったら台本を終える（Claude がこの終わりで起きて、ペインを見て答える）
    [ "$s" = blocked ] && { log "$agent: 確認の画面で止まった"; return 2; }
    if completed; then
      if [ "$use_channel" = 1 ]; then log "$agent: finish: $body"; else rm -f "$mark"; fi
      log "$agent: 終わった"; return 0
    fi
    log "$agent: 完了通知がないまま止まった（状態 $s、$i 回目）→ 同じ目標をもう一度"
    goal="まだ終わっていない。$goal"; first=1
    sleep 5
  done
  log "$agent: 3 回目標を渡しても終わらなかった"; return 1
}

# worktree ならブランチにコミットする（作者は実装のエージェント）。取り込みは Claude かハーネスがやる。そのあとタブを閉じる
commit_and_close() {
  if [ -z "${BASE:-}" ]; then
    if ! git -C "$W" diff --cached --quiet; then
      git -C "$W" -c "user.name=$COMMIT_NAME" -c "user.email=$COMMIT_EMAIL" commit -q -m "$1" || {
        echo failed > "$WORK/reviewed-$name"; log "コミットできなかった"; return 1;
      }
      log "ブランチ $BRANCH にコミットした（作者 $COMMIT_NAME <$COMMIT_EMAIL>）"
    fi
  fi
  herdr tab close "$tab_id" >/dev/null 2>&1 || { echo failed > "$WORK/reviewed-$name"; log "タブを閉じられなかった"; return 1; }
}

# 台帳の仕事の終わりを書き、次の仕事を出させる
ledger_end() {
  local outcome commit=
  outcome=$(cat "$WORK/reviewed-$name" 2>/dev/null) || outcome=failed
  case $outcome in implemented|stopped|blocked|failed|environment-failed) ;; *) outcome=failed ;; esac
  [ "$outcome" = implemented ] && [ -z "${BASE:-}" ] && commit=$(git -C "$W" rev-parse HEAD 2>/dev/null)
  "$TASK_BIN" ended "$TASK_ID" "$outcome" ${commit:+--commit "$commit"} --log "$L" >> "$L" 2>&1 ||
    log "台帳に終わり（$outcome）を書けなかった"
  log "台帳の $TASK_ID: $outcome"
  # 終わりがきっかけで 1 回まわす（待っている次の仕事を出す）。この台本の終わりを待たせない
  [ "${TASK_RUN_AFTER:-1}" = 0 ] || setsid "$TASK_BIN" run >> "$L" 2>&1 < /dev/null &
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
  if [ -n "${TASK_ID:-}" ]; then
    # 台帳に無い・出せない状態の仕事は始めない（台帳が「走行中」にした後でないと、終わりを書けない）
    "$TASK_BIN" started "$TASK_ID" --agent "impl-$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-24)" --runner $$ --workdir "$W" >> "$L" 2>&1 || {
      log "台帳の $TASK_ID を走行中にできなかったので始めない"; ledger_refused=1; return 1;
    }
    log "台帳の $TASK_ID を走行中にした"
  fi
  # Pi のチャンネルを使う構成では、宛先の解決に失敗したら worktree/tab の作成前に止める。
  if { [ "$IMPL_AGENT" = pi ] || [ "$REV_AGENT" = pi ]; } && pi_channel_enabled; then
    if ! resolve_pi_supervisor; then echo failed > "$WORK/reviewed-$name"; return 1; fi
  fi
  # RESUME=newtab: 写しは残っているがタブが無い（PC や herdr の再起動のあと）。タブだけ作り直す
  if [ -n "${RESUME:-}" ]; then
    [ -d "$W" ] || { log "再開する写しがない"; echo failed > "$WORK/reviewed-$name"; return 1; }
    if [ "$RESUME" = newtab ]; then make_tab; else resume_tab; fi
    rc=$?
  else
    setup && make_tab; rc=$?
  fi
  [ "$rc" = 0 ] || { [ "$rc" = 2 ] && [ "$(cat "$WORK/reviewed-$name" 2>/dev/null)" = environment-failed ] || echo failed > "$WORK/reviewed-$name"; log "準備で止まった"; return 1; }
short=$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-24)

# 3. 実装
# SKIP_IMPL=1: 実装は済んでいて、レビューからやり直すとき
rules_read=""; for f in $RULES $CONTEXT_FILES $DESIGN_RULES; do [ -f "$W/$f" ] && rules_read="$rules_read・$f"; done
design_instruction="10 行程度: 触るファイル・やり方・既存とかぶる所。最後に 1 行「結論: 続行」か「結論: STOP（理由）」。STOP は先に組み直さないと依頼が成り立たないときだけ。STOP ならそこで終える"
[ -z "$DESIGN_RULES" ] || design_instruction="$DESIGN_RULES の手順と結論の書式に従う。結論が STOP なら実装せずそこで終える"
if [ "${SKIP_IMPL:-}" != 1 ]; then
  run_agent "$IMPL_AGENT" "impl-$short" "$p_impl" "$REQ${rules_read} を読み、まず設計の下見を $DESIGN に書いてから（$design_instruction）、その依頼どおりに作業し、報告を $REPORT に書いてください（結論 3 行／変えたファイル／流したテストと出力／確かめたことと推測／残った問題）。報告の先頭近くに必ず機械可読な 1 行「終わりの条件: 満たした」または「終わりの条件: 満たしていない — <満たしていない条件を依頼文の書き方で、；で区切る>」を書く。決められない理由がある場合は「終わりの条件: 満たしていない — 決められない: <理由>」とする。終わりの条件の確かめは、使う人が実際に通る入口（依頼文に書かれたスクリプト・コマンド・起動の台本）で流し、そのコマンドと出力の要所を貼る。手で組んだ代わりの命令で流したもの、手で作った成果物は「代わりの道」と書き、満たしたとは書かない。作業場所はこの写し（$W）だけ。$REPO 本体には一切書き込まない。自分ではコミットしない。"
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
# 台帳の仕事は、作業役どうしのレビューをしない（確かめと Opus のレビューはハーネスがやる。10/27「レビューはあなたやるようにしてね」）
if [ -n "${TASK_ID:-}" ]; then
  commit_and_close "$name（$IMPL_AGENT の実装。台帳 $TASK_ID）" || return 1
  echo implemented > "$WORK/reviewed-$name"; log "実装まで終わった（レビューはハーネスの次の段）"; return 0
fi

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
commit_and_close "$name（$IMPL_AGENT の実装と$REV_AGENT のレビュー）" || return 1
echo reviewed > "$WORK/reviewed-$name"
log "レビューまで終わった"
}

case $mode in
  cleanup) cleanup_task; exit ;;
  stale) stale_tasks; exit ;;
esac
ledger_refused=0
main "$@"; rc=$?
[ -z "${TASK_ID:-}" ] || [ "$ledger_refused" = 1 ] || ledger_end
exit "$rc"
