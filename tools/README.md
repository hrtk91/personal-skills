# harnessctl

`harnessctl`は、このリポジトリにあるresourceをprofile単位で導入するローカルCLIです。選択画面にはnpm packageの`@clack/prompts`を使い、profile設定と導入状態はリポジトリの外へ保存します。

Node.js 24以降が必要です。外部CLIは必要ありません。

## profileが管理するもの

1つのprofileで、次の3種類を独立して選択します。

- `~/.codex/skills`へ導入するskill
- `~/.codex/AGENTS.md`へまとめて導入する常時ルール
- `~/.codex/hooks.json`へ統合するCodex hook package

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
  "version": 4,
  "sources": {
    "personal": { "path": "/path/to/personal-skills" },
    "work": { "path": "/path/to/work-skills" }
  },
  "profiles": {
    "safe": {
      "skills": ["personal:review", "work:company-review"],
      "rules": ["personal:single-review-decision", "work:team-policy"],
      "hooks": ["work:team-policy"]
    }
  }
}
```

bare名の`review`は`personal:review`として扱います。version 1から3のconfigを正常に読み込むと、その場でversion 4へ書き換えます。従来の単一rulesは1要素の配列へ変換します。version 1または2のstateも同様にversion 3へ書き換えます。

選択したrulesの`AGENTS.md`はprofileの記載順で連結し、state directoryへcontent-addressed artifactとして保存します。`~/.codex/AGENTS.md`はこの生成物を参照します。選択元の本文を変更した場合は、profileを再度applyして反映します。

選択したhook packageはprofileの記載順で統合します。hook command内の`{{HOOK_ROOT}}`は、管理対象packageのpathをshell用にquoteした値へ置換します。統合結果はstate directoryへcontent-addressed artifactとして保存し、`~/.codex/hooks.json`から参照します。

## 安全境界

- profile設定: `${XDG_CONFIG_HOME:-~/.config}/personal-skills/profiles.json`
- 導入状態とrollback履歴: `${XDG_STATE_HOME:-~/.local/state}/personal-skills/state.json`
- 既存の通常fileやdirectoryは上書きしません。
- 管理外symlinkは削除せず、衝突として停止します。
- 管理外の`~/.codex/AGENTS.md`と`~/.codex/hooks.json`は統合も上書きもしません。
- `~/.codex/AGENTS.override.md`がある場合、常時ルールが無効になるため停止します。
- 同名skillが同じ導入先を要求した場合、暗黙に一方を選ばず停止します。
- `.system`は選択・削除しません。

通常のfilesystem errorまたはstate書き込み失敗では、直前のsymlink集合を復元します。ただし、link更新とstate確定の間にprocessを強制終了した場合の完全復旧、apply/rollbackの同時実行制御、crash journalは未対応です。driftは`harnessctl status`で確認します。

## 同梱する常時ルール

`personal:single-review-decision`は、1つのPull Requestでレビュワーに求める判断を1つに保ちます。同名のhookは、対応している`gh pr create`と本文を変更する`gh pr edit`で、`## レビュワーに求める判断`が1つの段落になっているか確認します。

意味上の判断は常時ルールが担当します。hookの対象外は、GitHub UI/API経由の変更と、段落内容の意味判定です。
