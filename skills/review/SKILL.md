---
name: review
description: レビュー用サブエージェント（命名一貫性・レイヤー責務・型安全性・保守性・影響範囲・テスト充足性）を一括並列起動する。「レビューして」「コードレビュー」「/review」で使用する。変更ファイルを自動検出し、6つのレビュー観点を並列実行して結果をまとめて報告する。
---

# review スキル

変更ファイルに対して、6つのレビュー用サブエージェントを並列起動し、結果をまとめて報告する。

## 手順

### 1. 変更ファイルの特定

`git diff --name-only main...HEAD` で変更ファイル一覧を取得する。
引数でファイルパスが指定されていればそれを使う。

### 2. サブエージェント一括起動

以下の6つのAgentを **並列で** 起動する（`subagent_type` を指定）:

#### a. naming-consistency-reviewer
- subagent_type: `naming-consistency-reviewer`
- model: `sonnet`
- プロンプト: 変更ファイル一覧を渡し、命名の対称性・用語一貫性・配置の適切さをレビューさせる

#### b. layer-responsibility-reviewer
- subagent_type: `layer-responsibility-reviewer`
- model: `sonnet`
- プロンプト: 変更ファイル一覧を渡し、レイヤー責務・依存方向・ポート設計をレビューさせる

#### c. type-safety-reviewer
- subagent_type: `type-safety-reviewer`
- model: `sonnet`
- プロンプト: 変更ファイル一覧を渡し、型安全性（VO・enum・バリデーション）をレビューさせる

#### d. maintainability-reviewer
- subagent_type: `maintainability-reviewer`
- model: `sonnet`
- プロンプト: 変更ファイル一覧を渡し、保守性（ネスト深度・重複・可読性・エラーハンドリングパターン）をレビューさせる

#### e. impact-analysis-reviewer
- subagent_type: `impact-analysis-reviewer`
- model: `sonnet`
- プロンプト: 変更ファイル一覧を渡し、変更された関数・型・定数の呼び出し元をGrepで探索し、追従漏れ・不整合を検出させる

#### f. test-coverage-reviewer
- subagent_type: `test-coverage-reviewer`
- model: `sonnet`
- プロンプト: 変更ファイル一覧と差分を確認し、テスト充足性をレビューさせる。特に正常系・異常系・境界条件・権限/認証差分・UI表示制御・既存E2E/統合テストへの追従漏れ・回帰防止に必要な最小テストを確認させる

各エージェントには以下の情報を渡す:
- 変更ファイルの一覧
- 「レビュー結果を日本語で、指摘事項をリスト形式で報告してください。問題なければ "問題なし" と報告してください。」

### 3. 結果の集約・報告

6つのエージェントの結果を以下の形式でまとめて報告する:

```
## レビュー結果

### 命名一貫性
（naming-consistency-reviewer の結果）

### レイヤー責務
（layer-responsibility-reviewer の結果）

### 型安全性
（type-safety-reviewer の結果）

### 保守性
（maintainability-reviewer の結果）

### 影響範囲
（impact-analysis-reviewer の結果）

### テスト充足性
（test-coverage-reviewer の結果）
```

指摘がゼロの場合は「全観点で問題なし」と簡潔に報告する。
