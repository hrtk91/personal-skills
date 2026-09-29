# Codex 用の部品。herdr-run.sh から source される（単独では動かさない）。
# 既定は gpt-6-luna・priority（fast）・念入りさ max。実装（impl-*）は CODEX_MODEL・CODEX_TIER・CODEX_EFFORT、
# レビュー（rev-*）は CODEX_REV_MODEL・CODEX_REV_TIER・CODEX_REV_EFFORT で変える（無ければ実装と同じ）。旧名の MODEL・TIER・EFFORT も読む。
# gpt-6-astra は設計だけに使う型なので、この台本（実装・レビュー）では起動を断る。設計は台本の外で動かす（SKILL.md）。

codex_setting() {  # <IMPL|REV> <MODEL|TIER|EFFORT> <既定>
  local role=$1 key=$2 default=$3 value=
  [ "$role" = REV ] && eval "value=\${CODEX_REV_$key:-}"
  [ -n "$value" ] || eval "value=\${CODEX_$key:-\${$key:-$default}}"
  echo "$value"
}

codex_start() {  # <agent> <pane> <作業場所>
  local agent=$1 pane=$2 w=$3 role=IMPL
  case $agent in rev-*) role=REV ;; esac
  local model tier effort
  model=$(codex_setting $role MODEL gpt-6-luna); tier=$(codex_setting $role TIER priority); effort=$(codex_setting $role EFFORT max)
  case $model in *astra*) log "$agent: $model は設計だけに使う。実装・レビューには luna を使う（CODEX_MODEL・CODEX_REV_MODEL を確かめる）"; return 1 ;; esac
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
