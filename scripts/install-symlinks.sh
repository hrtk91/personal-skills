#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Claude Code と Codex の両方に skill の symlink を張る。
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"
HERMES_SKILLS_DIR="${HERMES_SKILLS_DIR:-$HOME/.hermes/skills}"

link_one() {
  local source="$1"
  local target="$2"
  local label="$3"

  if ! mkdir -p "$(dirname "$target")"; then
    echo "[$label] skip: cannot create parent for $target" >&2
    return 0
  fi

  if [ -L "$target" ]; then
    local current
    current="$(readlink "$target")"
    if [ "$current" = "$source" ]; then
      echo "[$label] ok: $target -> $source"
      return 0
    fi
    rm "$target"
  elif [ -e "$target" ]; then
    echo "[$label] skip: $target already exists and is not a symlink" >&2
    return 0
  fi

  if ln -s "$source" "$target"; then
    echo "[$label] linked: $target -> $source"
  else
    echo "[$label] skip: failed to link $target -> $source" >&2
  fi
}

link_skills() {
  local target_dir="$1"
  local label="$2"
  local skill_dir skill_name

  mkdir -p "$target_dir"

  for skill_dir in "$REPO_ROOT"/skills/*; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    link_one "$skill_dir" "$target_dir/$skill_name" "$label"
  done
}

link_skills "$CLAUDE_SKILLS_DIR" "claude"
link_skills "$CODEX_SKILLS_DIR" "codex"

# Hermesでは現状、GitHub系skillだけをカテゴリ配下へ公開する。
if [ -d "$REPO_ROOT/skills/create-pull-request" ]; then
  link_one \
    "$REPO_ROOT/skills/create-pull-request" \
    "$HERMES_SKILLS_DIR/github/create-pull-request" \
    "hermes"
fi

# Claude Code hooks の symlink
CLAUDE_HOOKS_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks}"
for hook_file in "$REPO_ROOT"/hooks/*.sh "$REPO_ROOT"/hooks/*.ts; do
  [ -f "$hook_file" ] || continue
  link_one "$hook_file" "$CLAUDE_HOOKS_DIR/$(basename "$hook_file")" "hooks"
done

# session-start.d の symlink
for startup_file in "$REPO_ROOT"/hooks/session-start.d/*.sh; do
  [ -f "$startup_file" ] || continue
  link_one \
    "$startup_file" \
    "$CLAUDE_HOOKS_DIR/session-start.d/$(basename "$startup_file")" \
    "session-start.d"
done

# Claude Code commands の symlink
for command_file in "$REPO_ROOT"/commands/*.md; do
  [ -f "$command_file" ] || continue
  link_one \
    "$command_file" \
    "${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}/$(basename "$command_file")" \
    "commands"
done
