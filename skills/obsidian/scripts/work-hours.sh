#!/usr/bin/env bash
# 労働時間計算スクリプト
# 使い方: work-hours.sh [YYYY-MM-DD]
# 出力: JSON
#
# pmset -g log のSleep/Wakeイベントから実労働時間と休憩時間を算出する。
# - 起点: "Sleep/Wakes since boot at YYYY-MM-DD HH:MM:SS"
# - 休憩入り: 'Idle Sleep' / 'Clamshell Sleep'(フタ閉じ=中抜け)
# - 休憩明け: FullWake(UserActivity) / HID Activity Wake
# - 5分未満のworkセグメントは隣のbreakにマージ（チラ見ノイズ除去）
# - 今日の場合、終端は現在時刻。過去日は最終Sleepイベント

set -euo pipefail

TARGET_DATE="${1:-$(date +%Y-%m-%d)}"
TODAY="$(date +%Y-%m-%d)"

# 依存チェック
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v pmset >/dev/null 2>&1 || { echo "pmset is required" >&2; exit 1; }

to_epoch() { date -j -f "%Y-%m-%d %H:%M:%S" "$1" +%s; }

fmt_duration() {
  local s="$1"
  [ "$s" -lt 0 ] && s=0
  printf "%dh %02dm" "$((s / 3600))" "$(((s % 3600) / 60))"
}

log="$(pmset -g log 2>&1)"

# 起点（最後のboot行を採用）
boot_str="$(printf '%s\n' "$log" \
  | grep "Sleep/Wakes since boot at $TARGET_DATE" \
  | tail -1 \
  | grep -oE "$TARGET_DATE [0-9]{2}:[0-9]{2}:[0-9]{2}" \
  | head -1 || true)"

# fallback: boot行が無い日は当日最初の "Display is turned on" を起点にする
if [ -z "$boot_str" ]; then
  boot_str="$(printf '%s\n' "$log" \
    | grep -E "^$TARGET_DATE .*Display is turned on" \
    | head -1 \
    | grep -oE "$TARGET_DATE [0-9]{2}:[0-9]{2}:[0-9]{2}" \
    | head -1 || true)"
fi

# イベント抽出: "YYYY-MM-DD HH:MM:SS TYPE"
events="$(printf '%s\n' "$log" | awk -v d="$TARGET_DATE" '
  $1 == d {
    ts = $1 " " $2
    # $1=date $2=time $3=+0900 $4=Sleep|Wake|...
    if ($0 ~ /Entering Sleep state due to .(Idle Sleep|Clamshell Sleep)/) {
      print ts " SLEEP"
    } else if ($4 == "Wake" && ($0 ~ /FullWake from Deep Idle/ || $0 ~ /HID Activity/ || $0 ~ /UserActivity Assertion/)) {
      print ts " WAKE"
    }
  }
')"

# bootをWAKEとして先頭に追加（boot前のイベントは除外）
if [ -n "$boot_str" ]; then
  boot_epoch="$(to_epoch "$boot_str")"
  events="$(printf '%s\n%s\n' "$boot_str WAKE" "$events" \
    | awk -v be="$boot_epoch" '
      NF==3 {
        cmd = "date -j -f \"%Y-%m-%d %H:%M:%S\" \"" $1 " " $2 "\" +%s"
        cmd | getline e
        close(cmd)
        if (e >= be) print
      }
    ')"
fi

# 連続する同種イベントは最初のみ採用
events="$(printf '%s\n' "$events" | awk '
  NF==3 && $3 != prev { print; prev=$3 }
')"

# セグメント構築 -> JSON配列（segments_raw）
end_str=""
if [ "$TARGET_DATE" = "$TODAY" ]; then
  end_str="$(date "+%Y-%m-%d %H:%M:%S")"
else
  # 過去日：最後のイベント時刻
  end_str="$(printf '%s\n' "$events" | tail -1 | awk '{print $1, $2}')"
fi

segments_raw="$(printf '%s\n' "$events" | awk -v end_str="$end_str" '
  NF==3 {
    times[NR] = $1 " " $2
    types[NR] = $3
    n = NR
  }
  END {
    for (i = 1; i <= n; i++) {
      start = times[i]
      type = (types[i] == "WAKE") ? "work" : "break"
      end = (i < n) ? times[i+1] : end_str
      print start "|" end "|" type
    }
  }
' | jq -R -s '
  split("\n")
  | map(select(length > 0))
  | map(split("|"))
  | map({start: .[0], end: .[1], type: .[2]})
')"

# durationを付与
segments_with_dur="$(printf '%s' "$segments_raw" | jq '
  map(
    . + {
      duration_seconds: (
        ((.end | strptime("%Y-%m-%d %H:%M:%S") | mktime)
         - (.start | strptime("%Y-%m-%d %H:%M:%S") | mktime))
      )
    }
  )
  | map(select(.duration_seconds >= 0))
')"

# 5分(300秒)未満のセグメントは type を問わず直前にマージ（チラ見ノイズ除去）
# その後、隣接同typeをマージしてduration再計算
merged="$(printf '%s' "$segments_with_dur" | jq '
  reduce .[] as $s ([];
    if ($s.duration_seconds < 300 and length > 0)
    then (.[:-1]) + [(.[-1] | .end = $s.end)]
    else . + [$s]
    end
  )
  | reduce .[] as $s ([];
      if (length > 0) and (.[-1].type == $s.type)
      then (.[:-1]) + [(.[-1] | .end = $s.end)]
      else . + [$s]
      end
    )
  | map(. + {
      duration_seconds: (
        ((.end | strptime("%Y-%m-%d %H:%M:%S") | mktime)
         - (.start | strptime("%Y-%m-%d %H:%M:%S") | mktime))
      )
    })
')"

# 集計
total_work="$(printf '%s' "$merged" | jq '[.[] | select(.type == "work") | .duration_seconds] | add // 0')"
total_break="$(printf '%s' "$merged" | jq '[.[] | select(.type == "break") | .duration_seconds] | add // 0')"

# duration表記を付与
segments_pretty="$(printf '%s' "$merged" | jq --arg date "$TARGET_DATE" '
  map(. + {
    duration: (
      (.duration_seconds | tonumber) as $s
      | "\(($s/3600) | floor)h \(((($s%3600)/60) | floor) | tostring | if length < 2 then "0" + . else . end)m"
    ),
    start_time: (.start | sub("^\($date) "; "")),
    end_time: (.end | sub("^\($date) "; ""))
  })
')"

boot_display="${boot_str:-unknown}"
if [ -n "$boot_str" ]; then
  boot_display="${boot_str#$TARGET_DATE }"
fi
end_display="${end_str#$TARGET_DATE }"

jq -n \
  --arg date "$TARGET_DATE" \
  --arg boot "$boot_display" \
  --arg end "$end_display" \
  --argjson segments "$segments_pretty" \
  --argjson total_work "$total_work" \
  --argjson total_break "$total_break" \
  --arg total_work_str "$(fmt_duration "$total_work")" \
  --arg total_break_str "$(fmt_duration "$total_break")" \
  '{
    date: $date,
    boot: $boot,
    end: $end,
    segments: $segments,
    total_work_seconds: $total_work,
    total_work: $total_work_str,
    total_break_seconds: $total_break,
    total_break: $total_break_str
  }'
