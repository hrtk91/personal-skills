#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Claude Code と Codex の両方に symlink を張る
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"

link_skills() {
  local target_dir="$1"
  local label="$2"
  mkdir -p "$target_dir"

  for skill_dir in "$REPO_ROOT"/skills/*; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    target="$target_dir/$skill_name"

    if [ -L "$target" ]; then
      current="$(readlink "$target")"
      if [ "$current" = "$skill_dir" ]; then
        echo "[$label] ok: $skill_name"
        continue
      fi
      rm "$target"
    elif [ -e "$target" ]; then
      echo "[$label] skip: $skill_name (already exists, not a symlink)" >&2
      continue
    fi

    ln -s "$skill_dir" "$target"
    echo "[$label] linked: $skill_name -> $skill_dir"
  done
}

link_skills "$CLAUDE_SKILLS_DIR" "claude"
link_skills "$CODEX_SKILLS_DIR" "codex"

# hooks のシンボリックリンク
CLAUDE_HOOKS_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks}"
mkdir -p "$CLAUDE_HOOKS_DIR"

for hook_file in "$REPO_ROOT"/hooks/*.sh "$REPO_ROOT"/hooks/*.ts; do
  [ -f "$hook_file" ] || continue
  hook_name="$(basename "$hook_file")"
  target="$CLAUDE_HOOKS_DIR/$hook_name"

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [ "$current" = "$hook_file" ]; then
      echo "[hooks] ok: $hook_name"
      continue
    fi
    rm "$target"
  elif [ -e "$target" ]; then
    echo "[hooks] skip: $hook_name (already exists, not a symlink)" >&2
    continue
  fi

  ln -s "$hook_file" "$target"
  echo "[hooks] linked: $hook_name -> $hook_file"
done

# session-start.d のシンボリックリンク
STARTUP_DIR="$CLAUDE_HOOKS_DIR/session-start.d"
mkdir -p "$STARTUP_DIR"

for startup_file in "$REPO_ROOT"/hooks/session-start.d/*.sh; do
  [ -f "$startup_file" ] || continue
  startup_name="$(basename "$startup_file")"
  target="$STARTUP_DIR/$startup_name"

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [ "$current" = "$startup_file" ]; then
      echo "[session-start.d] ok: $startup_name"
      continue
    fi
    rm "$target"
  elif [ -e "$target" ]; then
    echo "[session-start.d] skip: $startup_name (already exists, not a symlink)" >&2
    continue
  fi

  ln -s "$startup_file" "$target"
  echo "[session-start.d] linked: $startup_name -> $startup_file"
done

# commands のシンボリックリンク
CLAUDE_COMMANDS_DIR="${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"
mkdir -p "$CLAUDE_COMMANDS_DIR"

for cmd_file in "$REPO_ROOT"/commands/*.md; do
  [ -f "$cmd_file" ] || continue
  cmd_name="$(basename "$cmd_file")"
  target="$CLAUDE_COMMANDS_DIR/$cmd_name"

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [ "$current" = "$cmd_file" ]; then
      echo "[commands] ok: $cmd_name"
      continue
    fi
    rm "$target"
  elif [ -e "$target" ]; then
    echo "[commands] skip: $cmd_name (already exists, not a symlink)" >&2
    continue
  fi

  ln -s "$cmd_file" "$target"
  echo "[commands] linked: $cmd_name -> $cmd_file"
done
