#!/bin/bash
# CWDガード: Write/Edit/NotebookEdit の対象がプロジェクトCWD外ならdeny。
# フラグ $CLAUDE_PROJECT_DIR/.claude/cwd-guard が存在する場合のみ有効。
#
# 素通し条件:
# - フラグが存在しない (ガード無効)
# - 書き込み先がプロジェクト内
# - 書き込み先が許可リスト (auto-memory, /tmp, obsidian-vault)
#
# トグル: /cwd-guard true|false|status
set -u

input=$(cat)

proj="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$proj/.claude/cwd-guard" ] || exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -z "$file_path" ] && exit 0

# 許可リスト: プロジェクト内・auto-memory・/tmp・obsidian
case "$file_path" in
  "$proj"/*) exit 0 ;;
  "$HOME"/.claude/*) exit 0 ;;
  /tmp/*) exit 0 ;;
  "$TMPDIR"*) exit 0 ;;
  "$HOME"/obsidian-vault/*) exit 0 ;;
esac

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"⛔ CWDガード: 書き込み先 ($file_path) がプロジェクトCWD ($proj) の外です。他のworktreeを誤って触っていませんか？ 解除: /cwd-guard false"}}
EOF
exit 0
