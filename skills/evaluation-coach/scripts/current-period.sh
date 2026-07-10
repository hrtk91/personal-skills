#!/bin/bash
# 現在の評価期ディレクトリパスを返す
# 4-9月: <year>-H1、10-3月: <year>-H2（10月以降は同年、1-3月は前年）

set -euo pipefail

VAULT="$HOME/obsidian-vault/評価面談対策"
month=$(date +%m)
year=$(date +%Y)

if [ "$month" -ge 4 ] && [ "$month" -le 9 ]; then
  echo "$VAULT/${year}-H1"
elif [ "$month" -ge 10 ]; then
  echo "$VAULT/${year}-H2"
else
  prev=$((year - 1))
  echo "$VAULT/${prev}-H2"
fi
