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
| 1 | fail: `ai-dev-workflow`のみ | fail: skill読込なし |
| 2 | fail: skill読込なし | fail: skill読込なし |
| 3 | fail: skill読込なし | fail: skill読込なし |

agentへ初期catalogのdescriptionを引用させ、3回とも変更後descriptionを見ていたことを確認した。catalog cacheによる偽陰性ではない。

## Blind pairwise

| Pair | Choice | Reason |
| --- | --- | --- |
| 1 | 未実施 | treatmentで対象skillが起動せず、機械的な採用条件を満たさなかった |
| 2 | 未実施 | 同上 |
| 3 | 未実施 | 同上 |

出力品質を比較する前にtriggerの機械判定でrejectとなったため、blind pairwiseは採否に使用しなかった。

## Regressions

- 具体的な設計案のレビュー: `design-review`のみ起動し、`skill-benchmark`は起動しなかった。
- 局所的な誤字修正: skillは起動せず、`skill-benchmark`は起動しなかった。

## Decision

- [ ] adopt
- [x] reject
- [ ] inconclusive

理由: treatmentでも`skill-benchmark`は0/3で、事前に定めた2/3以上の採用条件を満たさなかった。negative controlへの過剰起動はなかったが、対象ケースを改善しないdescription変更は残さない。

この結果は「AIの困りごと」「AGENTS.md・skill・tool・testの選択」をdescriptionへ足すだけではselectorの判断を変えないことを示す。次の介入は文言をさらに広げる前に、既存の説明skillからbenchmarkへ委譲する方法か、AGENTS.mdで介入設計前の比較を必須にする方法を別条件として検証する。
