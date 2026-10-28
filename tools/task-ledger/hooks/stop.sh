#!/bin/bash
# Stop hook: a task in this repository still without a brief sends Claude back once to write it; the second stop passes.
input=$(cat)
read -r cwd active < <(printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd","."), d.get("stop_hook_active", False))' 2>/dev/null)
[ "$active" = True ] && exit 0
task=$(dirname "$0")/../bin/task
missing=$("$task" list --repo "${cwd:-.}" --status 依頼文待ち 2>/dev/null)
[ -n "$missing" ] || exit 0
reason="台帳に依頼文の無い仕事が残っています。依頼文を書いて task brief <id> <パス> で付けるか、やめるなら task drop。$(printf '%s' "$missing" | cut -f1,3 | tr '\n' ' ')"
python3 -c 'import json,sys; print(json.dumps({"decision":"block","reason":sys.argv[1]}, ensure_ascii=False))' "$reason"
