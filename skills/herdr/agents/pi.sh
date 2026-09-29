# pi 用の部品。herdr-run.sh から source される（単独では動かさない）。
# 既定は openai-codex/gpt-6-luna（外部送信あり）。ローカルなら PI_PROVIDER=llamacpp-igpu PI_MODEL=<モデル>（llama-server を先に起動しておく）。
# pi は ~/.pi/agent/SYSTEM.md の「変更の前に提案して同意を取る」で止まるので、自動実行用の agents/pi-system.md を
# --system-prompt に渡して外す（ユーザーの SYSTEM.md は変えない。2026-09-29 に確かめた）。
# --system-prompt にはファイルのパスを渡す（改行を含む文字列は herdr が拒否する）。
# 送る文は 1 行の通常のプロンプト（pi に /goal はない）。終わりは印で判定する。

pi_start() {  # <agent> <pane> <作業場所>（作業場所はペインの cwd で決まる）
  herdr agent start "$1" --kind pi --pane "$2" --timeout 90000 -- \
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
