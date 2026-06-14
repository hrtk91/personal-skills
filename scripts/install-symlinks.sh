#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"

mkdir -p "$CODEX_SKILLS_DIR"

for skill_dir in "$REPO_ROOT"/skills/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  target="$CODEX_SKILLS_DIR/$skill_name"

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [ "$current" = "$skill_dir" ]; then
      echo "ok: $target -> $skill_dir"
      continue
    fi
    rm "$target"
  elif [ -e "$target" ]; then
    echo "skip: $target already exists and is not a symlink" >&2
    continue
  fi

  ln -s "$skill_dir" "$target"
  echo "linked: $target -> $skill_dir"
done
