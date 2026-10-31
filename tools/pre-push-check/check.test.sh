#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
real_gitleaks=$(command -v gitleaks || true)
if [[ -z $real_gitleaks ]]; then
  echo "FAIL: gitleaks is required to run this test" >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
new_repo() {
  local dir=$1
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.name Test
  git -C "$dir" config user.email test@example.invalid
  printf 'clean\n' >"$dir/file.txt"
  git -C "$dir" add file.txt
  git -C "$dir" commit -qm base
}

# Ordinary additions pass.
new_repo "$tmp/ordinary"
printf 'ordinary change\n' >>"$tmp/ordinary/file.txt"
git -C "$tmp/ordinary" commit -qam ordinary
(cd "$tmp/ordinary" && "$repo_root/tools/pre-push-check/check.sh" HEAD~1..HEAD)
echo "PASS: ordinary change passes"

# A newly added line containing the actual home path is rejected without echoing its contents.
new_repo "$tmp/home"
printf 'path=%s\n' "$HOME" >>"$tmp/home/file.txt"
git -C "$tmp/home" commit -qam home-path
if (cd "$tmp/home" && "$repo_root/tools/pre-push-check/check.sh" HEAD~1..HEAD) >"$tmp/home.out" 2>&1; then
  fail 'HOME path was accepted'
fi
grep -F 'file.txt:' "$tmp/home.out" >/dev/null || fail 'HOME finding did not identify the file and line'
! grep -F "$HOME" "$tmp/home.out" >/dev/null || fail 'HOME path leaked in diagnostic'
echo "PASS: HOME path is rejected with file and line only"

# A path added in one commit and removed in the next remains detectable in the pushed history.
new_repo "$tmp/home-history"
printf 'path=%s/history\n' "$HOME" >>"$tmp/home-history/file.txt"
git -C "$tmp/home-history" commit -qam add-home-path
added_sha=$(git -C "$tmp/home-history" rev-parse --short HEAD)
printf 'clean again\n' >>"$tmp/home-history/file.txt"
git -C "$tmp/home-history" commit -qam remove-home-path
if (cd "$tmp/home-history" && "$repo_root/tools/pre-push-check/check.sh" HEAD~2..HEAD) >"$tmp/home-history.out" 2>&1; then
  fail 'HOME path removed by a later commit was accepted'
fi
grep -F "$added_sha:file.txt:" "$tmp/home-history.out" >/dev/null || fail 'history finding did not identify the adding commit, file, and line'
! grep -F "$HOME" "$tmp/home-history.out" >/dev/null || fail 'HOME path leaked in history diagnostic'
echo "PASS: HOME path added then removed across commits is rejected with commit, file, and line"

# A diff body beginning with two plus signs must not be mistaken for a file header.
new_repo "$tmp/double-plus"
printf '++ %s/x\n' "$HOME" >>"$tmp/double-plus/file.txt"
git -C "$tmp/double-plus" commit -qam double-plus-home-path
if (cd "$tmp/double-plus" && "$repo_root/tools/pre-push-check/check.sh" HEAD~1..HEAD) >"$tmp/double-plus.out" 2>&1; then
  fail 'HOME path on a ++-prefixed added line was accepted'
fi
grep -F 'file.txt:' "$tmp/double-plus.out" >/dev/null || fail '++-prefixed finding did not identify the file and line'
! grep -F "$HOME" "$tmp/double-plus.out" >/dev/null || fail 'HOME path leaked in ++-prefixed diagnostic'
echo "PASS: ++-prefixed HOME path is rejected with file and line only"

# A well-known GitHub token-shaped fake secret is rejected by real gitleaks.
new_repo "$tmp/secret"
printf 'token=ghp_123456789012345678901234567890123456\n' >>"$tmp/secret/file.txt"
git -C "$tmp/secret" commit -qam secret
if (cd "$tmp/secret" && "$repo_root/tools/pre-push-check/check.sh" HEAD~1..HEAD) >"$tmp/secret.out" 2>&1; then
  fail 'gitleaks-detectable fake key was accepted'
fi
! grep -F 'ghp_123456789012345678901234567890123456' "$tmp/secret.out" >/dev/null || fail 'secret value leaked in diagnostic'
echo "PASS: gitleaks-detectable fake key is rejected without printing the value"

# Keep git available but hide the installed gitleaks binary.
mkdir "$tmp/no-gitleaks"
ln -s "$(command -v git)" "$tmp/no-gitleaks/git"
ln -s "$(command -v awk)" "$tmp/no-gitleaks/awk"
new_repo "$tmp/missing"
if (cd "$tmp/missing" && PATH="$tmp/no-gitleaks:/usr/bin:/bin" "$repo_root/tools/pre-push-check/check.sh" HEAD~0..HEAD) >"$tmp/missing.out" 2>&1; then
  fail 'check passed without gitleaks'
fi
grep -F 'gitleaks is required' "$tmp/missing.out" >/dev/null || fail 'missing-gitleaks reason was not reported'
echo "PASS: missing gitleaks fails closed with a reason"

# A secret already present on origin/main is outside the new-branch range and must not block.
new_repo "$tmp/hook"
mkdir -p "$tmp/hook/tools/pre-push-check" "$tmp/hook/.githooks"
cp "$repo_root/tools/pre-push-check/check.sh" "$tmp/hook/tools/pre-push-check/check.sh"
cp "$repo_root/.githooks/pre-push" "$tmp/hook/.githooks/pre-push"
chmod +x "$tmp/hook/tools/pre-push-check/check.sh" "$tmp/hook/.githooks/pre-push"
printf 'token=ghp_123456789012345678901234567890123456\n' >>"$tmp/hook/file.txt"
git -C "$tmp/hook" commit -qam old-secret
base=$(git -C "$tmp/hook" rev-parse HEAD)
git -C "$tmp/hook" update-ref refs/remotes/origin/main "$base"
printf 'later clean commit\n' >>"$tmp/hook/file.txt"
git -C "$tmp/hook" commit -qam later-clean
newsha=$(git -C "$tmp/hook" rev-parse HEAD)
printf 'refs/heads/new %s refs/heads/new %040d\n' "$newsha" 0 |
  (cd "$tmp/hook" && "$repo_root/.githooks/pre-push")
echo "PASS: hook checks new branch from origin/main and ignores older out-of-range commit"

echo "All pre-push-check tests passed."
