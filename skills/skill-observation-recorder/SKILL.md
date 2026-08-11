---
name: skill-observation-recorder
description: Codexセッション中にユーザーから受けた実装・設計・レビューへの訂正を、セッション終了後に非同期で抽出して蓄積する。普段の開発からbenchmark候補となる失敗事例を残すために使う。
---

# Skill observation recorder

普段のCodex利用から、AIの判断や作業方法に対するユーザー訂正をバックグラウンドで蓄積する。

SessionEnd hookでは解析せずqueueへの登録だけを行う。別processがtranscriptを読み、**訂正後に設計・修正・実装まで進み、解決した事例だけ**を `~/.codex/skill-observations/observations/` に保存する。

保存対象:

- 実装・設計・レビュー・調査方法についてユーザーがAIの判断を訂正した
- 同種の別タスクでも起こりうる失敗である
- その後の会話で期待する判断や実装が具体化し、解決まで進んだ

保存しない:

- 単なる追加要件や仕様変更
- タイポや一度限りの表記修正
- ユーザーの好みが途中で変わっただけのもの
- 訂正後も結論が出ていないもの

このrecorderは観測だけを行い、skill変更やbenchmarkへの昇格は行わない。

## 導入

```bash
node ~/.codex/skills/skill-observation-recorder/scripts/install-hook.mjs
```

Codexのhook一覧で追加内容を確認する。

最近の観測:

```bash
node ~/.codex/skills/skill-observation-recorder/scripts/list.mjs
```

## 保存先

```text
~/.codex/skill-observations/
├── queue/{pending,processing,done,failed}/
├── observations/<YYYY-MM-DD>/<session_id>.json
└── logs/worker.log
```
