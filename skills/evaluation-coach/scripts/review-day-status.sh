#!/bin/bash
# 今日が週次振り返り日（金曜 or 金曜休みなら月曜）で、かつ未振り返りかを判定
# 出力: "due:<reason>" / "skip"

set -euo pipefail

PERIOD_DIR="$($(dirname "$0")/current-period.sh)"
LAST_REVIEW_FILE="$PERIOD_DIR/.last_weekly_review"
TODAY=$(date +%Y-%m-%d)
DOW=$(date +%u)  # 月=1 ... 日=7

# 金曜 or 月曜のみ判定
if [ "$DOW" != "5" ] && [ "$DOW" != "1" ]; then
  echo "skip"
  exit 0
fi

# 月曜の場合、先週金曜にデイリーノートが存在するなら振り返り不要（金曜出勤と判断）
if [ "$DOW" = "1" ]; then
  FRI=$(date -v-3d +%Y/%m/%Y-%m-%d 2>/dev/null || date -d "3 days ago" +%Y/%m/%Y-%m-%d)
  FRI_NOTE="$HOME/obsidian-vault/デイリーノート/$FRI.md"
  if [ -f "$FRI_NOTE" ]; then
    # 金曜出勤していたので月曜にやる必要なし
    echo "skip"
    exit 0
  fi
fi

# 今週もう振り返り済みなら skip
if [ -f "$LAST_REVIEW_FILE" ]; then
  LAST=$(cat "$LAST_REVIEW_FILE")
  # 同じ週（ISO週番号）ならスキップ
  THIS_WEEK=$(date +%G-W%V)
  LAST_WEEK=$(date -j -f "%Y-%m-%d" "$LAST" "+%G-W%V" 2>/dev/null || date -d "$LAST" +%G-W%V)
  if [ "$THIS_WEEK" = "$LAST_WEEK" ]; then
    echo "skip"
    exit 0
  fi
fi

if [ "$DOW" = "5" ]; then
  echo "due:friday"
else
  echo "due:monday-fallback"
fi
