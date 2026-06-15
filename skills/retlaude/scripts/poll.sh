#!/bin/bash
# retlaude poll: queueをpollingしてreflect.shを順次実行 + 日次集約トリガー
#
# 動作:
#   - 5分おき(POLL_INTERVAL)に pending/*.json を全件処理
#   - 日次(AGGREGATE_HOUR=7時台)に profile-aggregate.sh を1回実行
#   - flockで二重起動防止
#   - 古い done/ は7日後に自動削除

set -uo pipefail

POLL_INTERVAL="${POLL_INTERVAL:-300}"
AGGREGATE_HOUR="${AGGREGATE_HOUR:-7}"
DREAM_WEEKLY_DOW="${DREAM_WEEKLY_DOW:-7}"   # 1=Mon..7=Sun (ISO). 7(日)以降に発火許可
DREAM_WEEKLY_HOUR="${DREAM_WEEKLY_HOUR:-2}"  # 早朝〜朝に走らせる(復帰後catch-upも可)
DONE_RETENTION_DAYS="${DONE_RETENTION_DAYS:-7}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUEUE_DIR="$HOME/.claude/retlaude/queue"
PROCESSORS_DIR="$SCRIPT_DIR/processors"
LOG_DIR="$HOME/.cache/retlaude/logs"
LOCK_FILE="$HOME/.claude/retlaude/retlaude.lock"
LAST_AGG_FILE="$HOME/.claude/retlaude/last-aggregate-date"
LAST_DREAM_WEEK_FILE="$HOME/.claude/retlaude/last-dream-week"

mkdir -p "$QUEUE_DIR/pending" "$QUEUE_DIR/processing" "$QUEUE_DIR/done" "$QUEUE_DIR/failed" "$LOG_DIR"

# 二重起動防止 (PIDファイル方式・macOS flock非依存)
if [[ -f "$LOCK_FILE" ]]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[retlaude] already running (pid=$OLD_PID). exit" >&2
    exit 0
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

current_log() {
  echo "$LOG_DIR/poll-$(date +%Y-%m-%d).log"
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$(current_log)"
}

rotate_logs() {
  find "$LOG_DIR" -name 'poll-*.log' -mtime +${LOG_RETENTION_DAYS} -delete 2>/dev/null || true
  find "$LOG_DIR" -name 'reflect-*.log' -mtime +${LOG_RETENTION_DAYS} -delete 2>/dev/null || true
  find "$LOG_DIR" -name 'aggregate-*.log' -mtime +${LOG_RETENTION_DAYS} -delete 2>/dev/null || true
}

cleanup_done() {
  find "$QUEUE_DIR/done" -name '*.json' -mtime +${DONE_RETENTION_DAYS} -delete 2>/dev/null || true
}

process_pending() {
  local count=0
  for f in "$QUEUE_DIR"/pending/*.json; do
    [[ -f "$f" ]] || continue
    log "process: $(basename "$f")"
    bash "$PROCESSORS_DIR/reflect.sh" "$f" || log "reflect.sh failed for $(basename "$f")"
    count=$((count + 1))
  done
  if [[ $count -gt 0 ]]; then
    log "processed $count pending(s)"
  fi
}

# 前日の集約 (catch-up方式: AGGREGATE_HOUR以降+昨日未集約なら即実行)
# スリープ復帰後の最初のpollで取りこぼしなく発火する
maybe_aggregate() {
  local hour
  hour=$(date +%-H)
  if [[ "$hour" -lt "$AGGREGATE_HOUR" ]]; then
    return 0
  fi

  local yesterday
  yesterday=$(date -v -1d +"%Y-%m-%d" 2>/dev/null || date -d "yesterday" +"%Y-%m-%d")

  local last
  last=$(cat "$LAST_AGG_FILE" 2>/dev/null || echo "")
  # last >= yesterday(YYYY-MM-DD文字列比較) ならskip
  if [[ -n "$last" && ! "$last" < "$yesterday" ]]; then
    return 0
  fi

  log "trigger aggregate for $yesterday (catch-up: last=$last)"
  if bash "$PROCESSORS_DIR/profile-aggregate.sh" "$yesterday"; then
    echo "$yesterday" > "$LAST_AGG_FILE"
    log "aggregate done: $yesterday"
  else
    log "aggregate failed: $yesterday (will retry next cycle)"
  fi
}

# 週次dream (catch-up方式: 日曜以降+今週未実行)
maybe_dream_weekly() {
  local hour dow
  hour=$(date +%-H)
  dow=$(date +%u)  # 1=Mon..7=Sun

  # 指定曜日(7=日)以降のみ。早朝にスリープ中でも復帰後に拾える
  [[ "$dow" -lt "$DREAM_WEEKLY_DOW" ]] && return 0
  [[ "$hour" -lt "$DREAM_WEEKLY_HOUR" ]] && return 0

  local current_week
  current_week=$(date +%G-W%V)

  local last
  last=$(cat "$LAST_DREAM_WEEK_FILE" 2>/dev/null || echo "")
  if [[ "$last" == "$current_week" ]]; then
    return 0
  fi

  log "trigger dream-weekly for $current_week (catch-up: last=$last)"
  if bash "$PROCESSORS_DIR/dream-weekly.sh" "$current_week"; then
    echo "$current_week" > "$LAST_DREAM_WEEK_FILE"
    log "dream-weekly done: $current_week"
  else
    log "dream-weekly failed: $current_week (will retry next cycle)"
  fi
}

log "🟢 retlaude daemon started | POLL_INTERVAL=${POLL_INTERVAL}s AGGREGATE_HOUR=${AGGREGATE_HOUR}"

while true; do
  rotate_logs
  cleanup_done
  process_pending
  maybe_aggregate
  maybe_dream_weekly
  sleep "$POLL_INTERVAL"
done
