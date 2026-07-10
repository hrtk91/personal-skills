#!/bin/bash
# retlaude: 全reflections + archiveをDBに再投入
#
# 用途: 初回セットアップ・schema変更後・破損復旧

set -uo pipefail

DB="$HOME/.claude/retlaude/db/retlaude.sqlite3"
SCHEMA_DIR="$(dirname "$0")"
REFLECTIONS_DIR="$HOME/.claude/retlaude/reflections"
ARCHIVE_DIR="$HOME/.claude/retlaude/archive"

# DB再作成
rm -f "$DB"
sqlite3 "$DB" < "$SCHEMA_DIR/schema.sql"

# reflections全件
COUNT=0
if [[ -d "$REFLECTIONS_DIR" ]]; then
  for f in "$REFLECTIONS_DIR"/*/*.json; do
    [[ -f "$f" ]] || continue
    bash "$SCHEMA_DIR/index-reflection.sh" "$f" && COUNT=$((COUNT + 1))
  done
fi
echo "indexed reflections: $COUNT"

# archive_observations
ARC_COUNT=0
if [[ -f "$ARCHIVE_DIR/personality_observations.jsonl" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    ARCHIVED_AT=$(echo "$line" | jq -r '.archived_at // ""')
    ORIG_DATE=$(echo "$line" | jq -r '.data.date // ""')
    NOTE=$(echo "$line" | jq -r '.data.note // ""')
    [[ -z "$NOTE" ]] && continue

    ESC_AT=$(echo "$ARCHIVED_AT" | sed "s/'/''/g")
    ESC_DT=$(echo "$ORIG_DATE" | sed "s/'/''/g")
    ESC_NOTE=$(echo "$NOTE" | sed "s/'/''/g")

    sqlite3 "$DB" "
      INSERT INTO archive_observations (archived_at, orig_date, note) VALUES ('$ESC_AT', '$ESC_DT', '$ESC_NOTE');
      INSERT INTO archive_observations_fts (id, note) VALUES (last_insert_rowid(), '$ESC_NOTE');
    "
    ARC_COUNT=$((ARC_COUNT + 1))
  done < "$ARCHIVE_DIR/personality_observations.jsonl"
fi
echo "indexed archive observations: $ARC_COUNT"

echo "DB: $DB"
sqlite3 "$DB" "SELECT 'reflections=' || COUNT(*) FROM reflections;"
sqlite3 "$DB" "SELECT 'archive_observations=' || COUNT(*) FROM archive_observations;"
