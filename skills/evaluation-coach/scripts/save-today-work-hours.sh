#!/bin/bash
# 今日（or 指定日）の労働時間を obsidian の評価期データに保存（JSONL、同日上書き）
# 使い方: save-today-work-hours.sh [YYYY-MM-DD]
# 出力先: ~/obsidian-vault/評価面談対策/<期>/data/work-hours.jsonl

set -uo pipefail

TARGET="${1:-$(date +%Y-%m-%d)}"
PERIOD_DIR="$($(dirname "$0")/current-period.sh)"
DATA_DIR="$PERIOD_DIR/data"
JSONL="$DATA_DIR/work-hours.jsonl"

# 平日チェック（土日はスキップ。任意で過去日は埋める）
DOW=$(date -j -f "%Y-%m-%d" "$TARGET" "+%u" 2>/dev/null || date -d "$TARGET" "+%u")
if [ "$DOW" = "6" ] || [ "$DOW" = "7" ]; then
  # 土日も記録は残す（休出検知のため）
  :
fi

mkdir -p "$DATA_DIR"
touch "$JSONL"

# work-hours.sh が JSON を吐く前提
WH_SCRIPT="$HOME/.claude/skills/obsidian/scripts/work-hours.sh"
[ -x "$WH_SCRIPT" ] || { echo "work-hours.sh not found or not executable" >&2; exit 1; }

JSON=$("$WH_SCRIPT" "$TARGET" 2>/dev/null || echo '{}')
[ -z "$JSON" ] || [ "$JSON" = "{}" ] && exit 0

# 既存の同日エントリを削除して新規追加（idempotent）
TMP="${TMPDIR:-/tmp}/work-hours-$$.tmp"
grep -v "\"date\":\"$TARGET\"" "$JSONL" 2>/dev/null > "$TMP" || true

# JSON に date キーが無ければ補う
ENTRY=$(echo "$JSON" | jq -c --arg d "$TARGET" '. + {date: $d}' 2>/dev/null || echo "")
[ -z "$ENTRY" ] && { rm -f "$TMP"; exit 0; }

echo "$ENTRY" >> "$TMP"
mv "$TMP" "$JSONL"
