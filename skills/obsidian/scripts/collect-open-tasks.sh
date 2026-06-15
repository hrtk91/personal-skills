#!/bin/bash
# 直近のデイリーノートから未完了タスク(- [ ])を収集する
# 重複を排除し、最後に出現したファイル名と一緒に出力する
#
# 出力形式: YYYY-MM-DD<TAB>タスク内容
# 使い方:
#   collect-open-tasks.sh [--last N] [--exclude YYYY-MM-DD]
#
# オプション:
#   --last N     直近N件のデイリーノートから収集（デフォルト: 3）
#   --exclude    除外する日付（通常は今日）
#
# 戦略: 同月のデイリーノートから直近N件を取得する（3営業日分程度）
# JSTを意識: date コマンドでJST指定

VAULT="$HOME/obsidian-vault"
DAILY_DIR="$VAULT/デイリーノート"
EXCLUDE_DATE=""
LAST_N=3

# 引数パース
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude)
      EXCLUDE_DATE="$2"
      shift 2
      ;;
    --last)
      LAST_N="$2"
      shift 2
      ;;
    *)
      # 後方互換: 位置引数は除外日付として扱う
      EXCLUDE_DATE="$1"
      shift
      ;;
  esac
done

# 今日の日付（JST）
TODAY=$(TZ=Asia/Tokyo date "+%Y-%m-%d")
if [ -z "$EXCLUDE_DATE" ]; then
  EXCLUDE_DATE="$TODAY"
fi

# 同月のディレクトリを取得（JST基準）
CURRENT_YEAR=$(TZ=Asia/Tokyo date "+%Y")
CURRENT_MONTH=$(TZ=Asia/Tokyo date "+%m")
MONTH_DIR="$DAILY_DIR/$CURRENT_YEAR/$CURRENT_MONTH"

# 同月のデイリーノートから、除外日を除いた直近N件を取得
TARGET_FILES=()
if [ -d "$MONTH_DIR" ]; then
  while IFS= read -r file; do
    date_str=$(basename "$file" .md)
    if [ "$date_str" != "$EXCLUDE_DATE" ]; then
      TARGET_FILES+=("$file")
    fi
  done < <(find "$MONTH_DIR" -name "????-??-??.md" -type f | sort -r | head -n $((LAST_N + 1)))
fi

# 同月で足りない場合、前月からも補完
if [ ${#TARGET_FILES[@]} -lt "$LAST_N" ]; then
  PREV_MONTH=$(TZ=Asia/Tokyo date -v-1m "+%m")
  PREV_YEAR=$(TZ=Asia/Tokyo date -v-1m "+%Y")
  PREV_MONTH_DIR="$DAILY_DIR/$PREV_YEAR/$PREV_MONTH"
  if [ -d "$PREV_MONTH_DIR" ]; then
    REMAINING=$((LAST_N - ${#TARGET_FILES[@]}))
    while IFS= read -r file; do
      date_str=$(basename "$file" .md)
      if [ "$date_str" != "$EXCLUDE_DATE" ]; then
        TARGET_FILES+=("$file")
      fi
    done < <(find "$PREV_MONTH_DIR" -name "????-??-??.md" -type f | sort -r | head -n "$REMAINING")
  fi
fi

# 直近N件に絞る
TARGET_FILES=("${TARGET_FILES[@]:0:$LAST_N}")

# 対象ファイルから未完了タスクを抽出
for file in "${TARGET_FILES[@]}"; do
  date_str=$(basename "$file" .md)

  grep -E '^\s*- \[ \] .+' "$file" 2>/dev/null | while read -r line; do
    task=$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/^- \[ \] //')
    if [ -n "$task" ]; then
      printf "%s\t%s\n" "$date_str" "$task"
    fi
  done
done | \
  # 同じタスク内容は最新の日付のものだけ残す（重複排除）
  awk -F'\t' '{tasks[$2] = $1 "\t" $2} END {for (t in tasks) print tasks[t]}' | \
  sort -t$'\t' -k1,1
