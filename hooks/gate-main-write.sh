#!/bin/bash
# メインスレッドの Write/Edit/NotebookEdit をプロジェクトごとのフラグでゲートする PreToolUse hook。
# 委譲駆動 (delegate-driven) モード用: フラグがあるプロジェクトではメインに「実装は subagent に委譲しろ」と返す。
#
# 素通し条件:
# - subagent からの呼び出し (hook 入力に agent_id がある)
# - フラグ $CLAUDE_PROJECT_DIR/.claude/delegate-driven が存在しない (通常モード)
# - 書き込み先がプロジェクト外 (auto-memory, /tmp 等)
#
# トグル: /delegate-driven true|false (実体は .claude/delegate-driven の touch/rm)
set -u

input=$(cat)

agent_id=$(printf '%s' "$input" | jq -r '.agent_id // empty')
[ -n "$agent_id" ] && exit 0

proj="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$proj/.claude/delegate-driven" ] || exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
case "$file_path" in
  "$proj"/*) ;;
  *) exit 0 ;;
esac

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"委譲駆動モード中のためメインスレッドのWrite/Editは禁止。実装はsubagentに委譲すること。ただし小さな修正が連続している/連続しそうな場合はsubagentに細切れ委譲せず、AskUserQuestionでユーザーに /delegate-driven false での一時解除を提案すること"}}
EOF
exit 0
