#!/bin/bash
# 週次振り返り日にevaluation-coachスキルの起動を促す
# 金曜（or 金曜休みなら月曜）かつ今週未振り返りのときのみ system-reminder を出す

set -euo pipefail

STATUS_SCRIPT="$HOME/.claude/skills/evaluation-coach/scripts/review-day-status.sh"
[ -x "$STATUS_SCRIPT" ] || exit 0

STATUS=$("$STATUS_SCRIPT" 2>/dev/null || echo "skip")
case "$STATUS" in
  due:*)
    REASON="${STATUS#due:}"
    cat <<EOF
[Evaluation Coach] 📊 今週の振り返り（$REASON）が未実施です。
  - evaluation-coach スキルで週次レビューを開始: 「今週の振り返りやろう」
  - 期目標との接続・evidence追加・次週のアクション提案を自動収集（git/PR/デイリーノート）
EOF
    ;;
  *)
    exit 0
    ;;
esac
