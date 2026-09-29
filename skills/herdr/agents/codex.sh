# Codex 用の部品。herdr-run.sh から source される（単独では動かさない）。
# 既定は gpt-6-luna・priority（fast）・念入りさ max。設計の重い仕事は CODEX_MODEL=gpt-6-astra CODEX_TIER=default（fast は切る）。
# 旧名の MODEL・TIER・EFFORT も読む。

codex_start() {  # <agent> <pane> <作業場所>
  local agent=$1 pane=$2 w=$3
  local model=${CODEX_MODEL:-${MODEL:-gpt-6-luna}} tier=${CODEX_TIER:-${TIER:-priority}} effort=${CODEX_EFFORT:-${EFFORT:-max}}
  # -s danger-full-access: workspace-write は Codex CLI 0.157.1 で 9/26 から全コマンド失敗する。書いてよい場所は依頼文で絞る
  herdr agent start "$agent" --kind codex --pane "$pane" --timeout 120000 -- \
    -m "$model" -c "service_tier=\"$tier\"" -c "model_reasoning_effort=$effort" \
    -s danger-full-access -a never -c "projects.\"$w\".trust_level=\"trusted\"" -C "$w" >/dev/null || return 1
  # 入力欄が出るまで待つ（立ち上げ直後に送った文は落ちた）
  local k; for k in $(seq 60); do herdr agent read "$agent" --source visible 2>/dev/null | grep -q "Ask Codex" && break; sleep 1; done
  sleep 2
}

# 依頼は /goal（目標を果たすまで走るモード）で渡し、Codex のセッション記録に目標が載ったかで確かめる。
# herdr の working だけだと、目標が落ちても working に見えることがあった。落ちたら 3 回まで送り直す
codex_send() {  # <agent> <text> <印のパス>
  local agent=$1 text=$2 mark=$3 j k
  for j in 1 2 3; do
    touch "$WORK/.sent-$agent"
    herdr agent prompt "$agent" "/goal $text" >> "$L" 2>&1; echo >> "$L"
    for k in $(seq 45); do
      find ~/.codex/sessions -name '*.jsonl' -newer "$WORK/.sent-$agent" -print0 2>/dev/null | xargs -0 -r grep -l "thread_goal_updated" 2>/dev/null | xargs -r grep -l -F "$mark" >/dev/null 2>&1 && return 0
      sleep 2
    done
    log "$agent: 目標が Codex に届いていない（$j 回目）→ 送り直す"; sleep 3
  done
  return 1
}
