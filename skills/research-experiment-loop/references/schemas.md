# 研究ログのスキーマ

UTF-8のJSONを`.research/`配下へ保存する。artifactのパスは可能な限り相対パスにする。

## 実験カード

```json
{
  "schema": 1,
  "id": "minutes-atomic-topic-v10",
  "date": "2026-07-27",
  "question": "アトミックトピックで議題への所属判定を改善できるか",
  "status": "accepted",
  "context": ["長いブロックには複数の独立した判断軸が含まれる。"],
  "hypothesis": "提案アンカーと保守的なグルーピングにより過剰結合を減らせる。",
  "prior_experiment_ids": ["minutes-one-shot-clustering"],
  "method": ["最小単位の主張を抽出する", "提案の組み合わせを判定する"],
  "evaluation": {
    "fixture": "qmsum-es2004a-ja",
    "baseline": {
      "experiment_id": "minutes-two-pass",
      "fixture": "qmsum-es2004a-ja"
    },
    "metrics": ["proposal_recall", "topic_f1", "over_merge"],
    "acceptance": ["proposal_recall >= 0.8", "over_merge == 0"],
    "stop_condition": "固定fixtureの採点が完了した時点で終了する。",
    "comparable": true,
    "comparability_note": "同じfixtureと採点器を使用する。"
  },
  "result": {
    "metrics": {"proposal_recall": 1.0, "topic_f1": 0.718},
    "artifacts": ["dist/eval/result.json"]
  },
  "worked": ["提案の再抽出により欠けていたアンカーを検出できた。"],
  "failed": ["自由クラスタリングは独立した判断軸を過剰結合した。"],
  "limitations": ["会議1件のみ", "CPUフォールバック"],
  "next": ["ルールを変更せず、別の会議で検証する。"]
}
```

実験の`status`には次を使う。

- `planned`
- `running`
- `accepted`
- `failed`
- `inconclusive`

## 方針カード

```json
{
  "schema": 1,
  "id": "do-not-union-whole-blocks",
  "statement": "共通する小トピックが一つあるだけで、ブロック全体を結合しない。",
  "confidence": "high",
  "status": "active",
  "evidence_ids": ["minutes-pair-structure", "minutes-atomic-topic-v10"],
  "rationale": "長いブロックには複数の独立した判断軸が含まれる。",
  "scope": ["meeting-minutes", "long-context"],
  "counterevidence": []
}
```

`confidence`には`low`、`medium`、`high`を使う。`status`には`active`、
`provisional`、`retired`を使う。

## スキル評価カード

```json
{
  "schema": 1,
  "id": "research-experiment-loop-v1",
  "date": "2026-07-27",
  "skill_version": "1",
  "cases": ["prior-failure-retrieval", "comparability-gate", "self-critique"],
  "rubric": ["関連する過去実験を取得できる", "比較可能性を判定できる", "根拠を追跡できる"],
  "result": {"passed": true, "score": 6, "maximum": 6},
  "failures": [],
  "changes": ["初版を作成した。"],
  "next": ["別プロジェクトでforward-testする。"]
}
```
