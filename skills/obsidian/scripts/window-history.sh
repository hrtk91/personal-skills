#!/usr/bin/env bash
# ActivityWatchから指定日のウィンドウ履歴を取得する
# 使い方: window-history.sh [YYYY-MM-DD]
# 出力: JSONL（各行が {timestamp, duration, app, title}）
#
# 依存: ActivityWatchがlocalhost:5600で起動していること
# バケット: aw-watcher-window_* をバケット一覧APIから自動検出
#   （ホスト名解決の変化でバケット名が変わることがあるため、固定名は使わない。
#     例: ホスト名変更で aw-watcher-window_<old-host> → aw-watcher-window_<new-host> へ切替が発生）

set -euo pipefail

TARGET_DATE="${1:-$(date +%Y-%m-%d)}"

# 依存チェック
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

# JSTで当日0時〜翌日0時の範囲をISO8601で指定
# URLパラメータでは `+` がspaceに解釈されるため %2B にエンコード
START="${TARGET_DATE}T00:00:00%2B09:00"
END_DATE="$(date -j -v+1d -f "%Y-%m-%d" "$TARGET_DATE" +%Y-%m-%d)"
END="${END_DATE}T00:00:00%2B09:00"

# ActivityWatchサーバ生存確認
if ! curl -s -o /dev/null -w "%{http_code}" "http://localhost:5600/api/0/info" | grep -q "200"; then
  echo "ActivityWatch server not reachable at localhost:5600" >&2
  echo "Start with: open -a ActivityWatch" >&2
  exit 1
fi

# aw-watcher-window_* バケットを自動検出（複数あれば全てマージ）
WINDOW_BUCKETS="$(curl -s "http://localhost:5600/api/0/buckets/" \
  | jq -r 'keys[] | select(startswith("aw-watcher-window_"))')"

if [ -z "$WINDOW_BUCKETS" ]; then
  echo "No aw-watcher-window_* bucket found" >&2
  exit 1
fi

while IFS= read -r BUCKET; do
  curl -s "http://localhost:5600/api/0/buckets/${BUCKET}/events?start=${START}&end=${END}&limit=-1" \
    | jq -c '.[] | {timestamp, duration, app: .data.app, title: .data.title}'
done <<< "$WINDOW_BUCKETS"
