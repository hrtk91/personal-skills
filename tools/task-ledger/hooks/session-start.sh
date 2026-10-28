#!/bin/bash
# SessionStart hook: shows the commanding Claude what in this repository waits for it (a brief) or for the user (a decision).
input=$(cat)
cwd=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null)
task=$(dirname "$0")/../bin/task
waiting=$("$task" list --repo "${cwd:-.}" 2>/dev/null | awk -F'\t' '$2=="判断待ち"||$2=="依頼文待ち"')
[ -n "$waiting" ] || exit 0
printf '台帳（task list）で、このリポジトリに止まっている仕事があります。依頼文待ちには依頼文を書いて `task brief`、判断待ちはユーザーに聞くか朝夜のまとめに入れる:\n%s\n' "$waiting"
