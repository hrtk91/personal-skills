---
name: skill-observation-recorder
description: Codexセッション中にユーザーから受けた実装・設計・レビューへの訂正を、セッション終了後に非同期で抽出して蓄積する。普段の開発からbenchmark候補となる失敗事例を残すために使う。
---

# Skill observation recorder

普段のCodex利用から、AIの判断や作業方法に対するユーザー訂正をバックグラウンドで蓄積する。

SessionEnd hookでは解析せずqueueへの登録だけを行う。別processがtranscriptを読み、**訂正後に設計・修正・実装まで進み、解決した事例だけ**を `~/.codex/skill-observations/observations/` に保存する。

解析には既定で `codex exec` を使う。解析用CodexのSessionEndは再帰的に記録せず、modelを固定したい場合だけ `SKILL_OBSERVATION_MODEL` を指定する。

長時間sessionでは末尾だけを切り出さず、message境界で複数chunkへ分割して全体を走査する。隣接chunkは一部messageを重ね、chunk境界付近の訂正と解決を拾えるようにする。最後に候補を統合し、重複した観測を一件へまとめる。

保存対象:

- 実装・設計・レビュー・調査方法についてユーザーがAIの判断を訂正した
- 同種の別タスクでも起こりうる失敗である
- その後の会話で期待する判断や実装が具体化し、解決まで進んだ

保存しない:

- 単なる追加要件や仕様変更
- タイポや一度限りの表記修正
- ユーザーの好みが途中で変わっただけのもの
- 訂正後も結論が出ていないもの

このrecorderは**ground truthではなくbenchmark候補を作る推定器**として扱う。観測だけを行い、失敗原因の決定、skill変更、benchmarkへの自動昇格は行わない。

保存された観測は、必要に応じて次の順に扱う。

1. 人間が観測事実として妥当か確認する。
2. `benchmarks/observations/` へ採用する。
3. 再発または高重要度なら `benchmarks/hypotheses/` で複数の失敗原因を検討する。
4. bare modelで原因を識別し、再現したものだけ固定benchmark caseへ進める。

## recorder自体の校正

recorderが重要な訂正を取りこぼすと、後段のbenchmark corpus自体が偏る。analyzerのmodelやpromptを変更するとき、または定期的な健全性確認では、full transcriptを人間が読んで保存対象をラベルした小さな集合と比較する。

最低限、次を見る。

- precision: recorderが保存した観測のうち、本当に保存対象だった割合
- recall: 人間が保存対象とした訂正のうち、recorderが拾えた割合
- high-severity false negative: 重要な訂正の取りこぼし
- classification error: 追加要件、好み、未解決議論の誤保存
- severity agreement: 重要度の大きな不一致

recorderの出力件数が増えたこと自体を改善とみなさない。precisionを大きく落としてrecallだけを上げる変更も採用しない。

最低限の分類回帰は `benchmarks/cases/observation-recorder-smoke.md` で確認する。これは実sessionを使ったprecision / recall校正の代替にはしない。

## 導入

```bash
node ~/.codex/skills/skill-observation-recorder/scripts/install-hook.mjs
```

Codexのhook一覧で追加内容を確認する。

最近の観測:

```bash
node ~/.codex/skills/skill-observation-recorder/scripts/list.mjs
```

過去のCodex transcriptを分析対象へ追加する:

```bash
node ~/.codex/skills/skill-observation-recorder/scripts/session-end-hook.mjs \
  --transcript ~/.codex/sessions/<date>/rollout-<session>.jsonl \
  --session-id <session-id> \
  --cwd <original-working-directory> \
  --foreground
```

PR番号だけから会話は復元できない。対象PRを作ったsessionのtranscriptを指定する。`--session-id` は省略できるが、同じtranscriptを再投入するときの識別と上書き防止のため指定を推奨する。
`--cwd` は元sessionの作業ディレクトリを記録する。`--foreground` はworkerの完了を待ち、Codexの初期化・認証・sandbox errorをその場で確認できるため、手動backfillでは指定を推奨する。通常のSessionEnd hookは引き続き非同期で動作する。
foregroundの待機上限は既定15分で、必要な場合だけ `SKILL_OBSERVATION_FOREGROUND_TIMEOUT_MS` で変更する。待機上限を超えても解析workerは中断せず、後からqueueの`done`または`failed`へ結果を残す。

実装変更後の回帰確認:

```bash
node --test ~/.codex/skills/skill-observation-recorder/scripts/test/recorder.test.mjs
```

## 保存先

```text
~/.codex/skill-observations/
├── queue/{pending,processing,done,failed}/
├── observations/<YYYY-MM-DD>/<session_id>-<job_id>.json
└── logs/worker.log
```

workerが途中終了して `processing/` にjobが残った場合は、次回起動時に `pending/` へ戻して再処理する。
