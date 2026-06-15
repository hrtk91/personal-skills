---
name: retlaude
description: Claudeセッションの振り返りを非同期で蓄積するdaemonツール。SessionEnd時にqueueに放り込まれた振り返りjobをbackgroundで処理し、reflectionsとObsidianログ、user-profileを更新する。「retlaude logs」「retlaude status」などCLIから操作する。
---

# retlaude

Claudeセッションの**振り返りを非同期で蓄積する**daemonツール。

## なぜあるか

SessionEnd hook内でsonnet等を呼ぶと、終了プロセスごとkillされて処理が完走しない。
特にuser-profileの更新は3日間落ちていた。

retlaudeは:
1. SessionEnd時に**enqueueだけ**（数msで終了 → killされない）
2. launchd常駐daemonがbackgroundで処理（時間制約なし）
3. 1セッション1振り返り → reflections/に蓄積
4. 朝7時台に日次集約 → user-profile.json更新

## 使い方

### CLI

```
retlaude install            # 初回のみ: launchd plist生成 + load
retlaude status             # daemon状況 + queue件数
retlaude logs [-f]          # 最新ログtail (-fでfollow)
retlaude queue              # pending一覧 + 失敗履歴
retlaude profile [N]        # accumulated interests + 直近Nのobservation(default=5)
retlaude reflections [date] # 指定日の振り返り一覧 (default=今日)
retlaude reflect <id>       # 手動振り返り
retlaude aggregate [date]   # 日次集約手動実行
retlaude search <query> [N] # FTS5 trigramで全文検索 (>=3文字, default 10件)
retlaude reindex            # SQLite DB再構築
retlaude archive <kind> [N] # cold storage参照
retlaude start | stop | restart
```

### 自動化

- SessionEnd hookで `enqueue.sh` が呼ばれ、`~/.claude/retlaude/queue/pending/<session_id>.json` に登録
- daemon (poll.sh) が5分おきにpending/をスキャンしreflect.shを実行
- 朝7時台にprofile-aggregate.shが前日分を集約

## ディレクトリ構成

```
~/.claude/retlaude/
├── queue/{pending,processing,done,failed}/
├── reflections/<YYYY-MM-DD>/<session_id>.json
└── user-profile.json

~/.claude/skills/retlaude/
├── SKILL.md
└── scripts/
    ├── install.sh                  # launchd登録
    ├── cli.sh                      # retlaudeコマンド本体
    ├── poll.sh                     # daemon
    ├── enqueue.sh                  # SessionEnd hookから呼ぶ
    └── processors/
        ├── reflect.sh              # 1セッション振り返り
        └── profile-aggregate.sh    # 日次集約

~/.cache/retlaude/logs/
├── poll-YYYY-MM-DD.log
├── reflect-YYYY-MM-DD.log
├── aggregate-YYYY-MM-DD.log
└── launchd.{out,err}

~/Library/LaunchAgents/com.user.retlaude.plist
```

## reflectionの中身

```json
{
  "session_id": "uuid",
  "project": "my-project",
  "cwd": "/path/to/cwd",
  "branch": "develop",
  "ended_at": "2026-05-08T03:00:00Z",
  "generated_at": "2026-05-08T03:05:00Z",
  "reflection": {
    "summary": "1行要約",
    "topics": ["..."],
    "key_insights": ["..."],
    "personality_observation": "...",
    "interests_candidates": ["..."]
  }
}
```

## 環境変数（poll.sh）

| 変数 | デフォルト | 用途 |
|---|---|---|
| `POLL_INTERVAL` | 300 | poll間隔(秒) |
| `AGGREGATE_HOUR` | 7 | 日次集約を走らせる時(HH) |
| `DONE_RETENTION_DAYS` | 7 | done/の自動削除日数 |
| `LOG_RETENTION_DAYS` | 7 | ログの自動削除日数 |
| `OBSIDIAN_VAULT` | ~/obsidian-vault | Obsidian Vaultパス |

## トラブル時の見方

```
retlaude status                  # daemon生きてるか + 滞留件数
retlaude logs                    # 最近のpoll動作
retlaude queue                   # pending と failed 一覧
ls ~/.claude/retlaude/queue/failed/  # 失敗jobの中身を確認
```

failed/のJSONには `error` と `failed_at` が記録されている。
原因を直してから `mv ~/.claude/retlaude/queue/failed/<id>.json ~/.claude/retlaude/queue/pending/` で再投入できる。

## 既存ツールとの関係

- `session-tracker.ts` (UserPromptSubmit hook): セッション中のtask_history管理は引き続き担当（軽量・retlaudeとは独立）
- `session-end-log.ts`: 旧実装。SessionEnd hookから外したので呼ばれなくなった。動作確認後に削除推奨
- `handing-off-session` skill: PreCompact hookの引き継ぎ（retlaudeとは無関係に存続）
- `obsidian-daily.ts`: PROFILE_FILEのパスをretlaudeに切替済み
