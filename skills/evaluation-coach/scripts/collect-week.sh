#!/bin/bash
# 直近N日の活動を集約して標準出力に出す
# git log（authorフィルタ）、merged PR（ページング対応）、デイリーノート、retlaude reflections を統合

set -uo pipefail
# pipefail だが、head での SIGPIPE 失敗を許容するため set -e は外す
# 各セクションは独立して動かす

DAYS=${1:-7}
AUTHOR="${GIT_AUTHOR_NAME:-$(git config --global user.name 2>/dev/null || echo 'unknown')}"
SINCE=$(date -v-${DAYS}d +%Y-%m-%d 2>/dev/null || date -d "$DAYS days ago" +%Y-%m-%d)

echo "# 直近${DAYS}日の活動集約 (since: $SINCE, author: $AUTHOR)"
echo ""

# === Git ログ（プロジェクトリポジトリ） ===
REPO="${EVAL_COACH_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || echo '')}"
if [ -n "$REPO" ] && [ -d "$REPO/.git" ]; then
  echo "## Git commits ($REPO)"
  echo ""
  echo '```'
  git -C "$REPO" log --since="$SINCE" --author="$AUTHOR" \
    --pretty=format:'%h %ad %s' --date=short --no-merges 2>/dev/null | head -150
  echo ""
  echo '```'
  echo ""

  # === Merged PRs（ページング対応） ===
  if command -v gh >/dev/null 2>&1; then
    echo "## Merged PRs (gh, 自分author)"
    echo '```'
    # gh pr list は --search で merged:>=DATE を渡し、--limit を大きく取る
    # gh はデフォルト最大1000件、--limit指定で取得可能
    # repo dir 内で gh pr list を叩く（-R フラグだと repo 名取り違えのリスクがある）
    (cd "$REPO" && gh pr list \
      --author "@me" --state merged --limit 200 \
      --search "merged:>=$SINCE" \
      --json number,title,mergedAt,additions,deletions) 2>/dev/null \
      | jq -r '
          if (. | type) == "array" then
            sort_by(.mergedAt) | reverse |
            .[] | "#\(.number) (\(.mergedAt[0:10])) +\(.additions)/-\(.deletions) \(.title)"
          else
            "(取得失敗)"
          end
        ' 2>/dev/null || echo "(gh取得失敗)"
    echo '```'
    echo ""
  fi
fi

# === デイリーノート（学び・メモ・振り返り抜粋） ===
# デイリーノートの構造:
#   # 今日やること / # 作業ログ / # 学んだこと / メモ / # 振り返り
#   絵文字付き見出し: 🤖 Claudeコメント / 📝 自分の振り返り / 🏆 今日の評価 / 🌱 今日の成長ポイント / 🎯 明日意識すること
# H1（^# ）で次セクションを境界として抽出する
echo "## デイリーノート抜粋"
echo ""
for i in $(seq 0 $((DAYS-1))); do
  D=$(date -v-${i}d +%Y/%m/%Y-%m-%d 2>/dev/null || date -d "$i days ago" +%Y/%m/%Y-%m-%d)
  NOTE="$HOME/obsidian-vault/デイリーノート/$D.md"
  if [ -f "$NOTE" ]; then
    DATE_LABEL=$(basename "$NOTE" .md)
    # 学び/振り返り/評価/成長/明日意識 を抽出
    EXTRACT=$(awk '
      BEGIN { in_section = 0 }
      /^# 学んだこと/ || /^# 振り返り/ { in_section = 1; print; next }
      /^# / && in_section { in_section = 0 }
      /^🤖 Claudeコメント/ || /^📝 自分の振り返り/ || /^🏆 今日の評価/ || /^🌱 今日の成長ポイント/ || /^🎯 明日意識すること/ {
        in_section = 1; print; next
      }
      in_section { print }
    ' "$NOTE" 2>/dev/null | sed '/^[[:space:]]*$/d')

    # KR タグ行も抽出
    KR_TAGS=$(grep -E '#KR[0-9]' "$NOTE" 2>/dev/null || true)

    if [ -n "$EXTRACT" ] || [ -n "$KR_TAGS" ]; then
      echo "### $DATE_LABEL"
      [ -n "$EXTRACT" ] && echo "$EXTRACT" | head -60
      [ -n "$KR_TAGS" ] && echo "$KR_TAGS"
      echo ""
    fi
  fi
done

# === retlaude reflections（あれば） ===
RETLAUDE_LOG="$HOME/.claude/skills/retlaude/data/reflections.jsonl"
if [ -f "$RETLAUDE_LOG" ]; then
  echo "## retlaude reflections (直近)"
  echo '```'
  tail -20 "$RETLAUDE_LOG" 2>/dev/null | head -20
  echo '```'
fi
