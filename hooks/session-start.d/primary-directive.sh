#!/bin/bash
#
# primary-directive: 作業方針リマインダー・CWD注入・worktreeガード自動有効化
#

DIRECTIVE_PATH="$HOME/.claude/hooks/primary-directive.md"
if [ -f "$DIRECTIVE_PATH" ]; then
  echo "[Reminder] $(cat "$DIRECTIVE_PATH")"
fi

echo "[CWD] $(pwd)"
echo "⚠️ ファイル編集は必ず上記CWD配下で行うこと。他のworktreeを誤って触らない。"

# 全worktreeで cwd-guard + delegate-driven を自動ON
proj="${CLAUDE_PROJECT_DIR:-$PWD}"
mkdir -p "$proj/.claude"
guards=""
if [ ! -f "$proj/.claude/cwd-guard" ]; then
  touch "$proj/.claude/cwd-guard"
  guards="cwd-guard"
fi
if [ ! -f "$proj/.claude/delegate-driven" ]; then
  touch "$proj/.claude/delegate-driven"
  guards="${guards:+$guards + }delegate-driven"
fi
if [ -n "$guards" ]; then
  echo "[Auto Guard] 🛡️ $guards 自動ON (解除: /cwd-guard false, /delegate-driven false)"
fi
