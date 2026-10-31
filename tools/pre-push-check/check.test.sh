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
