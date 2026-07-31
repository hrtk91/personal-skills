# 研究ログのスキーマ

UTF-8のJSONを`.research/`配下へ保存する。artifactのパスは可能な限り相対パスにする。

## 設定

研究テーマは`.research/config.json`へ宣言する。IDはCLIやカードから参照する安定した
hyphen-case、`title`は人が読む表示名とする。

```json
{
  "schema": 1,
  "tracks": {
    "query-performance": {
      "title": "検索性能"
    },
    "result-quality": {
      "title": "結果品質"
    }
  },
  "source_documents": ["docs/research-notes.md"],
  "artifact_roots": ["artifacts/benchmarks"],
  "notes": "既存研究の参照先"
}
```

## 実験カード

```json
{
  "schema": 1,
  "id": "index-layout-v2",
  "date": "2026-07-27",
  "track": "query-performance",
  "question": "索引配置の変更により検索時間を短縮できるか",
  "status": "accepted",
  "context": ["既存方式ではランダムアクセスがボトルネックになった。"],
  "hypothesis": "読み取り単位を連続配置するとp95検索時間を短縮できる。",
  "prior_experiment_ids": ["index-layout-v1"],
  "method": ["固定workloadを既存配置と候補配置で実行する"],
  "evaluation": {
    "fixture": "search-workload-a",
    "baseline": {
      "experiment_id": "index-layout-v1",
      "fixture": "search-workload-a"
    },
    "metrics": ["p95_ms", "result_match_rate"],
    "acceptance": ["p95_ms <= 80", "result_match_rate == 1.0"],
    "stop_condition": "固定workloadを各方式で5回実行した時点で終了する。",
    "comparable": true,
    "comparability_note": "同じworkload、実行環境、測定器を使用する。"
  },
  "result": {
    "metrics": {"p95_ms": 74, "result_match_rate": 1.0},
    "artifacts": ["artifacts/benchmarks/index-layout-v2.json"]
  },
  "worked": ["連続配置でランダムアクセス回数を削減できた。"],
  "failed": ["大きすぎる読み取り単位ではメモリ使用量が採択条件を超えた。"],
  "limitations": ["workload 1種類のみ", "単一実行環境"],
  "next": ["配置を変更せず、別workloadで検証する。"]
}
```

実験の`status`には次を使う。

- `planned`
- `running`
- `accepted`
- `failed`
- `inconclusive`

`track`はconfigに登録済みのテーマIDを一つ指定する。意味のある比較対象がまだ存在しない
探索実験では`baseline`を`null`にできる。その場合は`comparable`を`false`にし、
`comparability_note`へ比較できない理由を残す。

## 方針カード

```json
{
  "schema": 1,
  "id": "fix-comparison-conditions",
  "tracks": ["query-performance", "result-quality"],
  "statement": "候補方式を比較するときは入力と測定環境を固定する。",
  "confidence": "high",
  "status": "active",
  "evidence_ids": ["index-layout-v1", "index-layout-v2"],
  "rationale": "条件が異なる測定値では方式による差を識別できない。",
  "scope": ["固定workload", "同一測定環境"],
  "counterevidence": []
}
```

`confidence`には`low`、`medium`、`high`を使う。`status`には`active`、
`provisional`、`retired`を使う。`tracks`には適用するテーマを一つ以上指定できる。
`scope`にはテーマ名ではなく、入力規模、実行環境、対象範囲など、その方針が成立する条件を
記録する。

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
