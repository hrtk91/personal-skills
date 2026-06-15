#!/bin/bash
# retlaude dream-weekly: 直近7日のreflectionsを統合してメタ観察を生成
#
# 引数: [week_id]  ISO 8601 form 'YYYY-Www'。省略時は今週(現在のISO week)
# 出力:
#   ~/.claude/retlaude/dreams/weekly/<week_id>.json
#   user-profile.json の personality_observations 冒頭に [週次:<week_id>] で挿入
#   SQLite dreams + dreams_fts にINSERT

set -uo pipefail

WEEK_ID="${1:-}"
if [[ -z "$WEEK_ID" ]]; then
  WEEK_ID="$(date +%G-W%V)"
fi

# 期間: ISO週の月曜〜日曜を計算 (BSD date前提)
# YYYY-Www → year, week
YEAR_PART="${WEEK_ID%-W*}"
WEEK_PART="${WEEK_ID#*-W}"

# 月曜の日付計算: 同じISO年の1/4が含まれる週がW01
# シンプル化: 現在週なら直近7日 (catch-up時もこのほうが堅牢)
PERIOD_TO=$(date +"%Y-%m-%d")
PERIOD_FROM=$(date -v -6d +"%Y-%m-%d" 2>/dev/null || date -d "-6 days" +"%Y-%m-%d")

REFLECTIONS_DIR="$HOME/.claude/retlaude/reflections"
DREAMS_DIR="$HOME/.claude/retlaude/dreams/weekly"
PROFILE_FILE="$HOME/.claude/retlaude/user-profile.json"
DB="$HOME/.claude/retlaude/db/retlaude.sqlite3"
SCHEMA="$(dirname "$(dirname "$0")")/db/schema.sql"
LOG_DIR="$HOME/.cache/retlaude/logs"
DEBUG_LOG="$LOG_DIR/dream-weekly-$(date +%Y-%m-%d).log"

mkdir -p "$DREAMS_DIR" "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEBUG_LOG"; }

OUT_FILE="$DREAMS_DIR/${WEEK_ID}.json"

if [[ -f "$OUT_FILE" ]]; then
  log "[$WEEK_ID] already exists, skip"
  exit 0
fi

log "[$WEEK_ID] start period=$PERIOD_FROM..$PERIOD_TO"

# 直近7日のreflectionsを集める
TARGET_DATES=()
for i in 0 1 2 3 4 5 6; do
  d=$(date -v -${i}d +"%Y-%m-%d" 2>/dev/null || date -d "-${i} days" +"%Y-%m-%d")
  TARGET_DATES+=("$d")
done

REFLECTION_FILES=()
for d in "${TARGET_DATES[@]}"; do
  if [[ -d "$REFLECTIONS_DIR/$d" ]]; then
    while IFS= read -r f; do
      REFLECTION_FILES+=("$f")
    done < <(find "$REFLECTIONS_DIR/$d" -name "*.json")
  fi
done

if [[ ${#REFLECTION_FILES[@]} -eq 0 ]]; then
  log "[$WEEK_ID] no reflections in period, skip"
  exit 0
fi

log "[$WEEK_ID] reflections=${#REFLECTION_FILES[@]}"

# 全reflectionをまとめる
ALL_REFLECTIONS=$(jq -s '[.[] | {date: (.ended_at // ""), project, branch, summary: .reflection.summary, observation: .reflection.personality_observation, topics: .reflection.topics, insights: .reflection.key_insights}]' "${REFLECTION_FILES[@]}")

# 既存profileの参考情報
EXISTING_OBS_TOP=$(jq -r '.personality_observations[:5] | map(.date + ": " + .note) | join("\n")' "$PROFILE_FILE" 2>/dev/null || echo "なし")
EXISTING_INTERESTS=$(jq -r '.accumulated_interests | join(", ")' "$PROFILE_FILE" 2>/dev/null || echo "なし")

PROMPT=$(cat <<EOF
以下は過去7日間($PERIOD_FROM 〜 $PERIOD_TO)のClaudeセッション振り返りデータ(${#REFLECTION_FILES[@]}件)です。
これを「週次dream」として整理・統合してください。JSONのみで返してください。

{
  "summary": "今週全体の総括(2-3文)。事実ベース。",
  "recurring_patterns": ["明確に3回以上現れた傾向や行動パターン"],
  "new_observations": ["今週のreflectionsから新たに観察できた傾向"],
  "fading_patterns": ["既存profileに明示的にあったが今週は観察されなかった傾向"],
  "meta_observation": "上位レイヤーの観察。事実から得られる範囲で書く。",
  "growth_notes": ["明確に観察できた成長点"],
  "concerns": ["材料がある場合のみ気になる兆候を記述"]
}

【重要ルール: 推測と事実の区別】
- すべて「観察された事実」または「明確に推論できる事項」のみ書く
- 推測・憶測・断定的な性格批評は禁止
- データが薄い場合(reflections少ない・観察材料が乏しい)は「データが薄い」と明記し、無理に書かない
- 各配列は0〜5件。空配列OK
- meta_observation: 観察材料が薄ければ「今週のデータからは断定的な観察は困難」と明記してOK
- recurring_patterns: 「3回以上」を厳密に守る。1〜2回しか観察されなかったものは含めない
- fading_patterns: 既存profileに明示されていた傾向のみ対象。推測で「以前はあったかも」と書かない
- ユーザープロファイル(.rules/user-profile.md等)を引き合いに出した推測は禁止

今週のreflections:
${ALL_REFLECTIONS}

既存profileの直近observation(top5):
${EXISTING_OBS_TOP}

既存profileの累積interests:
${EXISTING_INTERESTS}
EOF
)

SUBSESSIONS_DIR="$HOME/.claude/_subsessions"
mkdir -p "$SUBSESSIONS_DIR"
RESPONSE=$(cd "$SUBSESSIONS_DIR" && claude -p --model sonnet \
  --system-prompt "週次dreamingツール。記憶統合とメタ観察を生成。JSONのみ返す。コードブロック・説明文一切禁止。" \
  "$PROMPT" 2>>"$DEBUG_LOG")

if [[ -z "$RESPONSE" ]]; then
  log "[$WEEK_ID] empty response"
  exit 1
fi

CLEANED=$(echo "$RESPONSE" | sed -E 's/^```(json)?//; s/```$//' | tr -d '\r')

if ! echo "$CLEANED" | jq empty 2>>"$DEBUG_LOG"; then
  log "[$WEEK_ID] invalid JSON: $(echo "$CLEANED" | head -c 200)"
  exit 1
fi

# dream JSON保存
GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -n \
  --arg kind "weekly" \
  --arg week_id "$WEEK_ID" \
  --arg from "$PERIOD_FROM" \
  --arg to "$PERIOD_TO" \
  --arg generated_at "$GENERATED_AT" \
  --argjson reflection_count "${#REFLECTION_FILES[@]}" \
  --argjson dream "$CLEANED" \
  '{kind: $kind, period_id: $week_id, period_from: $from, period_to: $to, generated_at: $generated_at, reflection_count: $reflection_count, dream: $dream}' \
  > "$OUT_FILE"

log "[$WEEK_ID] dream saved: $OUT_FILE"

# === Consolidation ===
# 過去7日の日次observation([週次:..]プレフィックスなし)を archive送り → profileから削除
# その上で 週次サマリ1件を profile 冒頭に追加
SUMMARY=$(echo "$CLEANED" | jq -r '.summary // ""')
META_OBS=$(echo "$CLEANED" | jq -r '.meta_observation // ""')

if [[ -f "$PROFILE_FILE" ]]; then
  ARCHIVE_DIR="$HOME/.claude/retlaude/archive"
  mkdir -p "$ARCHIVE_DIR"

  # 期間内の日次observation(週次プレフィックスなし)を抽出
  CONSOLIDATED=$(jq \
    --arg from "$PERIOD_FROM" \
    --arg to "$PERIOD_TO" \
    '
    .personality_observations // [] |
    map(select(
      .date >= $from and .date <= $to and (.note | test("^\\[週次:") | not)
    ))
    ' "$PROFILE_FILE")

  CONS_COUNT=$(echo "$CONSOLIDATED" | jq 'length')
  if [[ "$CONS_COUNT" -gt 0 ]]; then
    # archiveに追記(consolidated_into: weekly:<week_id> マークで追跡可能に)
    echo "$CONSOLIDATED" | jq -c \
      --arg at "$GENERATED_AT" \
      --arg into "weekly:$WEEK_ID" \
      '.[] | {archived_at: $at, type: "personality_observations", consolidated_into: $into, data: .}' \
      >> "$ARCHIVE_DIR/personality_observations.jsonl"

    # SQLite archive_observations にも投入(検索可能化)
    if [[ -f "$DB" ]]; then
      while IFS= read -r row; do
        [[ -z "$row" ]] && continue
        ORIG_DATE=$(echo "$row" | jq -r '.date // ""')
        NOTE=$(echo "$row" | jq -r '.note // ""')
        ESC_AT=$(echo "$GENERATED_AT" | sed "s/'/''/g")
        ESC_DT=$(echo "$ORIG_DATE" | sed "s/'/''/g")
        ESC_NOTE=$(echo "$NOTE" | sed "s/'/''/g")
        sqlite3 "$DB" "
          INSERT INTO archive_observations (archived_at, orig_date, note) VALUES ('$ESC_AT', '$ESC_DT', '$ESC_NOTE');
          INSERT INTO archive_observations_fts (id, note) VALUES (last_insert_rowid(), '$ESC_NOTE');
        " 2>>"$DEBUG_LOG"
      done < <(echo "$CONSOLIDATED" | jq -c '.[]')
    fi

    log "[$WEEK_ID] consolidated $CONS_COUNT daily observation(s) into archive"
  fi

  # profile更新: 期間内日次を除外し、週次サマリ1件を冒頭追加
  if [[ -n "$META_OBS" ]] || [[ -n "$SUMMARY" ]]; then
    COMBINED_NOTE="[週次:$WEEK_ID] ${SUMMARY}${META_OBS:+ / $META_OBS}"
    TMP=$(mktemp)
    jq \
      --arg from "$PERIOD_FROM" \
      --arg to "$PERIOD_TO" \
      --arg date "$PERIOD_TO" \
      --arg note "$COMBINED_NOTE" \
      --arg now "$GENERATED_AT" \
      '
      .personality_observations = (
        [{date: $date, note: $note}] +
        ((.personality_observations // []) | map(select(
          (.date < $from or .date > $to) or (.note | test("^\\[週次:"))
        )))
      )[0:60] |
      .updated_at = $now
      ' "$PROFILE_FILE" > "$TMP" && mv "$TMP" "$PROFILE_FILE"
    log "[$WEEK_ID] profile consolidated (weekly summary added, $CONS_COUNT dailies removed)"
  fi
fi

# SQLiteにINSERT
if [[ -f "$DB" ]] || [[ -x "$(command -v sqlite3)" ]]; then
  if [[ ! -f "$DB" ]] || ! sqlite3 "$DB" "SELECT 1 FROM dreams LIMIT 1" >/dev/null 2>&1; then
    sqlite3 "$DB" < "$SCHEMA"
  fi

  ESC_PERIOD_ID=$(echo "$WEEK_ID" | sed "s/'/''/g")
  ESC_FROM=$(echo "$PERIOD_FROM" | sed "s/'/''/g")
  ESC_TO=$(echo "$PERIOD_TO" | sed "s/'/''/g")
  ESC_SUMMARY=$(echo "$SUMMARY" | sed "s/'/''/g")
  ESC_META=$(echo "$META_OBS" | sed "s/'/''/g")
  ESC_RAW=$(echo "$CLEANED" | sed "s/'/''/g")
  ESC_GEN=$(echo "$GENERATED_AT" | sed "s/'/''/g")

  sqlite3 "$DB" <<SQL
BEGIN;
INSERT OR REPLACE INTO dreams (kind, period_id, period_from, period_to, summary, meta_observation, raw_json, generated_at)
VALUES ('weekly', '$ESC_PERIOD_ID', '$ESC_FROM', '$ESC_TO', '$ESC_SUMMARY', '$ESC_META', '$ESC_RAW', '$ESC_GEN');

DELETE FROM dreams_fts WHERE period_id = '$ESC_PERIOD_ID';
INSERT INTO dreams_fts (period_id, kind, summary, meta_observation, raw_json)
VALUES ('$ESC_PERIOD_ID', 'weekly', '$ESC_SUMMARY', '$ESC_META', '$ESC_RAW');
COMMIT;
SQL
  log "[$WEEK_ID] indexed in db"
fi

log "[$WEEK_ID] done"
