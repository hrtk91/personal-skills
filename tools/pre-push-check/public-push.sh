#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--push]" >&2
  exit 2
}

push_after_check=false
case $# in
  0) ;;
  1)
    [[ $1 == --push ]] || usage
    push_after_check=true
    ;;
  *) usage ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
repo_parent=$(dirname -- "$repo_root")
repo_name=$(basename -- "$repo_root")
remote=${PUBLIC_PUSH_REMOTE:-https://github.com/hrtk91/personal-skills.git}

repo_device=$(stat -c %d "$repo_root")
parent_device=$(stat -c %d "$repo_parent")
if [[ $repo_device != "$parent_device" ]]; then
  echo "public-push: repository and temporary parent must share a filesystem" >&2
  exit 1
fi

tmp_root=$(mktemp -d "$repo_parent/.${repo_name}.public-push.XXXXXX")
cleanup() {
  rm -rf -- "$tmp_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

clone_dir=$tmp_root/repo
git clone --bare --single-branch -b main "$repo_root" "$clone_dir"
git -C "$clone_dir" fetch --no-tags "$remote" refs/heads/main:refs/base
git -C "$clone_dir" filter-branch --prune-empty --index-filter \
  'git rm -r -q --cached --ignore-unmatch handoff "tools/explore-ab/results*"' \
  refs/base..main

(cd "$clone_dir" && "$script_dir/check.sh" refs/base..main)

if [[ $push_after_check == true ]]; then
  gh_path=$(command -v gh) || {
    echo "public-push: gh is required for --push" >&2
    exit 1
  }
  printf -v gh_helper '!%q --user hrtk91 auth git-credential' "$gh_path"
  git -C "$clone_dir" \
    -c credential.https://github.com.helper= \
    -c "credential.https://github.com.helper=$gh_helper" \
    push "$remote" main:main
fi
