#!/bin/bash
# retlaude reflect: 1セッションの振り返りを生成
#
# 入力: $1 = pending JSON file path
# 処理:
#   1. processing/に移動
#   2. jsonl末尾抜粋 → claude -p でJSON振り返り生成
#   3. reflections/<YYYY-MM-DD>/<session_id>.json に保存
#   4. Obsidianデイリーノート「# 作業ログ」に追記
#   5. 成功 → done/ / 失敗 → failed/ にエラー情報付きで移動

set -uo pipefail

PENDING_FILE="${1:-}"
if [[ -z "$PENDING_FILE" || ! -f "$PENDING_FILE" ]]; then
  echo "[reflect] pending file not found: $PENDING_FILE" >&2
  exit 1
fi

QUEUE_DIR="$HOME/.claude/retlaude/queue"
REFLECTIONS_DIR="$HOME/.claude/retlaude/reflections"
LOG_DIR="$HOME/.cache/retlaude/logs"
DEBUG_LOG="$LOG_DIR/reflect-$(date +%Y-%m-%d).log"
VAULT_PATH="${OBSIDIAN_VAULT:-$HOME/obsidian-vault}"

mkdir -p "$QUEUE_DIR/processing" "$QUEUE_DIR/done" "$QUEUE_DIR/failed" "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEBUG_LOG"; }

BASENAME=$(basename "$PENDING_FILE")
PROCESSING_FILE="$QUEUE_DIR/processing/$BASENAME"

# 1. processingに移動（atomic）
if ! mv "$PENDING_FILE" "$PROCESSING_FILE" 2>/dev/null; then
  log "[$BASENAME] failed to move to processing (already taken?)"
  exit 0
fi

log "[$BASENAME] start"

# JSONフィールド抽出
SESSION_ID=$(jq -r '.session_id' "$PROCESSING_FILE")
JSONL_PATH=$(jq -r '.jsonl_path' "$PROCESSING_FILE")
CWD=$(jq -r '.cwd' "$PROCESSING_FILE")
BRANCH=$(jq -r '.branch' "$PROCESSING_FILE")
ENDED_AT=$(jq -r '.ended_at' "$PROCESSING_FILE")

PROJECT=$(basename "$CWD")
# ended_at はUTC ISO形式 → epoch経由でJSTに変換して日付・時刻を取得
ENDED_AT_JST=$(TZ=Asia/Tokyo date -r "$(date -juf "%Y-%m-%dT%H:%M:%SZ" "$ENDED_AT" "+%s" 2>/dev/null)" "+%Y-%m-%dT%H:%M:%S" 2>/dev/null || echo "$ENDED_AT")
DATE_STR=$(echo "$ENDED_AT_JST" | cut -dT -f1)

# === 失敗時のクリーンアップ ===
fail() {
  local msg="$1"
  log "[$BASENAME] FAILED: $msg"
  jq --arg err "$msg" --arg at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '. + {error: $err, failed_at: $at}' "$PROCESSING_FILE" \
    > "$QUEUE_DIR/failed/$BASENAME"
  rm -f "$PROCESSING_FILE"
  exit 1
}

# 2. jsonl抜粋（先頭5KB + 末尾15KB）
if [[ ! -f "$JSONL_PATH" ]]; then
  fail "jsonl not found: $JSONL_PATH"
fi

JSONL_SIZE=$(stat -f%z "$JSONL_PATH" 2>/dev/null || stat -c%s "$JSONL_PATH" 2>/dev/null || echo 0)
EXCERPT_FILE=$(mktemp)
trap "rm -f $EXCERPT_FILE" EXIT

if [[ $JSONL_SIZE -le 20000 ]]; then
  cat "$JSONL_PATH" > "$EXCERPT_FILE"
else
  head -c 5000 "$JSONL_PATH" > "$EXCERPT_FILE"
  echo -e "\n\n... (中略) ...\n\n" >> "$EXCERPT_FILE"
  tail -c 15000 "$JSONL_PATH" >> "$EXCERPT_FILE"
fi

# 3. sonnetで振り返り生成
PROMPT='以下のClaudeセッションjsonl(抜粋)を振り返り、JSONのみで返してください（説明文・コードブロック禁止）。

{
  "summary": "1行のコミットメッセージ形式要約(140文字以内、体言止め)",
  "topics": ["扱ったテーマ1", "テーマ2", "..."],
  "key_insights": ["学び・気付き1", "..."],
  "personality_observation": "明確な観察材料がある場合のみ1〜2文で記述。なければ空文字列",
  "interests_candidates": ["長期的な関心事候補1", "..."]
}

【重要ルール: personality_observation】
- セッション内容から **明確に観察できた事実のみ** を書く
- 推測・断定はしない。憶測ベースで書くくらいなら空文字列を返す
- 「〜の傾向がある」「〜しがち」のような性格断定は、明確な根拠がある場合のみ
- 1セッションだけでは性格は判断できない。「単発で見えた行動」と「性格特性」を混同しない
- 観察可能なのは「このセッションでこういう行動があった」レベルの事実
- ユーザーの依頼意図が不明な場合は「不明」と書くか空文字列にする

その他ルール:
- topics: 最大5件、短い日本語フレーズ
- key_insights: 0〜3件、技術的または思考プロセス上の気付き
- interests_candidates: 0〜5件、技術領域や思想的な関心
- 全フィールド必須（空配列・空文字列でも良い）'

SUBSESSIONS_DIR="$HOME/.claude/_subsessions"
mkdir -p "$SUBSESSIONS_DIR"
RESPONSE=$(cd "$SUBSESSIONS_DIR" && claude -p --model sonnet \
  --system-prompt "JSON抽出ツール。コードブロック・説明文一切なし。JSONのみ返す。" \
  "$PROMPT" \
  < "$EXCERPT_FILE" 2>>"$DEBUG_LOG")

if [[ -z "$RESPONSE" ]]; then
  fail "claude -p returned empty"
fi

# JSON抽出: 3段階fallback
# 1. raw response がそのまま valid JSON か
# 2. コードフェンス行を行単位削除して valid か
# 3. 最初の { から最後の } までを抽出して valid か
extract_json() {
  local input="$1"
  if echo "$input" | jq empty 2>/dev/null; then
    echo "$input"; return 0
  fi
  local stripped
  stripped=$(echo "$input" | sed -E '/^[[:space:]]*```([Jj]son)?[[:space:]]*$/d' | tr -d '\r')
  if echo "$stripped" | jq empty 2>/dev/null; then
    echo "$stripped"; return 0
  fi
  local extracted
  extracted=$(echo "$input" | awk '
    BEGIN { depth=0; started=0 }
    {
      line=$0
      for (i=1; i<=length(line); i++) {
        c=substr(line, i, 1)
        if (c=="{") { depth++; started=1 }
        if (started) buf = buf c
        if (c=="}") {
          depth--
          if (depth==0 && started) { print buf; exit }
        }
      }
      if (started) buf = buf "\n"
    }
  ')
  if [[ -n "$extracted" ]] && echo "$extracted" | jq empty 2>/dev/null; then
    echo "$extracted"; return 0
  fi
  return 1
}

CLEANED=$(extract_json "$RESPONSE" || true)

if [[ -z "$CLEANED" ]]; then
  RAW_DUMP="$LOG_DIR/reflect-raw-${BASENAME%.json}.txt"
  printf '%s\n' "$RESPONSE" > "$RAW_DUMP"
  log "[$BASENAME] invalid JSON. raw response saved: $RAW_DUMP"
  log "[$BASENAME] response head: $(echo "$RESPONSE" | head -c 200)"
  fail "invalid JSON from claude -p"
fi

# 4. reflections/に保存
REFLECTION_DIR="$REFLECTIONS_DIR/$DATE_STR"
mkdir -p "$REFLECTION_DIR"
REFLECTION_FILE="$REFLECTION_DIR/${SESSION_ID}.json"

jq -n \
  --argjson reflection "$CLEANED" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg branch "$BRANCH" \
  --arg ended_at "$ENDED_AT" \
  --arg project "$PROJECT" \
  --arg generated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  '{session_id: $session_id, project: $project, cwd: $cwd, branch: $branch, ended_at: $ended_at, generated_at: $generated_at, reflection: $reflection}' \
  > "$REFLECTION_FILE"

log "[$BASENAME] reflection saved: $REFLECTION_FILE"

# 4-1. SQLite FTS5にindex (失敗してもreflect自体は成功扱い)
INDEX_SCRIPT="$(dirname "$(dirname "$0")")/db/index-reflection.sh"
if [[ -x "$INDEX_SCRIPT" ]]; then
  if bash "$INDEX_SCRIPT" "$REFLECTION_FILE" 2>>"$DEBUG_LOG"; then
    log "[$BASENAME] indexed in db"
  else
    log "[$BASENAME] WARN: db index failed (reflection still saved)"
  fi
fi

# 5. Obsidianデイリーノートに追記
SUMMARY=$(echo "$CLEANED" | jq -r '.summary // ""')
if [[ -n "$SUMMARY" ]]; then
  YEAR=$(echo "$DATE_STR" | cut -d- -f1)
  MONTH=$(echo "$DATE_STR" | cut -d- -f2)
  DAILY_DIR="$VAULT_PATH/デイリーノート/$YEAR/$MONTH"
  DAILY_FILE="$DAILY_DIR/${DATE_STR}.md"
  TIME=$(echo "$ENDED_AT_JST" | cut -dT -f2 | cut -c1-5)

  mkdir -p "$DAILY_DIR"
  if [[ ! -f "$DAILY_FILE" ]]; then
    TEMPLATE="$VAULT_PATH/templates/daily-notes.md"
    if [[ -f "$TEMPLATE" ]]; then
      cp "$TEMPLATE" "$DAILY_FILE"
    else
      printf "タグ: #daily-notes\n\n# 今日やること\n\n# 作業ログ\n\n# 学んだこと / メモ\n\n# 振り返り\n" > "$DAILY_FILE"
    fi
  fi

  ENTRY="- ${TIME} [${PROJECT}] ${SUMMARY}"

  # 「# 作業ログ」の直後に追記（次の#セクション直前）
  if grep -q "^# 作業ログ" "$DAILY_FILE"; then
    awk -v entry="$ENTRY" '
      BEGIN { in_log=0; inserted=0 }
      /^# 作業ログ/ { print; in_log=1; next }
      in_log && /^# / && !inserted { print entry; inserted=1; in_log=0 }
      { print }
      END { if (in_log && !inserted) print entry }
    ' "$DAILY_FILE" > "${DAILY_FILE}.tmp" && mv "${DAILY_FILE}.tmp" "$DAILY_FILE"
  else
    printf "\n# 作業ログ\n%s\n" "$ENTRY" >> "$DAILY_FILE"
  fi
  log "[$BASENAME] obsidian appended: $DAILY_FILE"
fi

# 6. doneへ移動
mv "$PROCESSING_FILE" "$QUEUE_DIR/done/$BASENAME"
log "[$BASENAME] done"
