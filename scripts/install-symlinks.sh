#!/usr/bin/env shx

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"
HERMES_SKILLS_DIR="${HERMES_SKILLS_DIR:-$HOME/.hermes/skills}"

link_skill() {
  skill_dir="$1"
  target="$2"

  if ! mkdir -p "$(dirname "$target")" {
    echo "skip: cannot create parent for $target" >&2
    return 0
  }

  if [ -L "$target" ] {
    current="$(readlink "$target")"
    if [ "$current" = "$skill_dir" ] {
      echo "ok: $target -> $skill_dir"
      return
    }
    rm "$target"
  } elif [ -e "$target" ] {
    echo "skip: $target already exists and is not a symlink" >&2
    return
  }

  if ln -s "$skill_dir" "$target" {
    echo "linked: $target -> $skill_dir"
  } else {
    echo "skip: failed to link $target -> $skill_dir" >&2
  }
}

hermes_category_for() {
  skill_name="$1"
  match "$skill_name" {
    "create-pull-request" => {
      echo "github"
    }
    _ => {
      return 1
    }
  }
}

for skill_dir in "$REPO_ROOT"/skills/* {
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  link_skill "$skill_dir" "$CODEX_SKILLS_DIR/$skill_name"

  if category="$(hermes_category_for "$skill_name")" {
    link_skill "$skill_dir" "$HERMES_SKILLS_DIR/$category/$skill_name"
  }
}
