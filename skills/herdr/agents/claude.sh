# Claude Code -p 用の部品。herdr-run.sh から source される。
# Claude の stream-json 全文は claude-<名>.jsonl、ペインには短いイベント要約を出す。
claude_start() { :; } # Claude -p は専用 pane shell command から起こす。

claude_send() { # <agent> <text> <報告印のパス> <pane>
  local agent=$1 text=$2 mark=$3 short=${1#impl-} prompt="$WORK/claude-$name.md" raw="$WORK/claude-$name.jsonl" session="$WORK/claude-$name.session" state="$WORK/claude-$name.status" helper="$WORK/claude-$name-run.sh" cmd
  printf '%s\n' "$text" > "$prompt"
  rm -f "$raw" "$session" "$state" "$W/$REPORT"
  cat > "$helper" <<'CLAUDE_HELPER'
#!/bin/bash
set -uo pipefail
prompt=$1 raw=$2 session_file=$3 state=$4 report=$5 model=$6 effort=$7
session=
for attempt in 1 2; do
  args=(-p --model "$model" --effort "$effort" --permission-mode bypassPermissions --output-format stream-json --verbose)
  [ -z "$session" ] || args+=(--resume "$session")
  # File capture avoids EOF hangs when descendants inherit stdout. A successful terminal
  # result plus the requested report is also completion: stop a CLI kept alive by a hook.
  claude "${args[@]}" < "$prompt" >> "$raw" 2>&1 &
  claude_pid=$!
  trap 'kill "$claude_pid" 2>/dev/null || true' INT
  result_ok=0
  while kill -0 "$claude_pid" 2>/dev/null; do
    if [ -f "$report" ] && python3 - "$raw" <<'PYRESULT'
import json, sys
for line in open(sys.argv[1], errors='replace'):
 try: row=json.loads(line)
 except Exception: continue
 if row.get('type') == 'result' and not row.get('is_error', False) and row.get('subtype') in (None, 'success'):
  sys.exit(0)
sys.exit(1)
PYRESULT
    then
      result_ok=1
      kill "$claude_pid" 2>/dev/null || true
      break
    fi
    sleep 0.25
  done
  set +e
  wait "$claude_pid"
  rc=$?
  set -e
  trap - INT
  python3 - "$raw" "$session_file" <<'PYFORMAT'
import json, sys
raw, session_file = sys.argv[1:]
for line in open(raw, errors='replace'):
 try: x=json.loads(line)
 except Exception: continue
 t=x.get('type',''); p=x.get('message',x)
 if t=='system' and x.get('subtype')=='init':
  sid=str(x.get('session_id','')); open(session_file,'w').write(sid+'\n'); print('session_id: '+sid,flush=True)
 if t=='assistant':
  for c in p.get('content',[]) if isinstance(p,dict) else []:
   if c.get('type')=='tool_use': print('tool: '+str(c.get('name','tool'))+' '+str(c.get('input',{}))[:180],flush=True)
   elif c.get('type')=='text': print('Claude: '+' '.join(c.get('text','').split())[:240],flush=True)
 if t=='result': print('result: '+' '.join(str(x.get('result',' ')).split())[:500],flush=True)
PYFORMAT
  session=$(python3 - "$raw" <<'PY'
import json,sys
s=''
for line in open(sys.argv[1]):
 try:
  x=json.loads(line)
  if x.get('type')=='system' and x.get('subtype')=='init': s=x.get('session_id','')
 except Exception: pass
print(s)
PY
)
  printf '%s\n' "$session" > "$session_file"
  if [ -f "$report" ] && python3 - "$raw" <<'PYRESULT'
import json, sys
for line in open(sys.argv[1], errors='replace'):
 try: row=json.loads(line)
 except Exception: continue
 if row.get('type') == 'result' and not row.get('is_error', False) and row.get('subtype') in (None, 'success'):
  sys.exit(0)
sys.exit(1)
PYRESULT
  then result_ok=1; fi
  if { [ "$rc" = 0 ] || [ "$result_ok" = 1 ]; } && [ -f "$report" ]; then echo implemented > "$state"; exit 0; fi
  [ "$attempt" = 1 ] && [ -n "$session" ] || break
  echo "report missing or nonzero exit; resuming session $session" >&2
 done
echo failed > "$state"
exit 1
CLAUDE_HELPER
  chmod +x "$helper"
  local model=${CLAUDE_MODEL:-opus} effort=${CLAUDE_EFFORT:-high}
  cmd=$(printf 'bash %q %q %q %q %q %q %q %q' "$helper" "$prompt" "$raw" "$session" "$state" "$W/$REPORT" "$model" "$effort")
  # The `claude -p` process and its readable stream run in the implementation pane.
  herdr pane send-text "$4" "$cmd" >/dev/null || return 1
  herdr pane send-keys "$4" Enter >/dev/null || return 1
  local i timeout=${CLAUDE_TIMEOUT_SECONDS:-1800} ticks=$(( (${CLAUDE_TIMEOUT_SECONDS:-1800} + 1) / 2 ))
  for i in $(seq 1 "$ticks"); do
    [ -f "$state" ] && break
    sleep 2
  done
  if [ ! -f "$state" ]; then
    log "$agent: Claude -p が ${timeout} 秒以内に終了しなかった。実装ペインを中断する"
    herdr pane send-keys "$4" ctrl+c >/dev/null 2>&1 || true
    # Give the helper a moment to read a terminal result emitted during interruption.
    for i in $(seq 1 10); do [ -f "$state" ] && break; sleep 1; done
    [ -f "$state" ] || echo failed > "$state"
  fi
  [ "$(cat "$state")" = implemented ] || return 1
  [ -f "$mark" ] || [ -f "$W/$REPORT" ]
}
