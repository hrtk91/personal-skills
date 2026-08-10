#!/usr/bin/env bash
set -euo pipefail

model=""
reasoning_effort="xhigh"
cwd=""
prompt_file=""
diff_base=""
include_uncommitted="false"
max_turns="12"
web="false"
wait_timeout="600"

usage() {
  cat <<'EOF'
Usage: run.sh --cwd DIR --prompt-file FILE [--diff-base REF] [--include-uncommitted] [--model MODEL] [--reasoning-effort LEVEL] [--max-turns N] [--wait-timeout SEC] [--web]

Runs Grok in a fresh, read-only second-opinion session and waits for its final answer.
EOF
}

while (($# > 0)); do
  case "$1" in
    --cwd)
      cwd="${2:-}"
      shift 2
      ;;
    --prompt-file)
      prompt_file="${2:-}"
      shift 2
      ;;
    --diff-base)
      diff_base="${2:-}"
      shift 2
      ;;
    --include-uncommitted)
      include_uncommitted="true"
      shift
      ;;
    --model)
      model="${2:-}"
      shift 2
      ;;
    --reasoning-effort)
      reasoning_effort="${2:-}"
      shift 2
      ;;
    --max-turns)
      max_turns="${2:-}"
      shift 2
      ;;
    --wait-timeout)
      wait_timeout="${2:-}"
      shift 2
      ;;
    --web)
      web="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v grok >/dev/null 2>&1; then
  echo "grok CLI was not found in PATH." >&2
  exit 127
fi

if ! command -v uuidgen >/dev/null 2>&1; then
  echo "uuidgen was not found in PATH; it is required to track the Grok session." >&2
  exit 127
fi

if [[ ! -d "$cwd" ]]; then
  echo "--cwd must be an existing directory." >&2
  exit 2
fi

if [[ ! -f "$prompt_file" ]]; then
  echo "--prompt-file must be an existing file." >&2
  exit 2
fi

if [[ ! "$max_turns" =~ ^[1-9][0-9]*$ ]]; then
  echo "--max-turns must be a positive integer." >&2
  exit 2
fi

if [[ ! "$wait_timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "--wait-timeout must be a positive integer." >&2
  exit 2
fi

if [[ -z "$reasoning_effort" ]]; then
  echo "--reasoning-effort must not be empty." >&2
  exit 2
fi

if [[ "$diff_base" == -* ]]; then
  echo "--diff-base must not start with a dash." >&2
  exit 2
fi

if [[ "$include_uncommitted" == "true" && -z "$diff_base" ]]; then
  echo "--include-uncommitted requires --diff-base." >&2
  exit 2
fi

effective_prompt="$prompt_file"
temp_dir=""
error_file=""
launch_file=""
session_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"

cleanup() {
  if [[ -n "$temp_dir" ]]; then
    rm -rf "$temp_dir"
  fi
  if [[ -n "$error_file" && -f "$error_file" ]]; then
    rm -f "$error_file"
  fi
  if [[ -n "$launch_file" && -f "$launch_file" ]]; then
    rm -f "$launch_file"
  fi
}

trap cleanup EXIT

if [[ -n "$diff_base" ]]; then
  if ! git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "--diff-base requires --cwd to be inside a git worktree." >&2
    exit 2
  fi

  if ! git -C "$cwd" rev-parse --verify "${diff_base}^{commit}" >/dev/null 2>&1; then
    echo "--diff-base does not resolve to a commit: $diff_base" >&2
    exit 2
  fi

  temp_dir="$(mktemp -d /tmp/grok-second-opinion.XXXXXX)"
  effective_prompt="$temp_dir/prompt.md"
  cp "$prompt_file" "$effective_prompt"
  git -C "$cwd" status --short --branch >"$temp_dir/status.txt"
  if [[ "$include_uncommitted" == "true" ]]; then
    git -C "$cwd" diff --stat "$diff_base" -- >"$temp_dir/diff-stat.txt"
    git -C "$cwd" diff --name-status "$diff_base" -- >"$temp_dir/changed-files.txt"
    git -C "$cwd" diff --no-ext-diff "$diff_base" -- >"$temp_dir/diff.patch"
  else
    git -C "$cwd" diff --stat "${diff_base}...HEAD" -- >"$temp_dir/diff-stat.txt"
    git -C "$cwd" diff --name-status "${diff_base}...HEAD" -- >"$temp_dir/changed-files.txt"
    git -C "$cwd" diff --no-ext-diff "${diff_base}...HEAD" -- >"$temp_dir/diff.patch"
  fi
  if [[ "$include_uncommitted" == "true" ]]; then
    git -C "$cwd" ls-files --others --exclude-standard >"$temp_dir/untracked-files.txt"
  fi

  {
    printf '\n# ラッパーが作成した読み取り用資料\n\n'
    printf -- '- 現在の状態: `%s`\n' "$temp_dir/status.txt"
    printf -- '- 差分の概要: `%s`\n' "$temp_dir/diff-stat.txt"
    printf -- '- 変更ファイル: `%s`\n' "$temp_dir/changed-files.txt"
    if [[ "$include_uncommitted" == "true" ]]; then
      printf -- '- 未追跡ファイル: `%s`\n' "$temp_dir/untracked-files.txt"
    fi
    printf -- '- 差分本体: `%s`\n' "$temp_dir/diff.patch"
    printf '\nこれらを読み取り、リポジトリや一時ファイルを変更せずに回答してください。\n'
  } >>"$effective_prompt"
fi

args=(
  --cwd "$cwd"
  --session-id "$session_id"
  --sandbox read-only
  --always-approve
  --no-memory
  --no-subagents
  --max-turns "$max_turns"
  --output-format plain
  --prompt-file "$effective_prompt"
)

if [[ -n "$model" ]]; then
  args+=(--model "$model")
fi

if [[ "$web" == "true" ]]; then
  args+=(--tools "read_file,grep,list_dir,web_search,web_fetch")
else
  args+=(--tools "read_file,grep,list_dir")
  args+=(--disable-web-search)
fi

error_file="$(mktemp /tmp/grok-second-opinion-error.XXXXXX)"
launch_file="$(mktemp /tmp/grok-second-opinion-launch.XXXXXX)"

set +e
grok --reasoning-effort "$reasoning_effort" "${args[@]}" >"$launch_file" 2>"$error_file"
status=$?
set -e

if [[ "$reasoning_effort" == "xhigh" ]] && grep -Fq "unknown effort level 'xhigh'" "$error_file"; then
  echo "grok: xhigh is not supported by the selected model; retrying with high." >&2
  # The CLI can reserve the ID before rejecting the unsupported effort.
  # Use a new ID for the only retry so the valid session can be observed.
  session_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  for index in "${!args[@]}"; do
    if [[ "${args[$index]}" == "--session-id" ]]; then
      args[$((index + 1))]="$session_id"
      break
    fi
  done
  : >"$launch_file"
  : >"$error_file"
  set +e
  grok --reasoning-effort high "${args[@]}" >"$launch_file" 2>"$error_file"
  status=$?
  set -e
fi

if [[ $status -ne 0 ]]; then
  cat "$launch_file"
  cat "$error_file" >&2
  exit "$status"
fi

if [[ -s "$error_file" ]]; then
  cat "$error_file" >&2
fi

echo "grok: waiting for session $session_id (timeout: ${wait_timeout}s)." >&2
session_updates=""
for ((elapsed = 0; elapsed < wait_timeout; elapsed++)); do
  if [[ -z "$session_updates" ]]; then
    session_updates="$(find "$HOME/.grok/sessions" -type f -path "*/$session_id/updates.jsonl" -print -quit 2>/dev/null || true)"
  fi

  if [[ -n "$session_updates" ]] && grep -Fq '"sessionUpdate":"turn_completed"' "$session_updates"; then
    # `grok export` includes the prompt and intermediate tool activity. The last
    # Assistant block is the completed answer; keep the full transcript addressable
    # by session ID without making every caller parse it.
    grok export "$session_id" | awk '
      /^## Assistant$/ { answer = ""; in_answer = 1; next }
      in_answer { answer = answer $0 ORS }
      END { printf "%s", answer }
    '
    exit 0
  fi

  sleep 1
done

echo "grok: session $session_id did not finish within ${wait_timeout}s." >&2
echo "grok: inspect progress with: grok export $session_id" >&2
exit 124
