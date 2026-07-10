---
name: obsidian
description: Obsidianデイリーノートへのデータ読み書きツール。TODO追加・完了、学び・メモの追記、tmuxログ取得・解析、ActivityWatchウィンドウ履歴取得、労働時間集計(pmset)を行う。「todo追加して」「メモしておいて」「作業ログ見せて」「tmuxログ」「労働時間」「今日何時間働いた」「あと何時間」「ウィンドウ履歴」「何やってた？」などで使用。振り返り・評価はevaluation-coachスキルへ。 (user)
---

# Obsidian連携スキル（データI/O）

デイリーノートへの読み書きと、作業データ取得のツール。
振り返り・ランク評価・evidence管理は **evaluation-coach** スキルが担当する。

## 設定

- Vaultパス: `~/obsidian-vault`
- デイリーノート: `~/obsidian-vault/デイリーノート/YYYY/MM/YYYY-MM-DD.md`

## デイリーノートパス取得

```bash
~/.claude/skills/obsidian/scripts/daily-path.sh
~/.claude/skills/obsidian/scripts/daily-path.sh yesterday
```

## できること

| ユーザーの依頼例 | 対応 |
|------------------|------|
| 「todo追加して」「〜をやることリストに」 | 「今日やること」セクションに追記 |
| 「〜完了した」「〜終わった」 | チェックボックスを `[x]` に変更 |
| 「〜を学んだ」「メモしておいて」 | 「学んだこと / メモ」セクションに追記（簡易メモ） |
| 「TILに記録して」「ナレッジとして残して」 | → **zettelkasten スキル**に委譲 |
| 「作業ログ見せて」「tmuxログ取得して」 | tmuxログを取得して作業単位でまとめる |
| 「〜時からのログ」「最新100行」 | 範囲指定でtmuxログを取得 |
| 「労働時間どんくらい？」「今日何時間働いた？」 | `work-hours.md` 参照（pmsetログから実労働・休憩を集計） |
| 「何やってた？」「ウィンドウ履歴」「作業内容を見せて」 | ActivityWatch APIからウィンドウ履歴を取得・要約 |

## ウィンドウ履歴（ActivityWatch）

ActivityWatchがlocalhost:5600で起動している前提。

### スクリプトパス

```bash
~/.claude/skills/obsidian/scripts/window-history.sh [YYYY-MM-DD]
~/.claude/skills/obsidian/scripts/window-summary.sh [YYYY-MM-DD]
```

| スクリプト | 説明 |
|-----------|------|
| `window-history.sh` | 指定日のウィンドウ履歴をJSONLで取得（生データ） |
| `window-summary.sh` | アプリ別合計 + 時間帯別 top3 をマークダウンで出力 |

起動確認: ActivityWatchが落ちている場合はスクリプトがエラーで終了する。`open -a ActivityWatch` で起動。

## tmuxログ取得

```bash
node ~/.claude/skills/obsidian/scripts/tmux-log.js
```

| コマンド | 説明 |
|----------|------|
| `list` | 今日のログファイル一覧 |
| `raw --last N` | 最新N行を取得 |
| `raw --since HH:MM` | 指定時刻以降を取得 |
| `raw --clean` | UIノイズを除去して取得 |
| `units` | 作業単位でまとめて表示 |
| `units --verbose` | 作業単位＋詳細表示 |
| `summary` | obsidian追記用の作業ログ形式 |

## git log の取得方法

**重要**: 他のメンバーのコミットを含めないよう、**必ずauthorでフィルタする**。

```bash
git config user.name   # 例: "Your Name"

# 日次
git log --all --oneline --since="today 00:00" --author="$(git config user.name)"

# 週次
git log --all --oneline --since="last monday" --author="$(git config user.name)"
```

## 労働時間集計

詳細は `work-hours.md` を参照。

```bash
bash ~/.claude/skills/obsidian/scripts/work-hours.sh [YYYY-MM-DD]
```

## ファイル操作

### 追記フォーマット

```markdown
# 今日やること
- [ ] タスク内容

# 作業ログ
- HH:MM 作業内容

# 学んだこと / メモ
- [[TILノートへのリンク]]  ← Zettelkasten方式（永続ナレッジ）
- #tag 簡易メモ  ← その日限りのメモ
```

### 注意事項

- セクションの末尾に追記
- セクションがなければ作成
- 現在時刻: `date "+%H:%M"`
- **ファイル編集は必ずEditツールを使用する**
- **bashの `>>` リダイレクトは使わない**（文字化けやエンコーディング問題の原因になる）
