#!/bin/bash
# retlaude profile-aggregate: 日次集約でuser-profile.jsonを更新
#
# 引数: [target_date]  YYYY-MM-DD形式。省略時は前日
# 処理:
#   1. reflections/<target_date>/*.json を全部読み込み
#   2. 既存user-profile.jsonを読み込み
#   3. sonnetで集約・更新（topics / interests / personality_observation）
#   4. user-profile.jsonに書き戻し（last_aggregated_dateを記録）
#   5. 同じ日付を二重集約しない

set -uo pipefail

TARGET_DATE="${1:-}"
if [[ -z "$TARGET_DATE" ]]; then
  TARGET_DATE=$(date -v -1d +"%Y-%m-%d" 2>/dev/null || date -d "yesterday" +"%Y-%m-%d")
fi

REFLECTIONS_DIR="$HOME/.claude/retlaude/reflections/$TARGET_DATE"
PROFILE_FILE="$HOME/.claude/retlaude/user-profile.json"
LOG_DIR="$HOME/.cache/retlaude/logs"
DEBUG_LOG="$LOG_DIR/aggregate-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR" "$(dirname "$PROFILE_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEBUG_LOG"; }

# 1. 対象日のreflectionsを確認
if [[ ! -d "$REFLECTIONS_DIR" ]]; then
  log "[aggregate] no reflections for $TARGET_DATE, skip"
  exit 0
fi

REFLECTION_COUNT=$(find "$REFLECTIONS_DIR" -name "*.json" | wc -l | tr -d ' ')
if [[ $REFLECTION_COUNT -eq 0 ]]; then
  log "[aggregate] empty reflections for $TARGET_DATE, skip"
  exit 0
fi

# 2. 既存profile読み込み（無ければ初期化）
if [[ -f "$PROFILE_FILE" ]]; then
  EXISTING_PROFILE=$(cat "$PROFILE_FILE")
else
  EXISTING_PROFILE='{"recent_sessions":[],"accumulated_interests":[],"personality_observations":[],"updated_at":"","last_aggregated_date":""}'
fi

# 重複集約チェック
LAST_AGG=$(echo "$EXISTING_PROFILE" | jq -r '.last_aggregated_date // ""')
if [[ "$LAST_AGG" == "$TARGET_DATE" ]]; then
  log "[aggregate] $TARGET_DATE already aggregated, skip"
  exit 0
fi

log "[aggregate] target=$TARGET_DATE reflections=$REFLECTION_COUNT"

# 3. 全reflectionsを集約してsonnetに渡す
ALL_REFLECTIONS=$(jq -s '.' "$REFLECTIONS_DIR"/*.json)

EXISTING_INTERESTS=$(echo "$EXISTING_PROFILE" | jq -r '.accumulated_interests | join(", ") // "なし"')
RECENT_OBSERVATIONS=$(echo "$EXISTING_PROFILE" | jq -r '.personality_observations[:3] | map(.date + ": " + .note) | join("\n") // "なし"')

PROMPT=$(cat <<EOF
以下は ${TARGET_DATE} のClaudeセッション振り返りデータ(${REFLECTION_COUNT}件)です。
これを集約してユーザープロフィールを更新してください。JSONのみ返してください。

{
  "topics": ["今日扱ったテーマ1", "テーマ2"],
  "interests": ["長期的な関心事1", "..."],
  "personality_observation": "今日全体の観察を1〜3文で（複数セッションを統合した視点で）"
}

ルール:
- topics: 最大7件、その日の主要テーマを統合
- interests: 既存リストを参考に長期的関心事を更新、最大15件
- personality_observation: 1日全体を俯瞰した視点で。単発セッションのコピペではなく統合的に
- 全フィールド必須

今日のreflections:
${ALL_REFLECTIONS}

既存の関心事リスト:
${EXISTING_INTERESTS}

直近の性格観察(過去3件):
${RECENT_OBSERVATIONS}
EOF
)

SUBSESSIONS_DIR="$HOME/.claude/_subsessions"
mkdir -p "$SUBSESSIONS_DIR"
RESPONSE=$(cd "$SUBSESSIONS_DIR" && claude -p --model sonnet \
  --system-prompt "ユーザープロフィール抽出ツール。JSONのみ返す。説明文・コードブロック禁止。" \
  "$PROMPT" 2>>"$DEBUG_LOG")

if [[ -z "$RESPONSE" ]]; then
  log "[aggregate] empty response, skip"
  exit 1
fi

CLEANED=$(echo "$RESPONSE" | sed -E 's/^```(json)?//; s/```$//' | tr -d '\r')

if ! echo "$CLEANED" | jq empty 2>>"$DEBUG_LOG"; then
  log "[aggregate] invalid JSON: $(echo "$CLEANED" | head -c 200)"
  exit 1
fi

# 4. profile更新（cold storage archive付き）
ARCHIVE_DIR="$HOME/.claude/retlaude/archive"
mkdir -p "$ARCHIVE_DIR"

OBS_LIMIT="${OBS_LIMIT:-60}"
INT_LIMIT="${INT_LIMIT:-15}"
SESS_LIMIT="${SESS_LIMIT:-30}"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

UPDATED=$(echo "$EXISTING_PROFILE" | jq \
  --argjson agg "$CLEANED" \
  --arg date "$TARGET_DATE" \
  --arg now "$NOW" \
  --argjson obs_limit "$OBS_LIMIT" \
  --argjson int_limit "$INT_LIMIT" \
  --argjson sess_limit "$SESS_LIMIT" \
  '
  .recent_sessions = ([{date: $date, topics: ($agg.topics // [])}] + (.recent_sessions // []))[0:$sess_limit] |
  .accumulated_interests = (($agg.interests // .accumulated_interests) | .[0:$int_limit]) |
  (if ($agg.personality_observation // "") != "" then
    .personality_observations = ([{date: $date, note: $agg.personality_observation}] + (.personality_observations // []))[0:$obs_limit]
  else . end) |
  .updated_at = $now |
  .last_aggregated_date = $date
  ')

# === Cold storage: 押し出された項目をarchive/に追記 ===
# 各カテゴリの差集合(before - after)を取り、archived_atを付与してJSONLで追記する

archive_diff() {
  local field="$1"
  local archive_file="$ARCHIVE_DIR/${field}.jsonl"
  local before_after
  before_after=$(jq -n \
    --argjson before "$EXISTING_PROFILE" \
    --argjson after "$UPDATED" \
    --arg field "$field" \
    '($before[$field] // []) - ($after[$field] // [])')

  local count
  count=$(echo "$before_after" | jq 'length')
  if [[ "$count" == "0" ]]; then
    return 0
  fi

  echo "$before_after" | jq -c --arg at "$NOW" --arg field "$field" '.[] | {archived_at: $at, type: $field, data: .}' \
    >> "$archive_file"
  log "[aggregate] archived $count item(s) to $archive_file"
}

archive_diff "personality_observations"
archive_diff "accumulated_interests"
archive_diff "recent_sessions"

echo "$UPDATED" > "$PROFILE_FILE"
log "[aggregate] profile updated: target=$TARGET_DATE limits(obs=$OBS_LIMIT int=$INT_LIMIT sess=$SESS_LIMIT)"
