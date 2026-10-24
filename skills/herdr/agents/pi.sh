# pi 用の部品。herdr-run.sh から source される（単独では動かさない）。
# 既定は openai-codex/gpt-6-luna（外部送信あり）。ローカルなら PI_PROVIDER=llamacpp-igpu PI_MODEL=<モデル>（llama-server を先に起動しておく）。
# pi は ~/.pi/agent/SYSTEM.md の「変更の前に提案して同意を取る」で止まるので、自動実行用の agents/pi-system.md を
# --system-prompt に渡して外す（ユーザーの SYSTEM.md は変えない。2026-09-29 に確かめた）。
# --system-prompt にはファイルのパスを渡す（改行を含む文字列は herdr が拒否する）。
# 送る文は 1 行の通常のプロンプト（pi に /goal はない）。終わりは印または channel_finish で判定する。

# 担当名と記録先を固定した包みを作る（herdr はペインへ環境変数を渡せない）。
pi_channel_extension() {  # <agent> <作業場所> → 拡張のパス（包みは作業場所の外の $WORK に置く。チャンネル無効なら何も出さない）
  [ "${PI_CHANNEL:-1}" != 0 ] || return 0
  local ext=${PI_CHANNEL_EXT:-$SKILL_DIR/channel/pi/extension.ts}
  [ -f "$ext" ] && [ -f "${CHANNEL_BIN:-$SKILL_DIR/channel/bin/channel}" ] || return 0
  local d=$WORK/pi-channel-$1.ts log=${AGENT_CHANNEL:-$HOME/.cache/agent-channel/channel.jsonl}
  local supervisor=${AGENT_CHANNEL_SUPERVISOR:-}
  ext=$(python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$ext") || return 0
  log=$(python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$log") || return 0
  if [ -z "$supervisor" ]; then supervisor=$("${CHANNEL_BIN:-$SKILL_DIR/channel/bin/channel}" supervisor 2>/dev/null) || supervisor=claude; fi
  [ -n "$supervisor" ] || supervisor=claude
  python3 - "$d" "$ext" "$log" "$1" "$supervisor" <<'PY'
import json, sys
path, ext, log, name, supervisor = sys.argv[1:]
with open(path, "w") as f:
    f.write(f'import {{ createChannelExtension }} from {json.dumps(ext)};\n')
    f.write(f'export default createChannelExtension({{ log: {json.dumps(log)}, name: {json.dumps(name)}, supervisor: {json.dumps(supervisor)} }});\n')
PY
  [ -f "$d" ] && printf '%s' "$d"
}

# PI_SERVICE_TIER（例: priority＝fast）を指定したときだけ、依頼に service_tier を足す拡張を -e で読ませる。
# pi に fast を選ぶ設定は無く（1.1.0 で確認）、herdr はペインへ環境変数を渡せないので、値を書き込んだ拡張をその場で作る。
# 足した記録は <拡張>.log に 1 行ずつ残る（届いたかの確認用）。
pi_tier_extension() {  # <agent> → 拡張のパス（PI_SERVICE_TIER が空なら何も出さない）
  [ -n "${PI_SERVICE_TIER:-}" ] || return 0
  local f="${TMPDIR:-/tmp}/herdr-pi-tier-$1.ts"
  cat > "$f" <<PI_TIER_EXT
import { appendFileSync } from "node:fs";
export default function (pi: any) {
  pi.on("before_provider_request", (event: any) => {
    if (!event?.payload || typeof event.payload !== "object") return undefined;
    try { appendFileSync("$f.log", new Date().toISOString() + " service_tier=$PI_SERVICE_TIER model=" + (event.payload.model ?? "?") + "\\n"); } catch {}
    return { ...event.payload, service_tier: "$PI_SERVICE_TIER" };
  });
}
PI_TIER_EXT
  printf '%s' "$f"
}

# PI_GOAL_EXT（目標を追いかける拡張 goal.ts のパス）を指定したとき、実装役（impl-*）にだけ付ける。
# 拡張は隣の goal.json を読むので、担当ごとの置き場へ写して設定を書く。止まるたびに外の型が完了条件を確かめ、
# 足りなければ同じ会話へ差し戻す。先に作られた終わりの印は拡張が消す。差し戻しの上限は PI_GOAL_MAX_ROUNDS（既定なし）。
pi_goal_extension() {  # <agent> <作業場所> → 拡張のパス（使わないときは何も出さない）
  [ -n "${PI_GOAL_EXT:-}" ] || return 0
  case "$1" in impl-*) ;; *) return 0 ;; esac
  local d="$WORK/pi-goal-$1"
  mkdir -p "$d" && cp "$PI_GOAL_EXT" "$d/goal.ts" || return 0
  printf '{"request":"%s","mark":"%s","log":"%s"%s%s}\n' "$2/$REQ" "$WORK/done-$1" "$d/goal-checks.jsonl" \
    "${PI_GOAL_CHECK_MODEL:+,\"checkModel\":\"$PI_GOAL_CHECK_MODEL\"}" "${PI_GOAL_MAX_ROUNDS:+,\"maxRounds\":$PI_GOAL_MAX_ROUNDS}" > "$d/goal.json"
  printf '%s' "$d/goal.ts"
}

pi_start() {  # <agent> <pane> <作業場所>（作業場所はペインの cwd で決まる）
  local ext goal channel; ext=$(pi_tier_extension "$1"); goal=$(pi_goal_extension "$1" "$3"); channel=$(pi_channel_extension "$1" "$3")
  herdr agent start "$1" --kind pi --pane "$2" --timeout 90000 -- \
    ${ext:+-e "$ext"} ${goal:+-e "$goal"} ${channel:+-e "$channel"} \
    --provider "${PI_PROVIDER:-openai-codex}" --model "${PI_MODEL:-gpt-6-luna}" --thinking "${PI_THINKING:-high}" \
    --no-session --system-prompt "${PI_SYSTEM:-$SKILL_DIR/agents/pi-system.md}" >/dev/null
}

pi_send() {  # <agent> <text> <印のパス>
  local agent=$1 text=$2 j
  for j in 1 2 3; do
    herdr agent prompt "$agent" "$text" >> "$L" 2>&1; echo >> "$L"
    # 受け取られたか: working になれば届いている。ならなければ送り直す
    herdr agent wait "$agent" --until working --timeout 30000 >/dev/null 2>&1 && return 0
    log "$agent: 依頼が pi に届いていない（$j 回目）→ 送り直す"; sleep 3
  done
  return 1
}
