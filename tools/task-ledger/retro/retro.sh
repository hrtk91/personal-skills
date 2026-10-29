#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TASK_DIR=$(cd "$HERE/.." && pwd)
TASK="$TASK_DIR/bin/task"
DATA="$HOME/.local/share/task-ledger/retro"
LAST="$DATA/last"
LOCK="$DATA/retro.lock"
mkdir -p "$DATA"
exec 9>"$LOCK"
if ! flock -n 9; then echo '振り返りがすでに実行中です。' >&2; exit 0; fi

since_arg=''
while (($#)); do
  case "$1" in
    --since) (($# >= 2)) || { echo '--since に日時が必要です' >&2; exit 2; }; since_arg=$2; shift 2;;
    -h|--help) echo '使い方: retro.sh [--since ISO-8601日時]'; exit 0;;
    *) echo "未知の引数: $1" >&2; exit 2;;
  esac
done
since=${since_arg:-}
if [[ -z "$since" && -f "$LAST" ]]; then since=$(cat "$LAST"); fi
if [[ -z "$since" ]]; then since='1970-01-01T00:00:00Z'; fi
# Validate timestamp before collecting data.
date -d "$since" >/dev/null
stamp=$(date -Is)
day=$(date +%F)
work=$(mktemp -d "${TMPDIR:-/tmp}/task-ledger-retro.XXXXXX")
trap 'rm -rf "$work"' EXIT
input="$work/input.md"
{
  echo '# ハーネス振り返り入力'
  echo "期間: $since から $stamp"
  echo
  echo '## 台帳レポート（JSON trace / task / events相当）'
  "$TASK" report --since "$since" --json
  echo
  echo '## 対象期間の trace'
  # report JSON includes status and span attributes, providing the structured trace evidence.
  echo
  echo '## channel stopped / post 記録'
  channel="$HOME/.cache/agent-channel/channel.jsonl"
  if [[ -f "$channel" ]]; then
    node - "$channel" "$since" <<'NODE'
const fs = require('fs');
const since = Date.parse(process.argv[3]);
for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\\r?\\n/)) {
  if (!line || (!line.includes('stopped') && !line.includes('post'))) continue;
  let keep = true;
  try {
    const x = JSON.parse(line);
    const at = Date.parse(x.at ?? x.timestamp ?? x.created_at ?? x.time ?? '');
    if (Number.isFinite(at)) keep = at >= since;
  } catch {}
  if (keep) console.log(line);
}
NODE
  else echo "なし: $channel"; fi
  echo
  echo '## deploy.json（対象期間の変更のみ）'
  found=0
  for root in "$HOME/repos" "$HOME/.cache/herdr-personal-skills/wt"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r -d '' file; do
      if [[ $(stat -c %Y "$file") -ge $(date -d "$since" +%s) ]]; then
        printf '\n### %s\n' "$file"; cat "$file"; found=1
      fi
    done < <(find "$root" -path '*/handoff/deploys/*/deploy.json' -type f -print0 2>/dev/null)
  done
  ((found)) || echo '対象期間の deploy.json はなし'
  echo
  echo '## 前回までの振り返りメモ'
  for file in "$DATA"/*.md; do [[ -f "$file" ]] && { printf '\n### %s\n' "$file"; cat "$file"; }; done
  echo
  echo '## 開いている見張り役 Issue'
  "$TASK" issue list --by 見張り役 --open
} > "$input"

raw="$work/result.json"
# Keep user HOME/auth configuration untouched. The tool allowlist permits only read operations and issue creation.
allowed=(Read Grep Glob "Bash($TASK report *)" "Bash($TASK trace *)" "Bash($TASK issue list *)" "Bash($TASK issue add *)" 'Bash(sqlite3 -readonly *)' 'Bash(cat *)' 'Bash(ls *)')
cat "$HERE/retro-prompt.md" "$input" | claude -p --model opus --output-format json --add-dir "$DATA" --allowedTools "${allowed[@]}" > "$raw"

session=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.session_id??""))' "$raw")
cost=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.total_cost_usd??"不明"))' "$raw")
response=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const r=x.result; process.stdout.write(typeof r==="string"?r:JSON.stringify(r??x))' "$raw")
{
  echo "# 振り返り $day"
  echo "期間: $since から $stamp"
  echo "session_id: $session"
  echo "total_cost_usd: $cost"
  echo
  echo "$response"
} > "$DATA/$day.md"
printf '%s\n' "$stamp" > "$LAST.tmp"
mv "$LAST.tmp" "$LAST"
cat "$DATA/$day.md"
