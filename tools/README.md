# harnessctl

`harnessctl`は、このリポジトリにあるresourceをprofile単位で導入するローカルCLIです。選択画面にはnpm packageの`@clack/prompts`を使い、profile設定と導入状態はリポジトリの外へ保存します。

Node.js 24以降が必要です。外部CLIは必要ありません。

## profileが管理するもの

1つのprofileで対象ハーネスと、次の3種類を独立して選択します。`targets`を省略した旧profileはCodexのみを対象にします。

- Codex: `~/.codex/skills`、Claude Code: `~/.claude/skills`へ導入するskill
- Codex: `~/.codex/AGENTS.override.md`、Claude Code: `~/.claude/rules/harnessctl-personal-skills.md`へ導入する常時ルール
- Codex: `~/.codex/hooks.json`へ統合するhook、Claude Code: `~/.claude/settings.json`の`hooks`へ追加するClaude対応hook

skillからrulesやhookを暗黙に導入することはありません。複数のsourceを登録し、`source-id:resource-name`形式でresourceを選択します。

## 使い方

```bash
npm run harnessctl -- skills
npm run harnessctl -- sources list
npm run harnessctl -- sources add /path/to/another-skill-repo --id work
npm run harnessctl -- profile tui safe
npm run harnessctl -- profile list
npm run harnessctl -- plan safe
npm run harnessctl -- apply safe
npm run harnessctl -- status
npm run harnessctl -- rollback
```

引数なしで実行するとprofile選択画面を開きます。文字入力で候補を絞り込み、`Space`または`TAB`で複数選択、`Enter`で確定します。resourceの選択中に`Ctrl+C`を押すとprofileを変更せず終了します。

選択を確定するとprofileを保存し、そのまま適用するか確認します。初期値は`保存のみ`です。`保存のみ`を選ぶか確認画面で`Ctrl+C`を押した場合、導入状態は変更しません。

sourceのpathやskillの説明も表示する場合は`--verbose`を付けます。

```bash
harnessctl skills --verbose
```

GitHubからグローバルコマンドとして導入する場合は、`vX.Y.Z`をreview済みのtagへ置き換え、install時scriptを無効にします。

```bash
npm install --global --ignore-scripts github:hrtk91/personal-skills#vX.Y.Z
```

導入後は`harnessctl`コマンドを使用します。

## 開発

CLIを変更した場合は実行fileを更新します。

```bash
npm ci
npm run build:cli
```

生成した`tools/dist/skills-ctl.mjs`はcommit対象です。

`sources add`には、リポジトリrootまたはskill directoryを直接指定できます。リポジトリsourceからは次のresourceを検出します。

- `skills/*/SKILL.md`
- `rules/*/AGENTS.md`
- `hooks/*/hooks.json`

## profile設定

```json
{
  "version": 5,
  "sources": {
    "personal": { "path": "/path/to/personal-skills" },
    "work": { "path": "/path/to/work-skills" }
  },
  "profiles": {
    "safe": {
      "targets": ["codex", "claude"],
      "skills": ["personal:review-maintainability", "work:company-review"],
      "rules": ["personal:レビュー判断を1つにする", "work:team-policy"],
      "hooks": ["work:team-policy"]
    }
  }
}
```

bare名の`review-maintainability`は`personal:review-maintainability`として扱います。version 1から4のconfigを読み込むとversion 5へ移行し、`targets`がないprofileには`["codex"]`を設定します。従来の単一rulesは1要素の配列へ変換します。version 1から3のstateはversion 4へ移行し、既存entryをCodex対象として記録します。

選択したrulesの`AGENTS.md`はprofileの記載順で連結し、ハーネスごとのcontent-addressed artifactとして保存します。Codexでは`~/.codex/AGENTS.md`の内容を先頭へ加え、`~/.codex/AGENTS.override.md`から生成物を参照します。Claude Codeでは既存の`~/.claude/CLAUDE.md`を変更せず、公式の[ユーザー共通rules機能](https://code.claude.com/docs/en/memory#user-level-rules)に合わせて`~/.claude/rules/harnessctl-personal-skills.md`から生成物を参照します。両方とも管理先に既存の通常fileやdirectoryがあれば停止します。選択元またはbaseの本文を変更した場合はprofileを再度applyして反映します。

選択したhook packageはprofileの記載順で統合します。hook command内の`{{HOOK_ROOT}}`は、管理対象packageのpathをshell用にquoteした値へ置換します。統合結果はstate directoryへcontent-addressed artifactとして保存します。Codexは`~/.codex/hooks.json`から参照し、Claude Codeは公式の[event → matcher group → handler形式](https://code.claude.com/docs/en/hooks)で`~/.claude/settings.json`の`hooks`へ追加します。既存settingsの`model`、`theme`、`statusLine`などの値と管理外hookは保持し、stateに記録したharnessctlのgroupだけを次回applyやrollbackで差し替えます。管理対象groupの編集・削除・重複が見つかった場合はstatusでdriftを示し、上書きせず停止します。

hook packageの`hooks.json`では、対応先を`"targets": ["codex", "claude"]`のように宣言します。省略時はCodex専用です。`single-review-decision`はClaudeの`PreToolUse`入力・応答形式と共通hook設定へ対応しています。`subagent-model-notice-for-openai`はOpenAI Codex専用のためClaudeには導入せず、plan/applyに対象外理由を表示します。Claude非対応hookを含むprofileでも、Codex targetには通常通り適用できます。

Claude Codeの設定先は`CLAUDE_CONFIG_DIR`で変更できます。指定がない場合は`~/.claude`を使います。CLIでは`--claude-home <dir>`を指定できます。

## 安全境界

- profile設定: `${XDG_CONFIG_HOME:-~/.config}/personal-skills/profiles.json`
- 導入状態とrollback履歴: `${XDG_STATE_HOME:-~/.local/state}/personal-skills/state.json`
- 既存の通常fileやdirectoryは上書きしません。
- 管理外symlinkは削除せず、衝突として停止します。
- `~/.codex/AGENTS.md`は読み取り専用のbaseとして扱い、統合も上書きもしません。
- `~/.codex/AGENTS.override.md`は常時ルールの生成物として管理し、管理外の通常fileやdirectoryがある場合は上書きせず停止します。
- `~/.claude/CLAUDE.md`はユーザー所有として変更しません。Claude rulesの予約導入先`~/.claude/rules/harnessctl-personal-skills.md`が既存なら停止します。
- Claudeの`settings.json`は通常fileのJSON objectに限り更新します。symlink、不正JSON、`hooks`のobject形式不整合は停止します。harnessctlのhook groupと同じ完全一致groupが既にある場合も、所有者を区別できないため停止します。
- 同名skillが同じ導入先を要求した場合、暗黙に一方を選ばず停止します。
- `.system`は選択・削除しません。

通常のfilesystem errorまたはstate書き込み失敗では、直前のsymlink集合とClaude settingsの内容を復元します。ただし、link/settings更新とstate確定の間にprocessを強制終了した場合の完全復旧、apply/rollbackの同時実行制御、crash journalは未対応です。driftは`harnessctl status`で確認します。

## 同梱する常時ルール

`personal:レビュー判断を1つにする`は、1つのPull Requestでレビュワーに求める判断を1つに保ちます。対応する`personal:single-review-decision` hookは、`gh pr create`と本文を変更する`gh pr edit`で、`## レビュワーに求める判断`が1つの段落になっているか確認します。

意味上の判断は常時ルールが担当します。hookの対象外は、GitHub UI/API経由の変更と、段落内容の意味判定です。
