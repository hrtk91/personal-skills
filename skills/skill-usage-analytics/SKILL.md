---
name: skill-usage-analytics
description: Codexセッションでskillが明示・暗黙に起動された回数と利用セッション率を記録・集計する。skillの利用状況、起動率、明示指定の未読込候補、トリガー改善を確認するときに使う。
---

# Skill Usage Analytics

Codexの`SessionEnd` hookが保存したmain threadのセッション別レコードを集計する。会話本文、tool出力、cwdは保存せず、session/turn ID、時刻、skill名、検出根拠、回数だけを残す。subagentは対象外で、transcriptからの推定値である。

## 集計を見る

```bash
node ~/.codex/skills/skill-usage-analytics/scripts/report.mjs
node ~/.codex/skills/skill-usage-analytics/scripts/report.mjs --days 30 --json
```

次を区別する。

- `explicit`: ユーザーが`$skill-name`で指定し、そのskillが実際に読み込まれた
- `implicit`: ユーザーの明示指定なしでskillが読み込まれた
- `requested-only`: 明示指定されたが、`SKILL.md`読込を確認できなかった
- main session推定起動率: skillを1つ以上読み込んだmain session数 / 記録済みmain session数

`requested-only`はトリガー漏れ候補として確認する。ただし、会話に例示として書かれたskill名を誤検出する可能性があるため、確定的な失敗とは扱わない。

## Hookを設定する

`scripts/install-hook.mjs`を実行すると、`~/.codex/hooks.json`の`SessionEnd`へ計測hookを追加する。既存hookは保持する。
installerを実行したNode.jsの絶対pathをcommandへ保存するため、hook実行時の`PATH`にNode.jsがなくても動作する。

```bash
node ~/.codex/skills/skill-usage-analytics/scripts/install-hook.mjs
```

Codexで`/hooks`を開き、追加されたhookを確認してtrustする。次回以降、main thread終了時に`session_id`と`transcript_path`から自動記録される。

## 判定境界

起動の正本は、assistantが発行したtool call内にある`<skill-name>/SKILL.md`の読込とする。単なる会話中の言及や、起動宣言だけでは起動として数えない。

Codexのtranscript形式は安定APIではない。未認識行は無視し、hookは3秒以内に終了する。LLMをhook内から呼ばない。SessionEndが発火しなかった異常終了は集計対象外になる。
