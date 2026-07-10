---
description: 委譲駆動モードを切り替える (true=ON: メインのWrite/Edit禁止・subagent駆動 / false=OFF: 通常モード / status=確認)
allowed-tools: Bash(touch:*), Bash(mkdir:*), Bash(rm:*), Bash(test:*)
---

現在の状態: まず `test -f .claude/delegate-driven && echo "🤖 ON (委譲駆動モード: メインのWrite/Edit禁止)" || echo "✋ OFF (通常モード)"` をBashで実行して確認すること。

引数: $ARGUMENTS

引数に応じて以下を実行し、結果を1行で報告すること。フラグは PreToolUse hook (`~/.claude/hooks/gate-main-write.sh`) が毎回評価するため、変更は即座に反映される。

- `true` / `on`: 委譲駆動モードON (メインスレッドのWrite/Editを禁止し、実装をsubagentに委譲する)
  ```bash
  mkdir -p "${CLAUDE_PROJECT_DIR:-$PWD}/.claude" && touch "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/delegate-driven"
  ```
- `false` / `off`: 委譲駆動モードOFF (通常モードに戻す。小規模変更を直接書きたいときはこちら)
  ```bash
  rm -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/delegate-driven"
  ```
- `status` / 引数なし: 上記「現在の状態」を報告するだけで何も変更しない

補足:
- フラグの実体はプロジェクト (worktree) ごとの `.claude/delegate-driven` ファイル。worktree単位で独立して切り替えられる
- モードON中も subagent の Write/Edit、プロジェクト外への書き込み (auto-memory 等)、Read は影響を受けない
- モードONにしたら、以降の実装作業は Agent tool (subagent) に委譲し、メインは調査・検証・統合判断に徹すること
