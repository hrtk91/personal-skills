# 介入方式の設計でskill-benchmarkを起動する / 2026-08-18

## Hypothesis

- Target failure: AIの困りごとから改善方法を考える依頼で、`skill-benchmark`と`hypothesis-framing`を使わず介入案へ直行する。
- Expected improvement: 自然な依頼文でも`skill-benchmark`が起動し、観測と原因仮説を分けてから介入を選ぶ。

## Decision rule

- Adopt if: positive caseで`skill-benchmark`が2/3回以上起動し、既知設計のレビューと局所的な誤字修正では起動しない。
- Reject if: positive caseが1/3回以下、またはnegative controlへ過剰起動する。

## Conditions

| | Baseline | Treatment |
| --- | --- | --- |
| Model / version | gpt-5.6-terra | gpt-5.6-terra |
| Reasoning | medium | medium |
| Skill | `skill-benchmark` current description | intervention-choice triggerを追加したdescription |
| Start state | fresh subagent、同一skill catalog | fresh session、更新後skill catalog |
| Runs | 3 | 3 |

## Mechanical results

| Run | Baseline | Treatment |
| --- | --- | --- |
| 1 | fail: `ai-dev-workflow`のみ | pending |
| 2 | fail: skill読込なし | pending |
| 3 | fail: skill読込なし | pending |

## Blind pairwise

| Pair | Choice | Reason |
| --- | --- | --- |
| 1 | pending | treatment実行後に判定する |
| 2 | pending | treatment実行後に判定する |
| 3 | pending | treatment実行後に判定する |

A/Bの対応は判定後に記録する。

## Regressions

- 重大な要件・既存ケースの悪化: 具体的な設計案のレビューは`design-review`、局所修正は通常処理のままにする。

## Decision

- [ ] adopt
- [ ] reject
- [x] inconclusive

理由: baselineは0/3で失敗を再現した。treatmentはskill catalog更新後のfresh sessionで実行する。
