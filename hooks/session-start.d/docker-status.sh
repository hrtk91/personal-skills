#!/bin/bash
#
# docker-status: 起動中のDockerコンテナ一覧を注入する
#

# Git ブランチ情報
BRANCH=$(git branch --show-current 2>/dev/null)
[ -n "$BRANCH" ] && echo "[Git] ブランチ: $BRANCH"

CONTAINERS=$(docker ps --format "{{.Names}}" 2>/dev/null)
[ -z "$CONTAINERS" ] && exit 0

COUNT=$(echo "$CONTAINERS" | wc -l | tr -d ' ')
echo "[Docker] 起動中コンテナ: ${COUNT}件"
echo "$CONTAINERS" | sed 's/^/  /'
