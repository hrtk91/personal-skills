---
name: daemon-skill
description: ローカルのCodexスキルやエージェント設定を監視・同期し、変更があればGitHubへdraft PRを作るCLI/daemonを設計・実装する。監視対象、同期先repo、実装言語、PR方式、常駐方式を確認し、未指定ならshxでone-shot syncから作る。
---

# daemon-skill

Codexスキルなどのローカル設定を個人repoへ同期し、変更があればdraft PRを作るCLI/daemonを作成・更新するための設計スキル。

## 基本方針

- 実装言語はユーザーに確認する。指定がなければ `shx` を使う。
- 最初から常駐daemonを作らず、まず `sync --dry-run` と `sync` を作る。
- `sync` が安定してから `watch` を追加する。
- 自動でbase branchへpushしない。PRはdraft固定。
- 監視対象はallowlist方式にする。
- secretや個人メモを拾わないため、除外ルールを必ず持つ。
- 既存PRがあれば同じbranchへpushして更新し、PRを乱立させない。

## デフォルト

ユーザーが未指定なら以下で進める。

- 同期先repo: `~/repos/personal-skills`
- 監視対象: `~/.codex/skills`
- repo内配置: `skills/`
- 実装言語: `shx`
- PR方式: GitHub draft PR
- base branch: repoのdefault branch。未取得ならユーザーに確認する
- 初期コマンド: `personal-skills sync --dry-run`, `personal-skills sync`
- 常駐監視: 後続で `personal-skills watch` として追加

## ユーザーインタビュー

必要な確認は最小限にする。未回答ならデフォルトを採用して進める。

1. 監視対象
   - default: `~/.codex/skills`
   - 将来追加候補: `~/.codex/agents`, repo-local `.agents/skills`
2. 同期先repo
   - default: `~/repos/personal-skills`
3. 実装言語
   - default: `shx`
4. PR作成方式
   - default: draft PR
5. base branch
   - default: repoのdefault branch
   - `main` 固定にしない。`develop` や `trunk` のrepoも想定する
6. 常駐方式
   - default: まずone-shot sync、watchは後で追加

## 推奨repo構成

```text
personal-skills/
  skills/
    review/
      SKILL.md
    daemon-skill/
      SKILL.md
  scripts/
    install-symlinks.sh
  daemon/
    personal-skills.shx
    config.example.toml
```

## CLI仕様

最小コマンド:

```bash
personal-skills sync --dry-run
personal-skills sync
personal-skills watch
personal-skills init
```

`sync --dry-run` は必須。実際のcommit/push/PR作成をせず、対象ファイル、除外ファイル、作成予定branch、commit予定差分を表示する。

## 同期ルール

- sourceからdestへ同期する。
- `.system/` など管理対象外のsystem skillsはデフォルトで除外する。
- symlinkはリンク先を勝手に取り込まない。必要なら設定で明示する。
- 削除も同期対象にするが、`--dry-run` で必ず表示する。
- branch名は固定プレフィックスを使う。
  - 例: `codex/sync-personal-skills`
- commit messageは同期対象と件数を含める。

## 設定例

```toml
repo = "~/repos/personal-skills"
base_branch = "main"
branch = "codex/sync-personal-skills"
draft_pr = true

[[watch]]
name = "codex-skills"
source = "~/.codex/skills"
dest = "skills"
exclude = [".system/**"]
```

## 安全策

- base branchへの直接pushは禁止。
- draft PR以外を作る場合はユーザーに確認する。
- allowlist外のファイルは同期しない。
- secret候補ファイルは除外する。
  - `.env`, `*.key`, `*.pem`, `credentials*`, `token*`
- 破壊的な削除は `--dry-run` で明示し、必要なら確認を挟む。

## 実装手順

1. repo構成と設定ファイルを作る。
2. `sync --dry-run` を作る。
3. `sync` でbranch作成、同期、commitまで行う。
4. GitHub push / draft PR作成を追加する。
5. `watch` は最後に追加する。
6. install scriptで `~/.codex/skills/<name>` へのsymlinkを張る。

## 完了条件

- `sync --dry-run` で対象差分が説明される。
- `sync` でrepo側に変更が反映される。
- PR作成はdraftで行われる。
- 監視対象を設定で追加できる。
- デフォルトでは `~/.codex/skills/.system` を同期しない。
