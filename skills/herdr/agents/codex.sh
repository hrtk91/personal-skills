# Codex 用の部品。herdr-run.sh から source される（単独では動かさない）。
# 既定は gpt-6.1-sol・default（fast なし）・念入りさ max。実装（impl-*）は CODEX_MODEL・CODEX_TIER・CODEX_EFFORT、
# レビュー（rev-*）は CODEX_REV_MODEL・CODEX_REV_TIER・CODEX_REV_EFFORT で変える（無ければ実装と同じ）。旧名の MODEL・TIER・EFFORT も読む。
# 設計の下見も同じ既定を使う。gpt-6-astra なども明示指定なら使える。

codex_setting() {  # <IMPL|REV> <MODEL|TIER|EFFORT> <既定>
  local role=$1 key=$2 default=$3 value= setting
  if [ "$role" = REV ]; then setting=CODEX_REV_$key; value=${!setting:-}; fi
  if [ -z "$value" ]; then setting=CODEX_$key; value=${!setting:-}; fi
  [ -n "$value" ] || value=${!key:-$default}
  printf '%s\n' "$value"
}

codex_start() {  # <agent> <pane> <作業場所>
  local agent=$1 pane=$2 w=$3 role=IMPL
  case $agent in rev-*) role=REV ;; esac
  local model tier effort trust_root
  model=$(codex_setting "$role" MODEL gpt-6.1-sol); tier=$(codex_setting "$role" TIER default); effort=$(codex_setting "$role" EFFORT max)
  log "$agent: Codex 設定 model=$model service_tier=$tier effort=$effort"
  # CLI は worktree でも元の Git リポジトリのルートに信頼指定を求める
  trust_root=$(git -C "$w" rev-parse --path-format=absolute --git-common-dir) || return 1
  if [ "$(basename "$trust_root")" = .git ]; then trust_root=$(dirname "$trust_root"); else trust_root=$w; fi
  # -s danger-full-access: workspace-write は Codex CLI 0.157.1 で 9/26 から全コマンド失敗する。書いてよい場所は依頼文で絞る
  herdr agent start "$agent" --kind codex --pane "$pane" --timeout 120000 -- \
    -m "$model" -c "service_tier=\"$tier\"" -c "model_reasoning_effort=$effort" \
    -s danger-full-access -a never -c "projects.\"$w\".trust_level=\"trusted\"" \
    -c "projects.\"$trust_root\".trust_level=\"trusted\"" -C "$w" >/dev/null || return 1
  # herdr の入力準備状態を確認する。入力欄の例文は CLI の版で変わる
  local k ready=0
  for k in $(seq 60); do
    if herdr agent get "$agent" 2>/dev/null | js result.agent.interactive_ready 2>/dev/null | grep -qx True; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = 1 ] || { log "$agent: 入力欄を確認できなかった"; return 1; }
  sleep 2
}

codex_goal_received() {  # <送信時刻のファイル> <印のパス>
  python3 - "${CODEX_HOME:-$HOME/.codex}/sessions" "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

root, sent, mark = sys.argv[1:]
since = Path(sent).stat().st_mtime_ns
for path in Path(root).rglob('*.jsonl'):
    try:
        if path.stat().st_mtime_ns <= since:
            continue
        with path.open() as stream:
            for line in stream:
                if 'thread_goal_updated' not in line or mark not in line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue  # 書き込み途中の行は次の確認で読む
                payload = record.get('payload', {})
                if payload.get('type') == 'thread_goal_updated' and mark in json.dumps(payload, ensure_ascii=False):
                    sys.exit(0)
    except OSError:
        continue
sys.exit(1)
PY
}

# 依頼は /goal（目標を果たすまで走るモード）で渡し、Codex のセッション記録に目標が載ったかで確かめる。
# herdr の working だけだと、目標が落ちても working に見えることがあった。落ちたら 3 回まで送り直す
codex_send() {  # <agent> <text> <印のパス>
  local agent=$1 text=$2 mark=$3 j k
  for j in 1 2 3; do
    touch "$WORK/.sent-$agent"
    herdr agent prompt "$agent" "/goal $text" >> "$L" 2>&1 || return 1
    echo >> "$L"
    for k in $(seq 45); do
      codex_goal_received "$WORK/.sent-$agent" "$mark" && { log "$agent: 目標の記録を確認した"; return 0; }
      sleep 2
    done
    log "$agent: 目標が Codex に届いていない（$j 回目）→ 送り直す"; sleep 3
  done
  return 1
}
