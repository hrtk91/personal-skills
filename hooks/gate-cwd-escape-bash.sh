#!/bin/bash
# CWDガード (Bash版): 他worktreeへのcd・git switch/checkout をaskに降格。
# フラグ $CLAUDE_PROJECT_DIR/.claude/cwd-guard が存在する場合のみ有効。
set -u

input=$(cat)

proj="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$proj/.claude/cwd-guard" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# フラグファイル自体の削除を防止 (rm .claude/cwd-guard, rm .claude/delegate-driven)
if printf '%s' "$cmd" | grep -qE 'rm\s.*\.(claude/(cwd-guard|delegate-driven))'; then
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"⚠️ ガードフラグの直接削除を検出。/cwd-guard false または /delegate-driven false コマンドで解除してください。本当に直接削除しますか？"}}
EOF
  exit 0
fi

# git switch / git checkout をask扱い
deny_reason=""

if printf '%s' "$cmd" | grep -qE '^\s*(git\s+(switch|checkout)\s)'; then
  deny_reason="git switch/checkout はブランチを切り替えます。このworktreeで実行して問題ないですか？"
fi

# 別worktreeへのcd検出
if [ -z "$deny_reason" ]; then
  cd_target=$(printf '%s' "$cmd" | grep -oE 'cd\s+["\x27]?(/[^;&|"\x27]+|~/[^;&|"\x27]+)' | head -1 | sed 's/^cd\s*//' | tr -d "\"'")
  if [ -n "$cd_target" ]; then
    cd_target=$(eval echo "$cd_target" 2>/dev/null || echo "$cd_target")
    real_target=$(realpath "$cd_target" 2>/dev/null || echo "$cd_target")
    real_proj=$(realpath "$proj" 2>/dev/null || echo "$proj")
    case "$real_target" in
      "$real_proj"/*|"$real_proj") exit 0 ;;
    esac
    if printf '%s' "$real_target" | grep -q 'school_health_dx'; then
      deny_reason="cd先 ($cd_target) は別のworktreeです。このworktree ($proj) 外への移動は意図的ですか？"
    fi
  fi
fi

[ -z "$deny_reason" ] && exit 0

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"⚠️ CWDガード: $deny_reason 解除: /cwd-guard false"}}
EOF
exit 0
