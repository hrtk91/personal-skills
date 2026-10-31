# Claude Code -p 用の部品。herdr-run.sh から source される。
# Claude の stream-json 全文は claude-<名>.jsonl、ペインには短いイベント要約を出す。
claude_start() { :; } # Claude -p は専用 pane shell command から起こす。

claude_send() { # <agent> <text> <報告印のパス> <pane>
  local agent=$1 text=$2 mark=$3 short=${1#impl-} prompt="$WORK/claude-$name.md" full="$WORK/claude-$name.full.md" raw="$WORK/claude-$name.jsonl" session="$WORK/claude-$name.session" state="$WORK/claude-$name.status" helper="$WORK/claude-$name-run.sh" cmd
  if [[ "$agent" == impl-* ]]; then
    text="$text 報告の先頭近くに必ず機械可読な 1 行「終わりの条件: 満たした」または「終わりの条件: 満たしていない — <満たしていない条件を依頼文の書き方で、；で区切る>」を書く。決められない理由がある場合は「終わりの条件: 満たしていない — 決められない: <理由>」とする。終わりの条件の確かめは、使う人が実際に通る入口（依頼文に書かれたスクリプト・コマンド・起動の台本）で流し、そのコマンドと出力の要所を貼る。手で組んだ代わりの命令で流したもの、手で作った成果物は「代わりの道」と書き、満たしたとは書かない。GPU・起動・書き込みの許可・ダウンロード・外のサービスなど、あなたの手で直せない理由で終われないときは、1 行目を「終わりの条件: 満たしていない（環境） — 何が」と書く。依頼文の中身で直せること（コードの直し・検査の直し）には付けない。"
  fi
  if [ "${SEND_BACK:-}" = 1 ] && [ -f "$session" ] && [ -f "$full" ]; then
    # 前の会話を --resume で続けるときは、前回の依頼から増えた行（差し戻しの文など）だけを渡す。
    # 依頼の本文は 1 行の長い文なので、diff -u の前後の行を付けると全文を送り直すことになる（10/30）。
    local added
    printf '%s\n' "$text" > "$full.new"
    added=$(diff --old-line-format= --unchanged-line-format= --new-line-format='%L' "$full" "$full.new") || true
    [ -n "$added" ] || added='（依頼の文は前回と同じ）'
    printf '前の作業はレビューで差し戻された。前回の依頼から変わった所は次のとおり。これに従って直し、報告 %s を全体の内容で書き直す（前回の報告は消してある。終わりの条件の 1 行も書く）。\n\n%s\n' "$REPORT" "$added" > "$prompt"
    mv "$full.new" "$full"
  else
    printf '%s\n' "$text" > "$full"
    cp "$full" "$prompt"
  fi
  rm -f "$raw" "$state" "$W/$REPORT"
  [ "${SEND_BACK:-}" = 1 ] || rm -f "$session"
  cat > "$helper" <<'CLAUDE_HELPER'
#!/bin/bash
set -uo pipefail
prompt=$1 full=$2 raw=$3 session_file=$4 state=$5 report=$6 model=$7 effort=$8 log_file=$9 agent=${10} timeout=${11}
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
[ "${SEND_BACK:-}" = 1 ] && [ -f "$session_file" ] && session=$(cat "$session_file")
resuming=0; [ -n "$session" ] && resuming=1
: >> "$raw"
# The sandbox lets the worker write only inside its worktree, so /tmp is read-only there and tests that make temp
# dirs fail with EROFS (10/31, two tasks). Point TMPDIR at a folder in the worktree that git ignores locally.
worktree=$(git -C "$(dirname "$report")" rev-parse --show-toplevel 2>/dev/null) && {
  export TMPDIR="$worktree/.worker-tmp"; mkdir -p "$TMPDIR"
  exclude=$(git -C "$worktree" rev-parse --git-path info/exclude)
  grep -qx '.worker-tmp/' "$exclude" 2>/dev/null || printf '.worker-tmp/\n' >> "$exclude"
}
for attempt in 1 2; do
  raw_start=$(wc -c < "$raw")
  if [ "${CLAUDE_SANDBOX:-1}" = 0 ]; then
    settings='{"disableAllHooks":true}'
    permission_mode=bypassPermissions
  else
    settings='{"disableAllHooks":true,"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"network":{"allowAllUnixSockets":true,"allowLocalBinding":true}},"permissions":{"defaultMode":"acceptEdits","allow":["Bash(*)"]}}'
    permission_mode=acceptEdits
  fi
  args=(-p --model "$model" --effort "$effort" --permission-mode "$permission_mode" --output-format stream-json --verbose --settings "$settings" --strict-mcp-config)
  call_prompt=$prompt
  attempt_resuming=$resuming
  attempt_session=$session
  if [ "$resuming" = 1 ]; then args+=(--resume "$session"); else call_prompt=$full; fi
  # File capture prevents stdout-inheriting descendants from blocking formatting; tail streams live.
  claude "${args[@]}" < "$call_prompt" >> "$raw" 2>&1 & claude_pid=$!
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
  [ -n "$session" ] || session=$attempt_session
  terminal_reason=$(cat "$raw.reason" 2>/dev/null || echo none); printf '%s\n' "$session" > "$session_file"
  record "$ended" "$rc"
  if [ "$interrupted" = 0 ] && [ "$rc" = 0 ] && [ "$terminal_reason" = success ] && [ -f "$report" ]; then echo implemented > "$state"; exit 0; fi
  [ "$interrupted" = 0 ] && [ "$attempt" = 1 ] && [ -n "$session" ] || break
  if [ "$attempt_resuming" = 1 ]; then
    echo "resume failed; retrying once with a new session and full prompt" >&2
    session=; resuming=0
  else
    echo "report missing or nonzero exit; retrying session $session" >&2
    resuming=1
  fi
done
echo failed > "$state"; exit 1
CLAUDE_HELPER
  chmod +x "$helper"
  local model=${CLAUDE_MODEL:-opus} effort=${CLAUDE_EFFORT:-high} timeout=${CLAUDE_TIMEOUT_SECONDS:-1800}
  cmd=$(printf 'SEND_BACK=%q bash %q %q %q %q %q %q %q %q %q %q %q %q' "${SEND_BACK:-}" "$helper" "$prompt" "$full" "$raw" "$session" "$state" "$W/$REPORT" "$model" "$effort" "$L" "$agent" "$timeout")
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
