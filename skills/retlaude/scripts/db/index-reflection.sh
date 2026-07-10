#!/bin/bash
# retlaude: 1件のreflection JSONをSQLiteにINSERT/UPDATE
#
# 引数: $1 = reflection JSON file path
#         (~/.claude/retlaude/reflections/<date>/<session_id>.json)

set -uo pipefail

REFLECTION_FILE="${1:-}"
if [[ -z "$REFLECTION_FILE" || ! -f "$REFLECTION_FILE" ]]; then
  echo "[index-reflection] file not found: $REFLECTION_FILE" >&2
  exit 1
fi

DB="$HOME/.claude/retlaude/db/retlaude.sqlite3"
SCHEMA="$(dirname "$0")/schema.sql"

# DB初期化(冪等)
if [[ ! -f "$DB" ]] || ! sqlite3 "$DB" "SELECT 1 FROM reflections LIMIT 1" >/dev/null 2>&1; then
  sqlite3 "$DB" < "$SCHEMA"
fi

# JSON抽出
SESSION_ID=$(jq -r '.session_id' "$REFLECTION_FILE")
PROJECT=$(jq -r '.project // ""' "$REFLECTION_FILE")
CWD=$(jq -r '.cwd // ""' "$REFLECTION_FILE")
BRANCH=$(jq -r '.branch // ""' "$REFLECTION_FILE")
ENDED_AT=$(jq -r '.ended_at // ""' "$REFLECTION_FILE")
DATE=$(echo "$ENDED_AT" | cut -dT -f1)
SUMMARY=$(jq -r '.reflection.summary // ""' "$REFLECTION_FILE")
OBSERVATION=$(jq -r '.reflection.personality_observation // ""' "$REFLECTION_FILE")
TOPICS=$(jq -c '.reflection.topics // []' "$REFLECTION_FILE")
KEY_INSIGHTS=$(jq -c '.reflection.key_insights // []' "$REFLECTION_FILE")
INTERESTS=$(jq -c '.reflection.interests_candidates // []' "$REFLECTION_FILE")
INDEXED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# FTS用に topics / key_insights は plain text で結合 (検索しやすく)
TOPICS_FLAT=$(echo "$TOPICS" | jq -r '. | join(" / ")')
INSIGHTS_FLAT=$(echo "$KEY_INSIGHTS" | jq -r '. | join(" / ")')

# トランザクションでINSERT/UPDATE (両テーブル整合)
sqlite3 "$DB" <<SQL
BEGIN;
INSERT INTO reflections (session_id, date, project, cwd, branch, summary, observation, topics, key_insights, interests, ended_at, indexed_at)
VALUES (
  $(printf "'%s'" "$(echo "$SESSION_ID" | sed "s/'/''/g")"),
  $(printf "'%s'" "$DATE"),
  $(printf "'%s'" "$(echo "$PROJECT" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$CWD" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$BRANCH" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$SUMMARY" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$OBSERVATION" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$TOPICS" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$KEY_INSIGHTS" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$INTERESTS" | sed "s/'/''/g")"),
  $(printf "'%s'" "$ENDED_AT"),
  $(printf "'%s'" "$INDEXED_AT")
)
ON CONFLICT(session_id) DO UPDATE SET
  date = excluded.date,
  project = excluded.project,
  cwd = excluded.cwd,
  branch = excluded.branch,
  summary = excluded.summary,
  observation = excluded.observation,
  topics = excluded.topics,
  key_insights = excluded.key_insights,
  interests = excluded.interests,
  ended_at = excluded.ended_at,
  indexed_at = excluded.indexed_at;

DELETE FROM reflections_fts WHERE session_id = $(printf "'%s'" "$(echo "$SESSION_ID" | sed "s/'/''/g")");
INSERT INTO reflections_fts (session_id, summary, observation, topics, key_insights)
VALUES (
  $(printf "'%s'" "$(echo "$SESSION_ID" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$SUMMARY" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$OBSERVATION" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$TOPICS_FLAT" | sed "s/'/''/g")"),
  $(printf "'%s'" "$(echo "$INSIGHTS_FLAT" | sed "s/'/''/g")")
);
COMMIT;
SQL
