#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 1 || ! $1 =~ ^.+\.\..+$ ]]; then
  echo "usage: $0 A..B" >&2
  exit 1
fi
range=$1

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-push-check: gitleaks is required but was not found in PATH" >&2
  exit 1
fi

if ! git rev-parse --verify "${range%..*}^{commit}" >/dev/null 2>&1 ||
   ! git rev-parse --verify "${range#*..}^{commit}" >/dev/null 2>&1; then
  echo "pre-push-check: invalid commit range: $range" >&2
  exit 1
fi

failed=0
gitleaks git --no-banner --redact --log-opts="$range"
gitleaks_status=$?
if [[ $gitleaks_status -ne 0 ]]; then
  echo "pre-push-check: gitleaks found a secret or failed (exit $gitleaks_status)" >&2
  failed=1
fi

if [[ -n ${HOME:-} ]]; then
  while IFS= read -r commit; do
    [[ -n $commit ]] || continue
    short_commit=$(git rev-parse --short "$commit")
    matches=$(git diff-tree --no-ext-diff --no-color --root --no-commit-id -p --unified=0 -m "$commit" -- | awk -v home="$HOME" -v commit="$short_commit" '
      /^diff --git / { in_header=1; file=""; next }
      in_header && /^\+\+\+ / { file=substr($0,7); next }
      /^@@ / {
        in_header=0
        line=0
        if (match($0, /\+[0-9]+/)) {
          value=substr($0, RSTART+1, RLENGTH-1)
          line=value+0
        }
        next
      }
      /^\+/ {
        if (index(substr($0,2), home)) printf "%s:%s:%d\n", commit, file, line
        line++
        next
      }
      /^ / { line++; next }
    ')
    if [[ -n $matches ]]; then
      while IFS= read -r location; do
        echo "pre-push-check: current HOME path added at $location" >&2
      done <<< "$matches"
      failed=1
    fi
  done < <(git rev-list "$range")
fi

exit "$failed"
