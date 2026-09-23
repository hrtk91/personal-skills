#!/usr/bin/env bash
set -euo pipefail

repo="${HOME}/repos/personal-skills"
remote="origin"
base_branch="main"
dry_run=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --remote) remote="$2"; shift 2 ;;
    --base-branch) base_branch="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

repo="$(cd "$repo" && pwd)"
common_dir="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
lock_file="${common_dir}/personal-skills-update.lock"

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "update_status=busy repo=$repo"
  exit 10
fi

current_branch="$(git -C "$repo" branch --show-current)"
if [ "$current_branch" != "$base_branch" ]; then
  reported_branch="${current_branch:-detached}"
  echo "update_status=blocked reason=branch current=$reported_branch expected=$base_branch" >&2
  exit 20
fi

if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "update_status=blocked reason=dirty_worktree" >&2
  exit 20
fi

GIT_TERMINAL_PROMPT=0 git -C "$repo" fetch "$remote" "$base_branch"
read -r ahead behind < <(git -C "$repo" rev-list --left-right --count "HEAD...${remote}/${base_branch}")
echo "update_state repo=$repo branch=$base_branch ahead=$ahead behind=$behind"

if [ "$ahead" -ne 0 ]; then
  echo "update_status=blocked reason=local_commits ahead=$ahead" >&2
  exit 20
fi

if [ "$dry_run" = true ]; then
  echo "update_status=dry_run behind=$behind"
  exit 0
fi

if [ "$behind" -ne 0 ]; then
  if ! git -C "$repo" merge --ff-only "${remote}/${base_branch}"; then
    echo "update_status=blocked reason=fast_forward_failed" >&2
    exit 21
  fi
fi

echo "update_status=ok head=$(git -C "$repo" rev-parse HEAD)"
