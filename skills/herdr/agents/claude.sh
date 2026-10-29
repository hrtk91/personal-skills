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
prompt=$1 raw=$2 session_file=$3 state=$4 report=$5 model=$6 effort=$7 log_file=$8 agent=$9 timeout=${10}
started=$SECONDS; claude_pid=; interrupted=0; terminal_reason=none
record() { printf '%s %s: 自分で終わった=%s 終了コード=%s かかった秒数=%s terminal_reason=%s\n' "$(date +%F' '%T)" "$agent" "$1" "$2" "$((SECONDS-started))" "$terminal_reason" >> "$log_file"; }
on_int() { interrupted=1; [ -z "$claude_pid" ] || { kill -INT "$claude_pid" 2>/dev/null || true; command sleep 1; kill -KILL "$claude_pid" 2>/dev/null || true; }; }
trap on_int INT
CLAUDE_FORMAT='
import json, sys
session_file = sys.argv[1]
for line in sys.stdin:
 try: x=json.loads(line)
 except Exception: continue
 t=x.get("type",""); p=x.get("message",x)
 if t=="system" and x.get("subtype")=="init":
  sid=str(x.get("session_id","")); open(session_file,"w").write(sid+"\\n"); print("session_id: "+sid,flush=True)
 if t=="system" and x.get("subtype")=="permission_denied":
  print("囲いで止められた: permission_denied event "+" ".join(str(x.get("message","" )).split())[:400],flush=True)
 if t=="assistant":
  for c in p.get("content",[]) if isinstance(p,dict) else []:
   if c.get("type")=="tool_use": print("tool: "+str(c.get("name","tool"))+" "+str(c.get("input",{}))[:180],flush=True)
   elif c.get("type")=="text": print("Claude: "+" ".join(c.get("text","").split())[:240],flush=True)
 if t=="user":
  for c in p.get("content",[]) if isinstance(p,dict) else []:
   if c.get("type")!="tool_result":
    continue
   text=str(c.get("content",c.get("text","")))
   # A Bash command that ends with its own echo is not an error, and the OS message follows the locale (10/29 live run).
   terms=("bwrap", "bubblewrap", "operation not permitted", "read-only file system")
   os_terms=("operation not permitted", "read-only file system", "読み込み専用ファイルシステム", "許可されていない操作")
   if (c.get("is_error") and any(term in text.lower() for term in terms)) or any(term in text.lower() for term in os_terms):
    print("囲いで止められた: tool_result "+" ".join(text.split())[:400],flush=True)
 if t=="result": print("result: "+" ".join(str(x.get("result"," ")).split())[:500],flush=True)
'
session=
: >> "$raw"
for attempt in 1 2; do
  raw_start=$(wc -c < "$raw")
  if [ "${CLAUDE_SANDBOX:-1}" = 0 ]; then
    settings='{"disableAllHooks":true}'
    permission_mode=bypassPermissions
  else
    settings='{"disableAllHooks":true,"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false},"permissions":{"defaultMode":"acceptEdits","allow":["Bash(*)"]}}'
    permission_mode=acceptEdits
  fi
  args=(-p --model "$model" --effort "$effort" --permission-mode "$permission_mode" --output-format stream-json --verbose --settings "$settings" --strict-mcp-config)
  [ -z "$session" ] || args+=(--resume "$session")
  # File capture prevents stdout-inheriting descendants from blocking formatting; tail streams live.
  claude "${args[@]}" < "$prompt" >> "$raw" 2>&1 & claude_pid=$!
  tail -n +1 -F --pid="$claude_pid" "$raw" 2>/dev/null | python3 -u -c "$CLAUDE_FORMAT" "$session_file" & follower=$!
  while kill -0 "$claude_pid" 2>/dev/null; do
    if [ "$((SECONDS-started))" -ge "$timeout" ]; then interrupted=1; kill -INT "$claude_pid" 2>/dev/null || true; command sleep 1; kill -KILL "$claude_pid" 2>/dev/null || true; break; fi
    command sleep 0.2
  done
  set +e; wait "$claude_pid"; rc=$?; set -e
  [ "$interrupted" = 0 ] && ended=yes || ended=no
  for _ in 1 2 3 4 5 6 7 8; do kill -0 "$follower" 2>/dev/null || break; sleep 0.25; done
  kill "$follower" 2>/dev/null || true
  if tail -c +"$((raw_start + 1))" "$raw" | python3 -c '
import json,sys
terms=("bwrap", "bubblewrap", "operation not permitted", "read-only file system")
os_terms=("operation not permitted", "read-only file system", "読み込み専用ファイルシステム", "許可されていない操作")
for line in sys.stdin:
 try: event=json.loads(line)
 except Exception: continue
 if event.get("type")=="system" and event.get("subtype")=="permission_denied":
  print("yes"); break
 if event.get("type")=="user":
  message=event.get("message",{})
  for block in message.get("content",[]) if isinstance(message,dict) else []:
   text=str(block.get("content",block.get("text","")))
   if block.get("type")=="tool_result" and ((block.get("is_error") and any(term in text.lower() for term in terms)) or any(term in text.lower() for term in os_terms)):
    print("yes"); raise SystemExit
' | grep -q yes; then
    message="囲いで止められた: Claude の tool_result または permission_denied event を記録しました。詳細=$raw"
    printf '%s %s\n' "$(date +%F' '%T)" "$message" >> "$log_file"
    printf '%s\n' "$message"
  fi
  session=$(python3 - "$raw" <<'PY'
import json,sys
sid=''; reason='none'
for line in open(sys.argv[1], errors='replace'):
 try: x=json.loads(line)
 except Exception: continue
 if x.get('type')=='system' and x.get('subtype')=='init': sid=x.get('session_id','')
 if x.get('type')=='result': reason=str(x.get('subtype') or x.get('stop_reason') or 'unknown')
open(sys.argv[1]+'.reason','w').write(reason)
print(sid)
PY
)
  terminal_reason=$(cat "$raw.reason" 2>/dev/null || echo none); printf '%s\n' "$session" > "$session_file"
  record "$ended" "$rc"
  if [ "$interrupted" = 0 ] && [ "$rc" = 0 ] && [ "$terminal_reason" = success ] && [ -f "$report" ]; then echo implemented > "$state"; exit 0; fi
  [ "$interrupted" = 0 ] && [ "$attempt" = 1 ] && [ -n "$session" ] || break
  echo "report missing or nonzero exit; resuming session $session" >&2
done
echo failed > "$state"; exit 1
CLAUDE_HELPER
  chmod +x "$helper"
  local model=${CLAUDE_MODEL:-opus} effort=${CLAUDE_EFFORT:-high} timeout=${CLAUDE_TIMEOUT_SECONDS:-1800}
  cmd=$(printf 'bash %q %q %q %q %q %q %q %q %q %q %q' "$helper" "$prompt" "$raw" "$session" "$state" "$W/$REPORT" "$model" "$effort" "$L" "$agent" "$timeout")
  herdr pane send-text "$4" "$cmd" >/dev/null || return 1
  herdr pane send-keys "$4" Enter >/dev/null || return 1
  local i ticks=$(( (timeout + 1) / 2 ))
  for i in $(seq 1 "$ticks"); do [ -f "$state" ] && break; sleep 2; done
  if [ ! -f "$state" ]; then
    log "$agent: Claude -p が ${timeout} 秒以内に終了しなかった。実装ペインを中断する"
    herdr pane send-keys "$4" ctrl+c >/dev/null 2>&1 || true
    for i in $(seq 1 10); do [ -f "$state" ] && break; sleep 1; done
    [ -f "$state" ] || { echo failed > "$state"; log "$agent: 自分で終わった=no 終了コード=unknown かかった秒数>=${timeout} terminal_reason=$(cat "$raw.reason" 2>/dev/null || echo none)"; }
  fi
  [ "$(cat "$state")" = implemented ] || return 1
  [ -f "$mark" ] || [ -f "$W/$REPORT" ]
}
