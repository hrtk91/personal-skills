---
name: prm
description: prm-cli（PR Metrics CLI）を使ってPRメトリクスを取得・集計・可視化するスキル。週単位でデータをフェッチし、チーム全体または個人のリードタイム・PR数・生産性推移を分析する。「PRメトリクス見せて」「リードタイム確認して」「prm fetch して」「PR速度の推移見たい」「自分のPR集計して」「prm使って」「12月からの生産性計りたい」などのキーワードで積極的に起動すること。prm、PRメトリクス、リードタイム、PR速度などに言及があれば即座に使用する。
---

# prm スキル

`prm-cli` を使ってPRメトリクスを取得・分析する。

## 環境情報

- **コマンド**: `prm`（グローバルインストール済み）
- **データ保存先**: `~/.pr-metrics/<owner>/<repo>/data/YYYY-WNN.json.gz`
- **スキーマバージョン**: v3.0（レビュー行コメント含む。v2.0 データは fetch 時に自動検出・再取得）
- **⚠️ バックグラウンド実行不可**: `fetch` はバックグラウンド実行だと gh keychain にアクセスできずトークンエラーになる。フォアグラウンドで実行すること

## コマンド一覧

```
prm stored [repo]                            # 取得済み週の一覧
prm report [repo_or_week] [week] [options]   # 週次レポート表示（--full で相関分析付き）
prm history [repo] [options]                 # 複数週の推移比較
prm fetch [repo] [options]                   # 週次データ取得
prm init [options]                           # リポジトリ初期化
prm readme                                   # README表示
```

## よく使う操作

### 1. データ取得（fetch）

```bash
# 直近1週間
prm fetch OWNER/REPO

# 期間指定（since〜until の全週を取得）
prm fetch OWNER/REPO --since 2025-08-01 --until 2026-03-19

# since から N 週分
prm fetch OWNER/REPO --since 2026-03-01 --weeks 4

# 直近 N 週（従来方式）
prm fetch OWNER/REPO --weeks 8
```

旧スキーマ(v2.0)の週は自動検出され再fetchされる。

### 2. 一覧表示（stored）

```bash
prm stored OWNER/REPO
```

### 3. 週次レポート（report）

```bash
# 最新週
prm report OWNER/REPO

# 特定週
prm report OWNER/REPO 2026-W10

# フル分析（相関分析・大規模PR検出付き）
prm report OWNER/REPO 2026-W10 --full

# 個人フィルタ
prm report OWNER/REPO --user hrtk91

# 出力形式: text（デフォルト）, json, markdown
prm report OWNER/REPO --format json
```

### 4. 複数週の推移比較（history）

```bash
# 直近4週を比較（デフォルト）
prm history OWNER/REPO

# 直近8週を比較
prm history OWNER/REPO --weeks 8

# 個人フィルタ
prm history OWNER/REPO --user hrtk91 --weeks 8

# JSON出力
prm history OWNER/REPO --format json
```

## レポート指標

### 推進指標（攻め）
- PRマージ数、リードタイム（平均/P50/P75/P95）、コメント数、レビュワー数

### 抑制指標（守り）
- 変更行数（P50/P75/P95）、再オープン率、レビュー待機時間

### その他
- 実装負荷スコア（workload）: author 別の負荷配分
- Review Approvals / Review Comments: レビュー活動量
- PR一覧: 各PRのリードタイム・タイトル

## 注意事項

- **`--user` フラグは `report` / `history` で使う**: `fetch` の `--user` は意味がない（全PRが保存される）
- **fetch は `dangerouslyDisableSandbox: true` が必要**: GitHub APIにアクセスするため
- **v2.0 → v3.0 の違い**: v3.0 ではレビュー行コメント（inline review comments）が含まれる。v2.0 データは report 時に警告が出る

## ワークフロー

1. `prm stored` で取得済み週を確認
2. 未取得期間があれば `prm fetch --since YYYY-MM-DD` で取得
3. `prm history --weeks 8` で推移を把握
4. `prm report --full` で詳細分析
5. 個人集計は `--user hrtk91` を付けて実行
