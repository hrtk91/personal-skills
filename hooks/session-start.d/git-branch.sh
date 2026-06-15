#!/bin/bash
#
# git-branch: 現在のブランチ名を注入する
#

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
echo "[Branch] $BRANCH"
