# personal-skills

AIエージェントに、作業の進め方や判断基準を追加するための個人用スキル集です。

コードレビュー、調査、文章作成、開発環境の運用など、繰り返し使う手順を `skills/` にまとめています。Codex、Claude Code、一部のスキルはHermesから利用できます。

## 使い方

リポジトリをcloneし、環境に合うインストールスクリプトを実行します。

Linux / macOS / WSL:

```bash
./scripts/install-symlinks.sh
```

Windows PowerShell:

```powershell
./scripts/install-symlinks.ps1
```

各スキルの詳しい使い方は、`skills/<スキル名>/SKILL.md` にあります。

## スキル一覧

### 調査・設計・実装

| スキル | 概要 |
| --- | --- |
| `ai-dev-workflow` | AIによる実装を、worktree、品質確認、再試行、通知まで含む作業フローにします。 |
| `comment-processing-order` | 複数段階の処理に、順序が分かるコメントを付けます。 |
| `fracta` | git worktree、Lima VM、Docker Composeを使う開発環境を操作します。 |
| `frontend-development-principles` | 状態、UI、副作用の責務を整理してフロントエンドを設計します。 |
| `investigating-domain` | 実装を「概要把握、詳細確認、統合」の順で調査します。 |
| `orchestrate-exploration` | 長い調査を複数のsubagentへ分け、親スレッドで進捗と判断を管理します。 |
| `research-experiment-loop` | 実験結果と仮説を記録し、過去の結果を踏まえて次の調査を決めます。 |
| `test-design` | 仕様変更や不具合修正を守るテストを設計します。 |

### コードレビュー

| スキル | 概要 |
| --- | --- |
| `review` | 命名、責務、型、安全性、保守性、影響範囲、テストの観点でレビューします。 |
| `adversarial-review` | 一見正しい変更にも残る抜け道や未検証の前提を探します。 |
| `review-impact-analysis` | 変更の利用箇所をたどり、追従漏れを確認します。 |
| `review-layer-responsibility` | 処理が適切な層にあり、依存方向を守っているか確認します。 |
| `review-maintainability` | 重複、複雑さ、責務過多など、保守を難しくする点を確認します。 |
| `review-naming` | 名前から対象や処理が分かり、既存用語と揃っているか確認します。 |
| `review-test-quality` | テストが必要な振る舞いを実際に守れているか確認します。 |
| `review-type-safety` | 不正な状態、検証不足、暗黙の変換などを確認します。 |
| `review-reply-format` | AIレビューへの返信を、引用ベースの事務的な形式に整えます。 |

### 文章・記録

| スキル | 概要 |
| --- | --- |
| `career-accountability-review` | 職務経歴書や面接回答を、状況、判断と行動、結果が伝わる形に整えます。 |
| `minimal-writing` | 文章の根拠と役割を確認し、必要な情報を残して簡潔にします。 |
| `obsidian` | ObsidianのデイリーノートへTODOやメモを読み書きします。 |
| `zettelkasten` | 技術的な学びを、あとから検索して再利用できるノートにします。 |

### GitHub・セキュリティ

| スキル | 概要 |
| --- | --- |
| `create-pull-request` | 背景、変更内容、確認結果が分かる日本語のPull Requestを作ります。 |
| `codex-security` | Codex Securityによる脆弱性の検出、確認、修正後の再検査を進めます。 |
| `endpoint-pentest` | エンドポイントの情報収集、診断、結果整理を定期実行します。 |
| `prm` | PR数やリードタイムなどのPull Requestメトリクスを集計します。 |

### エージェント・スキル運用

| スキル | 概要 |
| --- | --- |
| `codex` | Codexを第二意見を得る相手として使います。 |
| `grok-second-opinion` | Grokへ前提と論点を渡し、別の角度から意見を得ます。 |
| `personal-skills-auto-update` | 更新条件を確認しながら、WindowsとWSLの実行環境へスキルを自動反映します。 |
| `personal-skills-ctl-daemon` | このリポジトリとローカルのスキルを同期するCLIやdaemonを設計します。 |
| `retlaude` | Claudeセッションの振り返りを非同期で保存します。 |
| `skill-usage-analytics` | Codexセッションで各スキルが使われた回数を集計します。 |

### UI・日々の振り返り

| スキル | 概要 |
| --- | --- |
| `evaluation-coach` | 日次・週次の振り返りから、半期評価の根拠を積み上げます。 |
| `information-architecture-ui-review` | 情報の優先順位と操作の流れからUIをレビューします。 |

## そのほかの内容

- `agents/`: Codexのカスタムagent設定
- `commands/`: Claude Codeのカスタムコマンド
- `hooks/`: セッション記録やコマンド実行前の確認などのhook
- `scripts/`: スキルと設定を各ツールへ反映するスクリプト
