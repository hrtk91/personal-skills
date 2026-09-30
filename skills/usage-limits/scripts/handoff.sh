#!/usr/bin/env bash
# herdr 用の監督交代例。プロジェクト設定を明示し、承認済みの場合だけ実行する。
# --dry-run は起動・送信・ファイル作成を行わない。
set -euo pipefail
mode=${1:-}
case "$mode" in
  --help|-h)
    echo '使い方: REPO=... HERDR_WORKSPACE_ID=... LIMITS_SUPERVISOR_NAME=... HANDOFF_FILE=... handoff.sh [--dry-run]'
    exit 0 ;;
  ''|--dry-run) ;;
  *) echo "未知の引数: $mode" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo '引数が多すぎます' >&2; exit 2; }
: "${REPO:?プロジェクトの場所を REPO に指定してください}"
: "${HERDR_WORKSPACE_ID:?herdr の workspace を指定してください}"
: "${LIMITS_SUPERVISOR_NAME:?プロジェクト固有の担当名を指定してください}"
REPO=$(cd -- "$REPO" && pwd -P)
HANDOFF_FILE=${HANDOFF_FILE:-handoff/supervisor-codex.md}
case "$HANDOFF_FILE" in /*) ;; *) HANDOFF_FILE="$REPO/$HANDOFF_FILE" ;; esac
[ -f "$HANDOFF_FILE" ] || { echo "引継ぎ書がありません: $HANDOFF_FILE" >&2; exit 2; }
if python3 - "$HANDOFF_FILE" <<'CHECK'
import re, sys
from pathlib import Path
sys.exit(0 if re.search(r"\{\{[A-Z_]+\}\}", Path(sys.argv[1]).read_text()) else 1)
CHECK
then
  echo '引継ぎ書の {{項目}} を埋めてから実行してください' >&2
  exit 2
fi
NAME=$LIMITS_SUPERVISOR_NAME
MODEL=${LIMITS_SUPERVISOR_MODEL:-gpt-6.1-sol}
EFFORT=${LIMITS_SUPERVISOR_EFFORT:-max}
TIER=${LIMITS_SUPERVISOR_TIER:-priority}
SANDBOX=${LIMITS_SUPERVISOR_SANDBOX:-danger-full-access}
APPROVAL=${LIMITS_SUPERVISOR_APPROVAL:-never}
READY_SECONDS=${LIMITS_HANDOFF_READY_SECONDS:-60}
CONFIRM_SECONDS=${LIMITS_HANDOFF_CONFIRM_SECONDS:-60}
SETTLE_SECONDS=${LIMITS_HANDOFF_SETTLE_SECONDS:-2}
for value in "$READY_SECONDS" "$CONFIRM_SECONDS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo '待機秒数は正の整数にしてください' >&2; exit 2; }
done
[[ "$SETTLE_SECONDS" =~ ^[0-9]+$ ]] || { echo '安定待ちの秒数は0以上の整数にしてください' >&2; exit 2; }
CODEX_SESSIONS=${LIMITS_CODEX_SESSIONS:-${CODEX_HOME:-$HOME/.codex}/sessions}
project_setting=$(python3 - "$REPO" <<'SETTING'
import json, sys
print('projects.' + json.dumps(sys.argv[1], ensure_ascii=False) + '.trust_level="trusted"')
SETTING
)
codex_args=(-m "$MODEL" -c "service_tier=\"$TIER\"" -c "model_reasoning_effort=$EFFORT"
  -s "$SANDBOX" -a "$APPROVAL" -c "$project_setting" -C "$REPO")
if [ "$mode" = --dry-run ]; then
  printf 'herdr tab create --workspace %q --label %q --cwd %q\n' "$HERDR_WORKSPACE_ID" "$NAME" "$REPO"
  printf 'herdr agent start %q --kind codex --pane <created-pane> --timeout 120000 --' "$NAME"
  printf ' %q' "${codex_args[@]}"
  printf '\n送る目標: 引継ぎID付きで %s を読み、記載した止まる条件まで監督を続ける\n' "$HANDOFF_FILE"
  exit 0
fi
command -v herdr >/dev/null || { echo 'herdr がありません。この台本は herdr 用です' >&2; exit 2; }
if herdr agent get "$NAME" >/dev/null 2>&1; then
  echo "同名の担当が存在するため未送信: $NAME。状態と引継ぎの受信を確認してください" >&2
  exit 3
fi
tab=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label "$NAME" --cwd "$REPO")
pane=$(python3 -c 'import json,sys; pane=json.load(sys.stdin)["result"]["root_pane"]["pane_id"]; assert isinstance(pane,str) and pane; print(pane)' <<< "$tab")
herdr agent start "$NAME" --kind codex --pane "$pane" --timeout 120000 -- "${codex_args[@]}" >/dev/null
ready=0
for ((k=0; k<READY_SECONDS; k++)); do
  if herdr agent read "$NAME" --source visible 2>/dev/null | python3 -c 'import sys; sys.exit(0 if "Ask Codex" in sys.stdin.read() else 1)'; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "入力欄を確認できません。担当 $NAME を確認してください（自動停止しません）" >&2; exit 1; }
sleep "$SETTLE_SECONDS"
mark=$(mktemp "${TMPDIR:-/tmp}/usage-limits-handoff.XXXXXX")
trap 'rm -f -- "$mark"' EXIT
nonce=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
quoted_file=$(python3 - "$HANDOFF_FILE" <<'QUOTE'
import json, sys
print(json.dumps(sys.argv[1], ensure_ascii=False))
QUOTE
)
prompt="/goal 【引継ぎID:$nonce】 $quoted_file を読み、その指示どおりに Claude の代わりに監督を続ける。記載した『止まる条件』に当たるまで続ける。"
received() {
  python3 - "$CODEX_SESSIONS" "$mark" "$nonce" "$HANDOFF_FILE" <<'RECEIPT'
import json, sys
from pathlib import Path
root, marker, nonce, handoff = sys.argv[1:]
cutoff = Path(marker).stat().st_mtime
for path in Path(root).rglob('*.jsonl'):
    try:
        if path.stat().st_mtime < cutoff:
            continue
        with path.open(encoding='utf-8', errors='replace') as stream:
            for line in stream:
                if 'thread_goal_updated' not in line or nonce not in line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                payload = event.get('payload')
                if not isinstance(payload, dict):
                    continue
                if payload.get('type') != 'thread_goal_updated':
                    continue
                if event.get('type') != 'event_msg':
                    continue
                goal = payload.get('goal')
                if not isinstance(goal, dict) or not isinstance(goal.get('objective'), str):
                    continue
                objective = goal['objective']
                if nonce in objective and json.dumps(handoff, ensure_ascii=False) in objective:
                    sys.exit(0)
    except OSError:
        continue
sys.exit(1)
RECEIPT
}
for attempt in 1 2 3; do
  herdr agent prompt "$NAME" "$prompt" >/dev/null
  for ((k=0; k<CONFIRM_SECONDS; k++)); do
    if received; then
      echo "監督を Codex に交代した（担当 $NAME、引継ぎID $nonce を受信確認）"
      exit 0
    fi
    sleep 1
  done
  [ "$attempt" = 3 ] || echo "目標の受信を確認できない（$attempt 回目）→ 同じIDで送り直す" >&2
done
echo "交代の受信を確認できません。担当 $NAME を確認してください（自動停止・再起動しません）" >&2
exit 1
