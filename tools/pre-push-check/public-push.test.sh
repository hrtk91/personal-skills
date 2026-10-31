#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
real_gitleaks=$(command -v gitleaks || true)
if [[ -z $real_gitleaks ]]; then
  echo "FAIL: gitleaks is required to run this test" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
configure_repo() {
  git -C "$1" config user.name "Public push test"
  git -C "$1" config user.email "public-push-test@example.invalid"
}
clone_case() {
  local source=$1 dest=$2 remote=$3
  git clone -q --no-hardlinks "$source" "$dest"
  configure_repo "$dest"
  git clone -q --bare --no-hardlinks "$dest" "$remote"
}
assert_temp_cleaned() {
  local source=$1 parent name
  parent=$(dirname -- "$source")
  name=$(basename -- "$source")
  if compgen -G "$parent/.$name.public-push.*" >/dev/null; then
    fail "temporary clone directory was left behind for $name"
  fi
}

mkdir -p "$tmp/bin"
cat >"$tmp/bin/gh" <<'GH'
#!/usr/bin/env sh
exit 99
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

# Create a real feature branch in a temporary clone, then merge it into main
# with --no-ff so the script is exercised on the same entry path as adoption.
work=$tmp/integration
git clone -q --no-hardlinks --single-branch -b main "$repo_root" "$work"
configure_repo "$work"
git -C "$work" switch -q -c test/public-push-feature
mkdir -p "$work/tools/pre-push-check" "$work/handoff"
cp "$repo_root/tools/pre-push-check/public-push.sh" "$work/tools/pre-push-check/public-push.sh"
cp "$repo_root/tools/pre-push-check/public-push.test.sh" "$work/tools/pre-push-check/public-push.test.sh"
chmod +x "$work/tools/pre-push-check/public-push.sh" "$work/tools/pre-push-check/public-push.test.sh"
printf 'test-only handoff marker\n' >"$work/handoff/public-push-filter-marker.md"
git -C "$work" add tools/pre-push-check/public-push.sh tools/pre-push-check/public-push.test.sh handoff/public-push-filter-marker.md
git -C "$work" commit -qm 'test fixture: add public push script branch'
git -C "$work" switch -q main
git -C "$work" merge --no-ff -q test/public-push-feature -m 'test fixture: merge public push feature'

remote=$tmp/public.git
git clone -q --bare --single-branch -b main "$repo_root" "$remote"
before=$(git --git-dir "$remote" rev-parse refs/heads/main)
no_push_log=$tmp/no-push.log
if ! PUBLIC_PUSH_REMOTE="$remote" bash "$work/tools/pre-push-check/public-push.sh" >"$no_push_log" 2>&1; then
  cat "$no_push_log" >&2
  fail 'merged main did not pass public-push.sh without --push'
fi
after_check=$(git --git-dir "$remote" rev-parse refs/heads/main)
[[ $after_check == "$before" ]] || fail 'public main changed when --push was omitted'
assert_temp_cleaned "$work"
echo 'PASS: --no-ff merged main passes without pushing; remote main is unchanged'

push_log=$tmp/push.log
if ! PUBLIC_PUSH_REMOTE="$remote" bash "$work/tools/pre-push-check/public-push.sh" --push >"$push_log" 2>&1; then
  cat "$push_log" >&2
  fail 'clean history was not pushed to the local bare repository'
fi
after_push=$(git --git-dir "$remote" rev-parse refs/heads/main)
[[ $after_push != "$before" ]] || fail 'clean --push did not advance remote main'
git --git-dir "$remote" merge-base --is-ancestor "$before" "$after_push" || fail 'local push was not a fast-forward'
published_paths=$(git --git-dir "$remote" ls-tree -r --name-only "$after_push")
if grep -q '^handoff/' <<<"$published_paths"; then
  fail 'handoff content remains in the published main tree'
fi
! grep -Fx 'handoff/public-push-filter-marker.md' <<<"$published_paths" >/dev/null || fail 'handoff marker was pushed'
assert_temp_cleaned "$work"
echo 'PASS: clean filtered history is pushed fast-forward; new handoff content is absent'

# A runtime-assembled token secret must stop before push, without storing the
# complete fake-token shape in this test source.
secret_source=$tmp/secret-source
secret_remote=$tmp/secret.git
clone_case "$work" "$secret_source" "$secret_remote"
secret_before=$(git --git-dir "$secret_remote" rev-parse refs/heads/main)
token_prefix='ghp_'
token_part_one='123456789012'
token_part_two='345678901234'
token_part_three='567890123456'
printf 'token=%s%s%s%s\n' "$token_prefix" "$token_part_one" "$token_part_two" "$token_part_three" >>"$secret_source/public-push-fixture.txt"
git -C "$secret_source" add public-push-fixture.txt
git -C "$secret_source" commit -qm 'test fixture: add runtime-built fake secret'
secret_log=$tmp/secret.log
if PUBLIC_PUSH_REMOTE="$secret_remote" bash "$secret_source/tools/pre-push-check/public-push.sh" --push >"$secret_log" 2>&1; then
  fail 'runtime-built fake token was accepted'
fi
! grep -F "${token_prefix}${token_part_one}${token_part_two}${token_part_three}" "$secret_log" >/dev/null || fail 'fake token leaked in diagnostics'
[[ $(git --git-dir "$secret_remote" rev-parse refs/heads/main) == "$secret_before" ]] || fail 'secret history was pushed'
assert_temp_cleaned "$secret_source"
echo 'PASS: runtime-built fake secret is rejected without pushing; temporary clone is removed'

# The check also rejects the caller's HOME path in added history.
home_source=$tmp/home-source
home_remote=$tmp/home.git
clone_case "$work" "$home_source" "$home_remote"
home_before=$(git --git-dir "$home_remote" rev-parse refs/heads/main)
test_home=$tmp/private-home
mkdir -p "$test_home"
printf 'local_path=%s/credential.json\n' "$test_home" >>"$home_source/public-push-fixture.txt"
git -C "$home_source" add public-push-fixture.txt
git -C "$home_source" commit -qm 'test fixture: add local home path'
home_log=$tmp/home.log
if HOME="$test_home" PUBLIC_PUSH_REMOTE="$home_remote" bash "$home_source/tools/pre-push-check/public-push.sh" --push >"$home_log" 2>&1; then
  fail 'HOME path history was accepted'
fi
grep -F 'public-push-fixture.txt:' "$home_log" >/dev/null || fail 'HOME-path rejection did not identify its file'
! grep -F "$test_home" "$home_log" >/dev/null || fail 'HOME path leaked in diagnostics'
[[ $(git --git-dir "$home_remote" rev-parse refs/heads/main) == "$home_before" ]] || fail 'HOME-path history was pushed'
assert_temp_cleaned "$home_source"
echo 'PASS: HOME-path history is rejected without leaking the path or pushing'
echo 'All public-push tests passed.'
