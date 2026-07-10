---
description: CWDガードを切り替える (true=ON: プロジェクト外Write/Edit禁止 / false=OFF: 制限なし / status=確認)
allowed-tools: Bash(touch:*), Bash(mkdir:*), Bash(rm:*), Bash(test:*)
---

現在の状態: まず `test -f .claude/cwd-guard && echo "🛡️ ON (CWDガード: プロジェクト外Write/Edit禁止)" || echo "🔓 OFF (制限なし)"` をBashで実行して確認すること。

引数: $ARGUMENTS

引数に応じて以下を実行し、結果を1行で報告すること。フラグは PreToolUse hook (`~/.claude/hooks/gate-cwd-escape.sh`) が毎回評価するため、変更は即座に反映される。

- `true` / `on`: CWDガードON (Write/Edit/NotebookEdit の対象がプロジェクトCWD外ならブロック)
  ```bash
  mkdir -p "${CLAUDE_PROJECT_DIR:-$PWD}/.claude" && touch "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/cwd-guard"
  ```
- `false` / `off`: CWDガードOFF (制限なし。他worktreeへの書き込みが必要なときに一時解除)
  ```bash
  rm -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/cwd-guard"
  ```
- `status` / 引数なし: 上記「現在の状態」を報告するだけで何も変更しない

補足:
- フラグの実体はプロジェクト (worktree) ごとの `.claude/cwd-guard` ファイル。worktree単位で独立して切り替えられる
- 許可リスト: プロジェクト内・`~/.claude/`(auto-memory等)・`/tmp`・`~/obsidian-vault/` への書き込みは常に許可
- Read は影響を受けない（他worktreeの閲覧は自由）
