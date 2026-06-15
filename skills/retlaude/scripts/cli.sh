#!/bin/bash
# retlaude CLI wrapper
#
# Subcommands:
#   start              launchctl load (daemon起動)
#   stop               launchctl unload
#   restart            stop + start
#   status             daemon状況 + queue件数 + 最終集約日
#   logs [-f|--follow] 最新ログ表示 / -f でtail -f
#   queue              pending一覧
#   reflect <id>       手動振り返り(pending → 即時reflect)
#   aggregate [date]   日次集約手動実行(date省略時=昨日)
#   install            launchd plist生成 + load

set -uo pipefail

LABEL="com.user.retlaude"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# symlinkを解決して実体スクリプトのディレクトリを取得
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
QUEUE_DIR="$HOME/.claude/retlaude/queue"
LOG_DIR="$HOME/.cache/retlaude/logs"
LAST_AGG_FILE="$HOME/.claude/retlaude/last-aggregate-date"
PROFILE_FILE="$HOME/.claude/retlaude/user-profile.json"
REFLECTIONS_DIR="$HOME/.claude/retlaude/reflections"
ARCHIVE_DIR="$HOME/.claude/retlaude/archive"
DB_FILE="$HOME/.claude/retlaude/db/retlaude.sqlite3"
DREAMS_DIR="$HOME/.claude/retlaude/dreams"

cmd_start() {
  if [[ ! -f "$PLIST" ]]; then
    echo "❌ plist not installed. run: retlaude install"
    return 1
  fi
  launchctl load "$PLIST" 2>&1 || true
  echo "✅ retlaude started ($LABEL)"
}

cmd_stop() {
  launchctl unload "$PLIST" 2>&1 || true
  echo "🛑 retlaude stopped"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  echo "=== retlaude status ==="
  if launchctl list | grep -q "$LABEL"; then
    local line
    line=$(launchctl list | grep "$LABEL" | head -1)
    echo "daemon: 🟢 running ($line)"
  else
    echo "daemon: ⚫ stopped"
  fi

  local pending=0 processing=0 failed=0 done_n=0
  pending=$(find "$QUEUE_DIR/pending" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  processing=$(find "$QUEUE_DIR/processing" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  failed=$(find "$QUEUE_DIR/failed" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  done_n=$(find "$QUEUE_DIR/done" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

  echo ""
  echo "queue:"
  printf "  pending:    %d\n" "$pending"
  printf "  processing: %d\n" "$processing"
  printf "  done:       %d\n" "$done_n"
  printf "  failed:     %d\n" "$failed"

  echo ""
  if [[ -f "$LAST_AGG_FILE" ]]; then
    echo "last aggregated: $(cat "$LAST_AGG_FILE")"
  else
    echo "last aggregated: (never)"
  fi

  local latest_log
  latest_log=$(ls -t "$LOG_DIR"/poll-*.log 2>/dev/null | head -1)
  if [[ -n "$latest_log" ]]; then
    echo ""
    echo "latest log: $latest_log"
    tail -3 "$latest_log" | sed 's/^/  /'
  fi
}

cmd_logs() {
  local follow=0
  if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
    follow=1
  fi
  local latest
  latest=$(ls -t "$LOG_DIR"/poll-*.log 2>/dev/null | head -1)
  if [[ -z "$latest" ]]; then
    echo "no log files yet"
    return 0
  fi
  if [[ $follow -eq 1 ]]; then
    tail -f "$latest"
  else
    tail -50 "$latest"
  fi
}

cmd_queue() {
  echo "=== pending ==="
  for f in "$QUEUE_DIR"/pending/*.json; do
    [[ -f "$f" ]] || continue
    local sid project ended
    sid=$(jq -r '.session_id' "$f")
    project=$(jq -r '.cwd' "$f" | xargs basename 2>/dev/null || echo "?")
    ended=$(jq -r '.ended_at' "$f")
    echo "  $sid [$project] $ended"
  done

  echo ""
  echo "=== failed (recent 5) ==="
  for f in $(ls -t "$QUEUE_DIR"/failed/*.json 2>/dev/null | head -5); do
    local sid err
    sid=$(jq -r '.session_id' "$f")
    err=$(jq -r '.error // "?"' "$f")
    echo "  $sid: $err"
  done
}

cmd_reflect() {
  local id="${1:-}"
  if [[ -z "$id" ]]; then
    echo "usage: retlaude reflect <session_id>"
    return 1
  fi
  local target="$QUEUE_DIR/pending/${id}.json"
  if [[ ! -f "$target" ]]; then
    echo "not found in pending: $id"
    return 1
  fi
  bash "$SCRIPT_DIR/processors/reflect.sh" "$target"
}

cmd_aggregate() {
  local date="${1:-}"
  bash "$SCRIPT_DIR/processors/profile-aggregate.sh" ${date:+"$date"}
}

cmd_install() {
  bash "$SCRIPT_DIR/install.sh"
}

cmd_profile() {
  if [[ ! -f "$PROFILE_FILE" ]]; then
    echo "no profile yet: $PROFILE_FILE"
    return 0
  fi
  local n="${1:-5}"
  echo "=== user profile ==="
  jq -r --argjson n "$n" '
    "updated_at: \(.updated_at)",
    "last_aggregated: \(.last_aggregated_date // "(never)")",
    "",
    "=== accumulated interests ===",
    (.accumulated_interests // [] | .[] | "  - \(.)"),
    "",
    "=== recent personality observations (top \($n)) ===",
    (.personality_observations // [] | .[0:$n] | .[] | "[\(.date)]\n  \(.note)\n")
  ' "$PROFILE_FILE"
}

cmd_search() {
  local query="${1:-}"
  local limit="${2:-10}"
  if [[ -z "$query" ]]; then
    echo "usage: retlaude search <query> [limit]"
    echo "       trigram tokenizer requires query >= 3 chars"
    return 1
  fi
  if [[ ! -f "$DB_FILE" ]]; then
    echo "DB not initialized. run: retlaude reindex"
    return 1
  fi

  # trigramは3文字単位 → クエリ長警告
  local qlen=${#query}
  if [[ $qlen -lt 3 ]]; then
    echo "⚠️  query length < 3 (trigram tokenizer requires >=3 chars)"
    return 1
  fi

  # FTS5フレーズ検索: ダブルクォートで囲む(ハイフン等の特殊文字対策)
  # 内部ダブルクォートは2重化、SQLシングルクォートも2重化
  local q_phrase
  q_phrase=$(echo "$query" | sed 's/"/""/g')
  q_phrase="\"$q_phrase\""
  local q_sql
  q_sql=$(echo "$q_phrase" | sed "s/'/''/g")

  echo "=== reflections (query: $query) ==="
  sqlite3 -separator $'\t' "$DB_FILE" "
    SELECT r.date, r.project, r.branch, r.session_id, r.summary
    FROM reflections_fts fts
    JOIN reflections r ON r.session_id = fts.session_id
    WHERE reflections_fts MATCH '$q_sql'
    ORDER BY r.date DESC
    LIMIT $limit;
  " | awk -F'\t' '{ printf "[%s] %s/%s\n  %s\n  → %s\n\n", $1, $2, $3, $4, $5 }'

  echo "=== archive observations ==="
  sqlite3 -separator $'\t' "$DB_FILE" "
    SELECT a.archived_at, a.orig_date, substr(a.note, 1, 200)
    FROM archive_observations_fts fts
    JOIN archive_observations a ON a.id = fts.id
    WHERE archive_observations_fts MATCH '$q_sql'
    ORDER BY a.orig_date DESC
    LIMIT $limit;
  " | awk -F'\t' '{ printf "[orig=%s archived=%s]\n  %s\n\n", $2, $1, $3 }'

  echo "=== dreams ==="
  sqlite3 -separator $'\t' "$DB_FILE" "
    SELECT d.kind, d.period_id, d.period_from, d.period_to, substr(d.summary, 1, 200), substr(d.meta_observation, 1, 300)
    FROM dreams_fts fts
    JOIN dreams d ON d.period_id = fts.period_id
    WHERE dreams_fts MATCH '$q_sql'
    ORDER BY d.period_from DESC
    LIMIT $limit;
  " | awk -F'\t' '{ printf "[%s %s] %s〜%s\n  summary: %s\n  meta: %s\n\n", $1, $2, $3, $4, $5, $6 }'
}

cmd_reindex() {
  bash "$SCRIPT_DIR/db/reindex.sh"
}

cmd_dream() {
  local kind="${1:-weekly}"
  local period="${2:-}"
  case "$kind" in
    weekly|w)
      bash "$SCRIPT_DIR/processors/dream-weekly.sh" ${period:+"$period"}
      ;;
    *)
      echo "usage: retlaude dream [weekly] [period_id]"
      return 1 ;;
  esac
}

cmd_dreams() {
  local kind="${1:-weekly}"
  local n="${2:-5}"
  local dir
  case "$kind" in
    weekly|w) dir="$DREAMS_DIR/weekly" ;;
    *) echo "usage: retlaude dreams [weekly] [N]"; return 1 ;;
  esac

  if [[ ! -d "$dir" ]]; then
    echo "no dreams yet: $dir"
    return 0
  fi

  echo "=== $kind dreams (latest $n) ==="
  for f in $(ls -t "$dir"/*.json 2>/dev/null | head -n "$n"); do
    jq -r '
      "── \(.period_id) [\(.period_from) 〜 \(.period_to)] reflections=\(.reflection_count // 0) ──",
      "  summary: \(.dream.summary // "(none)")",
      "",
      "  meta_observation:",
      "  \(.dream.meta_observation // "(none)")",
      "",
      (if (.dream.recurring_patterns // [] | length) > 0 then
         "  recurring_patterns:",
         (.dream.recurring_patterns[] | "    - \(.)")
       else empty end),
      (if (.dream.new_observations // [] | length) > 0 then
         "  new_observations:",
         (.dream.new_observations[] | "    - \(.)")
       else empty end),
      (if (.dream.growth_notes // [] | length) > 0 then
         "  growth_notes:",
         (.dream.growth_notes[] | "    - \(.)")
       else empty end),
      (if (.dream.concerns // [] | length) > 0 then
         "  concerns:",
         (.dream.concerns[] | "    - \(.)")
       else empty end),
      ""
    ' "$f"
  done
}

cmd_archive() {
  local kind="${1:-observations}"
  local n="${2:-10}"
  local file
  case "$kind" in
    observations|obs)        file="$ARCHIVE_DIR/personality_observations.jsonl" ;;
    interests|int)           file="$ARCHIVE_DIR/accumulated_interests.jsonl" ;;
    sessions|recent_sessions) file="$ARCHIVE_DIR/recent_sessions.jsonl" ;;
    *)
      echo "usage: retlaude archive [observations|interests|sessions] [N]"
      return 1 ;;
  esac

  if [[ ! -f "$file" ]]; then
    echo "no archive yet: $file"
    return 0
  fi

  echo "=== archive: $kind (last $n) ==="
  tail -n "$n" "$file" | jq -r '
    if .type == "personality_observations" then
      "[archived \(.archived_at)] orig=\(.data.date)\n  \(.data.note)\n"
    elif .type == "accumulated_interests" then
      "[archived \(.archived_at)] \(.data)"
    elif .type == "recent_sessions" then
      "[archived \(.archived_at)] orig=\(.data.date) topics=\(.data.topics // [] | join(", "))"
    else . end
  '
}

cmd_reflections() {
  local date="${1:-$(date +%Y-%m-%d)}"
  local dir="$REFLECTIONS_DIR/$date"
  if [[ ! -d "$dir" ]]; then
    echo "no reflections for $date"
    return 0
  fi
  echo "=== reflections for $date ==="
  for f in "$dir"/*.json; do
    [[ -f "$f" ]] || continue
    jq -r '
      "── \(.session_id) [\(.project)] \(.branch) ──",
      "  ended:   \(.ended_at)",
      "  summary: \(.reflection.summary // "(none)")",
      "  topics:  \(.reflection.topics // [] | join(", "))",
      (if (.reflection.personality_observation // "") != "" then
        "  observation: \(.reflection.personality_observation)"
       else empty end),
      ""
    ' "$f"
  done
}

usage() {
  cat <<EOF
retlaude — Claude session retrospective daemon

Usage: retlaude <command> [args]

Commands:
  start              start daemon (requires install first)
  stop               stop daemon
  restart            stop + start
  status             show daemon + queue status
  logs [-f]          tail latest poll log (-f to follow)
  queue              list pending + recent failed
  reflect <id>       run reflect.sh on a pending session
  aggregate [date]   run profile-aggregate.sh (default: yesterday)
  profile [N]        show user-profile (interests + recent N observations, default 5)
  reflections [date] show reflections for date (default: today)
  archive <kind> [N] show cold storage archive (kind: observations|interests|sessions, default last 10)
  search <query> [N] full-text search across reflections + archive + dreams (FTS5 trigram)
  reindex            rebuild SQLite DB from reflections/ and archive/
  dream [weekly]     run dream-weekly manually
  dreams [weekly] [N] show recent N weekly dreams (default 5)
  install            install launchd plist

Files:
  plist:        $PLIST
  queue:        $QUEUE_DIR
  logs:         $LOG_DIR
EOF
}

CMD="${1:-}"
shift || true

case "$CMD" in
  start)       cmd_start "$@" ;;
  stop)        cmd_stop "$@" ;;
  restart)     cmd_restart "$@" ;;
  status)      cmd_status "$@" ;;
  logs)        cmd_logs "$@" ;;
  queue)       cmd_queue "$@" ;;
  reflect)     cmd_reflect "$@" ;;
  aggregate)   cmd_aggregate "$@" ;;
  install)     cmd_install "$@" ;;
  profile)     cmd_profile "$@" ;;
  reflections) cmd_reflections "$@" ;;
  archive)     cmd_archive "$@" ;;
  search)      cmd_search "$@" ;;
  reindex)     cmd_reindex "$@" ;;
  dream)       cmd_dream "$@" ;;
  dreams)      cmd_dreams "$@" ;;
  ""|help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
