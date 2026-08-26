# skillsctl

`skillsctl`は、このリポジトリにあるresourceをprofile単位で導入するローカルCLIです。`fzf`は選択画面にだけ使い、profile設定と導入状態はリポジトリの外へ保存します。

Node.js組み込みのTypeScript型除去を使うため、実行時のnpm依存はありません。Node.js 24以降が必要です。

## profileが管理するもの

1つのprofileで、次の3種類を独立して選択します。

- `~/.codex/skills`へ導入するskill
- `~/.codex/AGENTS.md`へ導入する常時ハーネス
- `~/.codex/hooks.json`へ統合するCodex hook package

skillからharnessやhookを暗黙に導入することはありません。複数のsourceを登録し、`source-id:resource-name`形式でresourceを選択します。

## 使い方

```bash
npm run skillsctl -- skills
npm run skillsctl -- sources list
npm run skillsctl -- sources add /path/to/another-skill-repo --id work
npm run skillsctl -- profile tui safe
npm run skillsctl -- profile list
npm run skillsctl -- plan safe
npm run skillsctl -- apply safe
npm run skillsctl -- status
npm run skillsctl -- rollback
```

引数なしで実行するとprofile選択画面を開きます。`TAB`で複数選択、`ESC`で変更せず終了します。`apply`を実行するまで導入状態は変わりません。

sourceのpathやskillの説明も表示する場合は`--verbose`を付けます。

```bash
skillsctl skills --verbose
```

グローバルコマンドとして使う場合は、ローカルpackageを一度導入します。

```bash
npm install --global /home/h-taminato/repos/personal-skills
```

`sources add`には、リポジトリrootまたはskill directoryを直接指定できます。リポジトリsourceからは次のresourceを検出します。

- `skills/*/SKILL.md`
- `harnesses/*/AGENTS.md`
- `hooks/*/hooks.json`

## profile設定

```json
{
  "version": 3,
  "sources": {
    "personal": { "path": "/path/to/personal-skills" },
    "work": { "path": "/path/to/work-skills" }
  },
  "profiles": {
    "safe": {
      "skills": ["personal:review", "work:company-review"],
      "harness": "work:team-policy",
      "hooks": ["work:team-policy"]
    }
  }
}
```

bare名の`review`は`personal:review`として扱います。version 1または2のconfig/stateを正常に読み込むと、その場で正規化したversion 3へ書き換えます。次回のprofile編集やapplyまでは待ちません。

選択したhook packageはprofileの記載順で統合します。hook command内の`{{HOOK_ROOT}}`は、管理対象packageのpathをshell用にquoteした値へ置換します。統合結果はstate directoryへcontent-addressed artifactとして保存し、`~/.codex/hooks.json`から参照します。

## 安全境界

- profile設定: `${XDG_CONFIG_HOME:-~/.config}/personal-skills/profiles.json`
- 導入状態とrollback履歴: `${XDG_STATE_HOME:-~/.local/state}/personal-skills/state.json`
- 既存の通常fileやdirectoryは上書きしません。
- 管理外symlinkは削除せず、衝突として停止します。
- 管理外の`~/.codex/AGENTS.md`と`~/.codex/hooks.json`は統合も上書きもしません。
- `~/.codex/AGENTS.override.md`がある場合、常時ハーネスが無効になるため停止します。
- 同名skillが同じ導入先を要求した場合、暗黙に一方を選ばず停止します。
- `.system`は選択・削除しません。

通常のfilesystem errorまたはstate書き込み失敗では、直前のsymlink集合を復元します。ただし、link更新とstate確定の間にprocessを強制終了した場合の完全復旧、apply/rollbackの同時実行制御、crash journalは未対応です。driftは`skillsctl status`で確認します。
