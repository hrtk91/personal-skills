#!/bin/bash
# 月単位で稼働時間を集計する（標準8h超過分を残業として算出）
# 使い方: work-hours-month.sh YYYY-MM
# 出力: 集計サマリ（人間可読）

set -uo pipefail

MONTH="${1:-$(date +%Y-%m)}"
PERIOD_DIR="$($(dirname "$0")/current-period.sh)"
JSONL="$PERIOD_DIR/data/work-hours.jsonl"

[ -f "$JSONL" ] || { echo "data not found: $JSONL"; exit 1; }

STD_SECONDS=$((8 * 3600))  # 標準8時間

echo "# 稼働時間サマリ: $MONTH"
echo ""

# 日別
echo "## 日別"
echo ""
echo "| 日付 | 曜日 | 実労働 | 残業（8h基準） |"
echo "|------|------|--------|----------------|"

TOTAL=0
OVERTIME=0
DAYS=0

while IFS= read -r line; do
  D=$(echo "$line" | jq -r '.date' 2>/dev/null)
  [ "$D" = "null" ] && continue
  [ -z "$D" ] && continue
  case "$D" in
    ${MONTH}*) ;;
    *) continue ;;
  esac
  W=$(echo "$line" | jq -r '.total_work_seconds // 0' 2>/dev/null)
  [ -z "$W" ] || [ "$W" = "null" ] && W=0
  DOW=$(date -j -f "%Y-%m-%d" "$D" "+%a" 2>/dev/null || date -d "$D" "+%a")
  HOURS=$(printf "%dh %02dm" "$((W / 3600))" "$(((W % 3600) / 60))")

  # 残業: 平日のみ8h超過分をカウント、土日は全量
  WDOW=$(date -j -f "%Y-%m-%d" "$D" "+%u" 2>/dev/null || date -d "$D" "+%u")
  if [ "$WDOW" = "6" ] || [ "$WDOW" = "7" ]; then
    OT=$W
  else
    OT=$((W > STD_SECONDS ? W - STD_SECONDS : 0))
  fi
  OT_FMT=$(printf "%dh %02dm" "$((OT / 3600))" "$(((OT % 3600) / 60))")

  echo "| $D | $DOW | $HOURS | $OT_FMT |"

  TOTAL=$((TOTAL + W))
  OVERTIME=$((OVERTIME + OT))
  DAYS=$((DAYS + 1))
done < "$JSONL"

echo ""
echo "## 集計"
echo ""
echo "- 集計対象日数: $DAYS 日"
echo "- 月間実労働: $(printf '%dh %02dm' "$((TOTAL / 3600))" "$(((TOTAL % 3600) / 60))")"
echo "- 月間残業: $(printf '%dh %02dm' "$((OVERTIME / 3600))" "$(((OVERTIME % 3600) / 60))")"
echo "- 月45時間目安: $((OVERTIME > 162000 ? 1 : 0)) （超過=1）"
