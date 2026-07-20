#!/usr/bin/env bash
set -euo pipefail

model="grok-4.5"
cwd=""
prompt_file=""
diff_base=""
include_uncommitted="false"
max_turns="12"
web="false"

usage() {
  cat <<'EOF'
Usage: run.sh --cwd DIR --prompt-file FILE [--diff-base REF] [--include-uncommitted] [--model MODEL] [--max-turns N] [--web]

Runs Grok in a fresh, read-only second-opinion session.
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
    --max-turns)
      max_turns="${2:-}"
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

cleanup() {
  if [[ -n "$temp_dir" ]]; then
    rm -rf "$temp_dir"
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
  git -C "$cwd" ls-files --others --exclude-standard >"$temp_dir/untracked-files.txt"

  {
    printf '\n# ラッパーが作成した読み取り用資料\n\n'
    printf -- '- 現在の状態: `%s`\n' "$temp_dir/status.txt"
    printf -- '- 差分の概要: `%s`\n' "$temp_dir/diff-stat.txt"
    printf -- '- 変更ファイル: `%s`\n' "$temp_dir/changed-files.txt"
    printf -- '- 未追跡ファイル: `%s`\n' "$temp_dir/untracked-files.txt"
    printf -- '- 差分本体: `%s`\n' "$temp_dir/diff.patch"
    printf '\nこれらを読み取り、リポジトリや一時ファイルを変更せずに回答してください。\n'
  } >>"$effective_prompt"
fi

args=(
  --cwd "$cwd"
  --model "$model"
  --sandbox read-only
  --always-approve
  --no-memory
  --no-subagents
  --max-turns "$max_turns"
  --output-format plain
  --prompt-file "$effective_prompt"
)

if [[ "$web" == "true" ]]; then
  args+=(--tools "read_file,grep,list_dir,web_search,web_fetch")
else
  args+=(--tools "read_file,grep,list_dir")
  args+=(--disable-web-search)
fi

grok "${args[@]}"
