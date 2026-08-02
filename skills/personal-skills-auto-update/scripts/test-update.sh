#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d /tmp/personal-skills-update-test.XXXXXX)"

git init --bare "$test_root/origin.git" >/dev/null
git clone "$test_root/origin.git" "$test_root/seed" >/dev/null
git -C "$test_root/seed" config user.name test
git -C "$test_root/seed" config user.email test@example.invalid
git -C "$test_root/seed" switch -c main >/dev/null
git -C "$test_root/seed" commit --allow-empty -m initial >/dev/null
git -C "$test_root/seed" push -u origin main >/dev/null
git --git-dir="$test_root/origin.git" symbolic-ref HEAD refs/heads/main
git clone "$test_root/origin.git" "$test_root/client" >/dev/null

git -C "$test_root/seed" commit --allow-empty -m upstream >/dev/null
git -C "$test_root/seed" push >/dev/null
"$script_dir/update.sh" --repo "$test_root/client" --skip-install

remote_head="$(git -C "$test_root/client" rev-parse origin/main)"
local_head="$(git -C "$test_root/client" rev-parse HEAD)"
[ "$local_head" = "$remote_head" ]

printf 'uncommitted\n' > "$test_root/client/untracked.txt"
set +e
"$script_dir/update.sh" --repo "$test_root/client" --skip-install
status=$?
set -e
[ "$status" -eq 20 ]
[ "$(cat "$test_root/client/untracked.txt")" = "uncommitted" ]
rm "$test_root/client/untracked.txt"

git -C "$test_root/client" switch --detach >/dev/null
set +e
"$script_dir/update.sh" --repo "$test_root/client" --skip-install
status=$?
set -e
[ "$status" -eq 20 ]
git -C "$test_root/client" switch main >/dev/null

git -C "$test_root/client" config user.name test
git -C "$test_root/client" config user.email test@example.invalid
git -C "$test_root/client" commit --allow-empty -m local-only >/dev/null
set +e
"$script_dir/update.sh" --repo "$test_root/client" --skip-install
status=$?
set -e
[ "$status" -eq 20 ]

common_dir="$(git -C "$test_root/client" rev-parse --path-format=absolute --git-common-dir)"
exec 8>"$common_dir/personal-skills-update.lock"
flock -n 8
set +e
"$script_dir/update.sh" --repo "$test_root/client" --skip-install
status=$?
set -e
[ "$status" -eq 10 ]

echo "test_status=passed platform=wsl temp=$test_root"
