#!/bin/bash
#
# git-exclude: .git/info/exclude の内容を動的に注入する
# git管理外のファイル一覧を常に最新の状態で提供する
#

GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0

EXCLUDE_FILE="$GIT_COMMON_DIR/info/exclude"
[ -f "$EXCLUDE_FILE" ] || exit 0

ENTRIES=$(grep -v '^#' "$EXCLUDE_FILE" | grep -v '^$')
[ -z "$ENTRIES" ] && exit 0

echo "[Git Exclude] .git/info/exclude で管理外のファイル:"
echo "$ENTRIES" | sed 's/^/  /'
