#!/usr/bin/env bash
set -euo pipefail

source_repo="${HOME}/repos/personal-skills"
runtime_repo="${XDG_DATA_HOME:-$HOME/.local/share}/personal-skills-runtime"
base_branch="main"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-repo) source_repo="$2"; shift 2 ;;
    --runtime-repo) runtime_repo="$2"; shift 2 ;;
    --base-branch) base_branch="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

source_repo="$(cd "$source_repo" && pwd)"
remote_url="$(git -C "$source_repo" remote get-url origin)"

if [ ! -d "$runtime_repo/.git" ]; then
  mkdir -p "$(dirname "$runtime_repo")"
  git clone --branch "$base_branch" --single-branch "$remote_url" "$runtime_repo"
fi
runtime_repo="$(cd "$runtime_repo" && pwd)"
runtime_remote_url="$(git -C "$runtime_repo" remote get-url origin)"
if [ "$runtime_remote_url" != "$remote_url" ]; then
  echo "install_status=blocked reason=runtime_origin_mismatch expected=$remote_url actual=$runtime_remote_url" >&2
  exit 20
fi

bash "$runtime_repo/skills/personal-skills-auto-update/scripts/update.sh" \
  --repo "$runtime_repo" \
  --base-branch "$base_branch"

unit_dir="${HOME}/.config/systemd/user"
mkdir -p "$unit_dir"
escaped_repo="$(printf '%s' "$runtime_repo" | sed 's/[\\&|]/\\&/g')"

sed "s|@REPO@|$escaped_repo|g" \
  "$runtime_repo/skills/personal-skills-auto-update/assets/personal-skills-update.service" \
  > "$unit_dir/personal-skills-update.service"
cp \
  "$runtime_repo/skills/personal-skills-auto-update/assets/personal-skills-update.timer" \
  "$unit_dir/personal-skills-update.timer"

systemctl --user daemon-reload
systemctl --user enable --now personal-skills-update.timer
systemctl --user status personal-skills-update.timer --no-pager
