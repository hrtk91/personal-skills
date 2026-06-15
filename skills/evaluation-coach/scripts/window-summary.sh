#!/usr/bin/env bash
# ActivityWatchの履歴から時間帯別/アプリ別の作業要約を出力する
# 使い方: window-summary.sh [YYYY-MM-DD]
# 出力: マークダウン形式（振り返り用）
#
# 依存: window-history.sh
# 注意: タイトル長は60文字で切詰め、上位3つまで表示

set -euo pipefail

TARGET_DATE="${1:-$(date +%Y-%m-%d)}"
OBSIDIAN_SCRIPTS="$HOME/.claude/skills/obsidian/scripts"

# 一時ファイルは /tmp/claude を優先（Claude Codeサンドボックス対応）
WORK_DIR="${WINDOW_SUMMARY_TMPDIR:-/tmp/claude}"
mkdir -p "$WORK_DIR"

# 履歴取得
HISTORY_FILE="$(mktemp "$WORK_DIR/aw-history.XXXXXX")"
trap 'rm -f "$HISTORY_FILE"' EXIT
bash "$OBSIDIAN_SCRIPTS/window-history.sh" "$TARGET_DATE" > "$HISTORY_FILE"

if [ ! -s "$HISTORY_FILE" ]; then
  echo "No window history for $TARGET_DATE" >&2
  exit 0
fi

# work-hours.sh から break セグメントを取得（離席時間除外用）
# ActivityWatch は画面ロック中もバックグラウンドアプリを記録するため、
# pmset ベースの break セグメントと突き合わせて離席中のイベントを除外する。
WH_SCRIPT="$OBSIDIAN_SCRIPTS/work-hours.sh"
BREAK_RANGES="[]"
BREAK_DISPLAY=""
if [ -x "$WH_SCRIPT" ]; then
  WH_JSON="$("$WH_SCRIPT" "$TARGET_DATE" 2>/dev/null || true)"
  if [ -n "$WH_JSON" ]; then
    BREAK_RANGES="$(printf '%s' "$WH_JSON" | jq -c '
      [.segments[]? | select(.type == "break") | {
        start: (.start | strptime("%Y-%m-%d %H:%M:%S") | mktime),
        end:   (.end   | strptime("%Y-%m-%d %H:%M:%S") | mktime)
      }]
    ' 2>/dev/null || echo "[]")"
    BREAK_DISPLAY="$(printf '%s' "$WH_JSON" | jq -r '.total_break // ""' 2>/dev/null || echo "")"
  fi
fi

# JST変換 + break中のイベント除外
# ActivityWatchのtimestampはUTC（+00:00）。JST(+9h)に変換する必要がある。
JST_FILE="$(mktemp "$WORK_DIR/aw-jst.XXXXXX")"
trap 'rm -f "$HISTORY_FILE" "$JST_FILE"' EXIT

jq -c --argjson breaks "$BREAK_RANGES" '
  (.timestamp[0:19] | strptime("%Y-%m-%dT%H:%M:%S") | mktime | . + 32400) as $epoch
  | if (.app == "loginwindow")
    then empty
    elif (any($breaks[]?; .start <= $epoch and $epoch < .end))
    then empty
    else . + {hour: ($epoch | strftime("%H"))}
    end
' "$HISTORY_FILE" > "$JST_FILE"

echo "# 📺 ウィンドウ作業ログ ($TARGET_DATE)"
if [ -n "$BREAK_DISPLAY" ] && [ "$BREAK_DISPLAY" != "0h 00m" ]; then
  echo "> 離席（pmset break）$BREAK_DISPLAY 除外済み"
fi
echo ""

# 1. アプリ別合計（top 10）
echo "## アプリ別合計（top 10）"
jq -s -r '
  group_by(.app)
  | map({app: .[0].app, total: (map(.duration) | add)})
  | sort_by(-.total)
  | .[0:10]
  | .[]
  | "- \(.app): \((.total / 60) | floor)m"
' "$JST_FILE"
echo ""

# 2. 時間帯別 top 3 アプリ + 代表タイトル
echo "## 時間帯別 top 3（1h単位）"
jq -s -r '
  group_by(.hour)
  | sort_by(.[0].hour)
  | .[]
  | (
      "### \(.[0].hour):00-\(.[0].hour):59",
      (
        group_by(.app)
        | map({
            app: .[0].app,
            total: (map(.duration) | add),
            titles: ([.[].title] | unique | map(.[0:60]))
          })
        | sort_by(-.total)
        | .[0:3]
        | .[]
        | "- \(.app) (\((.total / 60) | floor)m): \(.titles[0:3] | join(" / "))"
      ),
      ""
    )
' "$JST_FILE"
