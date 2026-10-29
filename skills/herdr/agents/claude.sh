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
  set +e
  claude "${args[@]}" < "$prompt" | tee -a "$raw" | python3 -c 'import json,sys
for line in sys.stdin:
 try: x=json.loads(line)
 except Exception: continue
 t=x.get("type",""); p=x.get("message",x)
 if t=="system" and x.get("subtype")=="init":
  sid=str(x.get("session_id","")); open(sys.argv[1],"w").write(sid+"\n"); print("session_id: "+sid,flush=True)
 if t=="assistant":
  for c in p.get("content",[]) if isinstance(p,dict) else []:
   if c.get("type")=="tool_use": print("tool: "+str(c.get("name","tool"))+" "+str(c.get("input",{}))[:180],flush=True)
   elif c.get("type")=="text": print("Claude: "+" ".join(c.get("text","").split())[:240],flush=True)
 if t=="result": print("result: "+" ".join(str(x.get("result"," ")).split())[:500],flush=True)' "$session_file"
  rc=${PIPESTATUS[0]}
  set -e
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
  if [ "$rc" = 0 ] && [ -f "$report" ]; then echo implemented > "$state"; exit 0; fi
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
    echo failed > "$state"
  fi
  [ "$(cat "$state")" = implemented ] || return 1
  [ -f "$mark" ] || [ -f "$W/$REPORT" ]
}
