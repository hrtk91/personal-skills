# harnessctl

`harnessctl`は、このリポジトリにあるresourceをprofile単位で導入するローカルCLIです。選択画面にはnpm packageの`@clack/prompts`を使い、profile設定と導入状態はリポジトリの外へ保存します。

Node.js 24以降が必要です。外部CLIは必要ありません。

## profileが管理するもの

1つのprofileで対象ハーネスと、次の3種類を独立して選択します。`targets`を省略した旧profileはCodexのみを対象にします。

- Codex: `~/.codex/skills`、Claude Code: `~/.claude/skills`へ導入するskill
- Codex: `~/.codex/AGENTS.override.md`、Claude Code: `~/.claude/rules/harnessctl-personal-skills.md`へ導入する常時ルール
- Codex: `~/.codex/hooks.json`の`hooks`へ追加するhook、Claude Code: `~/.claude/settings.json`の`hooks`へ追加するClaude対応hook

skillからrulesやhookを暗黙に導入することはありません。複数のsourceを登録し、`source-id:resource-name`形式でresourceを選択します。

有効なprofileはハーネスごとに管理します。Codex用profileをapplyした後にClaude用profileをapplyしても、Codexのresourceとprofileは保持します。applyの範囲は、選択したprofileの`targets`と、そのprofileが現在有効なハーネスの和集合です。同じprofileの`targets`からハーネスを外して再applyすると、そのハーネスの管理物を解除します。別profileへ引き継いだハーネスは解除しません。

`targets`から外したハーネスの解除と`rollback`には、stateに保存した導入先を使います。以前のapplyで指定した導入先optionを再指定する必要はありません。

`plan`は範囲内の追加・更新・削除・維持を表示し、範囲外は`変更しない（N 件）`と表示します。範囲外の導入先は検査・変更せず、そのdriftは`status`で確認できます。導入先の衝突は範囲をまたいでも停止します。`status`にはハーネスごとの有効なprofileを表示します。

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

stateとrollback履歴には`profiles: { "codex": "profile1", "claude": "claude" }`のように有効なprofileを保存します。state versionは4のままとし、`activeProfile`・`targets`も直近のapplyを示す互換情報として残します。`profiles`がない旧state・旧履歴は、読み込み時に`activeProfile`と`targets`から補います。`targets`もない場合はmanaged entryから対象を推定します。

選択したrulesの`AGENTS.md`はprofileの記載順で連結し、ハーネスごとのcontent-addressed artifactとして保存します。Codexでは`~/.codex/AGENTS.md`の内容を先頭へ加え、`~/.codex/AGENTS.override.md`から生成物を参照します。Claude Codeでは既存の`~/.claude/CLAUDE.md`を変更せず、公式の[ユーザー共通rules機能](https://code.claude.com/docs/en/memory#user-level-rules)に合わせて`~/.claude/rules/harnessctl-personal-skills.md`から生成物を参照します。両方とも管理先に既存の通常fileやdirectoryがあれば停止します。選択元またはbaseの本文を変更した場合はprofileを再度applyして反映します。

選択したhook packageはprofileの記載順で統合します。hook command内の`{{HOOK_ROOT}}`は、管理対象packageのpathをshell用にquoteした値へ置換します。管理groupはstate directoryへcontent-addressed artifactとして保存し、Codexの`hooks.json`とClaude Codeの`settings.json`の`hooks`へマージします。Claude Codeは公式の[event → matcher group → handler形式](https://code.claude.com/docs/en/hooks)を使います。両方とも通常fileとして保存し、`description`、`model`、`theme`、`statusLine`などの他keyと管理外groupを保持します。次回applyやrollbackで差し替えるのは、stateに記録したharnessctlのgroupだけです。設定fileがなければ新規作成し、最後のgroupを外して`hooks`が空になればそのkeyを消します。

旧Codexの`hook-config` entryと旧rollback履歴も読み込めます。管理artifactを指すsymlinkは、apply時に参照先の内容を取り込んだ通常fileへ移行します。既に通常fileへ置き換えられていても管理groupが揃っていれば受け入れ、追加された管理外groupを保持します。管理groupの編集・削除・重複は`status`で`drifted`、設定fileの不在は`missing`と表示し、そのハーネスのplan/applyを停止します。

hook packageの`hooks.json`では、対応先を`"targets": ["codex", "claude"]`のように宣言します。省略時はCodex専用です。`single-review-decision`はClaudeの`PreToolUse`入力・応答形式と共通hook設定へ対応しています。`subagent-model-notice-for-openai`はOpenAI Codex専用のためClaudeには導入せず、plan/applyに対象外理由を表示します。Claude非対応hookを含むprofileでも、Codex targetには通常通り適用できます。

Claude Codeの設定先は`CLAUDE_CONFIG_DIR`で変更できます。指定がない場合は`~/.claude`を使います。CLIでは`--claude-home <dir>`を指定できます。

## 安全境界

- profile設定: `${XDG_CONFIG_HOME:-~/.config}/personal-skills/profiles.json`
- 導入状態とrollback履歴: `${XDG_STATE_HOME:-~/.local/state}/personal-skills/state.json`
- skill・rules・hook packageの導入先にある通常fileやdirectoryは上書きしません。hook設定の通常fileは管理groupだけをマージします。
- 管理外symlinkは削除せず、衝突として停止します。
- `~/.codex/AGENTS.md`は読み取り専用のbaseとして扱い、統合も上書きもしません。
- `~/.codex/AGENTS.override.md`は常時ルールの生成物として管理し、管理外の通常fileやdirectoryがある場合は上書きせず停止します。
- `~/.claude/CLAUDE.md`はユーザー所有として変更しません。Claude rulesの予約導入先`~/.claude/rules/harnessctl-personal-skills.md`が既存なら停止します。
- Codexの`hooks.json`とClaudeの`settings.json`はJSON objectに限り更新します。管理外symlink、不正JSON、`hooks`のobject形式不整合は停止します。symlink移行を認めるのはstateに記録された旧Codexの管理artifactだけです。追加予定のgroupと完全一致する管理外groupが既にある場合も、所有者を区別できないため停止します。
- 同名skillが同じ導入先を要求した場合、暗黙に一方を選ばず停止します。
- `.system`は選択・削除しません。

`rollback`は直前のapply前のstate全体へ戻します。profileとmanaged entryが前後で同じハーネスは検査・操作せず、範囲外だったハーネスのdriftも保持します。hookは現在の管理外groupと他keyを残して戻すため、旧履歴へのrollbackでも設定fileを丸ごとsymlinkへ戻すことはありません。

通常のfilesystem errorまたはstate書き込み失敗では、操作対象のsymlink集合と両ハーネスのhook設定を直前の状態へ復元します。旧Codex symlinkの移行中に失敗した場合は、元のsymlinkへ戻します。ただし、link/settings更新とstate確定の間にprocessを強制終了した場合の完全復旧、apply/rollbackの同時実行制御、crash journalは未対応です。driftは`harnessctl status`で確認します。

## 同梱する常時ルール

`personal:レビュー判断を1つにする`は、1つのPull Requestでレビュワーに求める判断を1つに保ちます。対応する`personal:single-review-decision` hookは、`gh pr create`と本文を変更する`gh pr edit`で、`## レビュワーに求める判断`が1つの段落になっているか確認します。

意味上の判断は常時ルールが担当します。hookの対象外は、GitHub UI/API経由の変更と、段落内容の意味判定です。
