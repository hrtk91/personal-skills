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
