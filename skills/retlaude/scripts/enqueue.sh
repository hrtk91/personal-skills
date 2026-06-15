#!/bin/bash
# retlaude enqueue: SessionEnd hookから呼ばれ、振り返り対象のセッションをqueueに登録
#
# 入力(stdin): SessionEnd hookのJSON
#   { session_id, transcript_path, cwd, reason }
#
# 出力: ~/.claude/retlaude/queue/pending/<session_id>.json
#   { session_id, jsonl_path, cwd, branch, reason, ended_at, enqueued_at }

set -euo pipefail

PENDING_DIR="$HOME/.claude/retlaude/queue/pending"
DEBUG_LOG="$HOME/.claude/retlaude/enqueue-debug.log"

mkdir -p "$PENDING_DIR" "$(dirname "$DEBUG_LOG")"

debug() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEBUG_LOG"
}

# stdinからJSON読み込み
INPUT="$(cat)"
if [[ -z "$INPUT" ]]; then
  debug "no input"
  exit 0
fi

# 必須フィールド抽出（jq無くてもsedで頑張る選択肢もあるがjqに依存）
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')

if [[ -z "$SESSION_ID" ]]; then
  debug "no session_id, skip"
  exit 0
fi

# hookが起動したサブセッションは除外 (~/.claude/_subsessions/ 配下)
SUBSESSIONS_PREFIX="$HOME/.claude/_subsessions"
if [[ -n "$CWD" && "$CWD" == "$SUBSESSIONS_PREFIX"* ]]; then
  debug "skip subsession: $SESSION_ID (cwd=$CWD)"
  exit 0
fi

# transcript_path が空 or 実体ファイルが存在しないセッションはqueueに積まない
# (reflect.sh で jsonl not found 確定失敗するゴミを未然防止)
if [[ -z "$TRANSCRIPT_PATH" ]]; then
  debug "skip: transcript_path empty (session=$SESSION_ID)"
  exit 0
fi
if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  debug "skip: transcript not found: $TRANSCRIPT_PATH (session=$SESSION_ID)"
  exit 0
fi

# branch取得（cwdがgit repoなら）
BRANCH="(non-git)"
if [[ -n "$CWD" && -d "$CWD/.git" ]] || (cd "$CWD" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
  BRANCH=$(cd "$CWD" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(non-git)")
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
OUT="$PENDING_DIR/${SESSION_ID}.json"

# JSONとして書き込み
jq -n \
  --arg sid "$SESSION_ID" \
  --arg jsonl "$TRANSCRIPT_PATH" \
  --arg cwd "$CWD" \
  --arg branch "$BRANCH" \
  --arg reason "$REASON" \
  --arg ended_at "$NOW" \
  --arg enqueued_at "$NOW" \
  '{session_id: $sid, jsonl_path: $jsonl, cwd: $cwd, branch: $branch, reason: $reason, ended_at: $ended_at, enqueued_at: $enqueued_at}' \
  > "$OUT"

debug "enqueued: $SESSION_ID (reason=$REASON cwd=$CWD branch=$BRANCH)"
