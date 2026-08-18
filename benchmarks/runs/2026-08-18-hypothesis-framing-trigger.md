# 介入方式の設計でhypothesis-framingを起動する / 2026-08-18

## Hypothesis

- Target failure: AIの困りごとから改善方法を考える依頼で、`hypothesis-framing`を使わず介入案へ直行する。
- Expected improvement: 自然な依頼文でも`hypothesis-framing`が起動し、問題設定と競合する原因仮説を整理してから介入を選ぶ。

## Decision rule

- Adopt if: positive caseで`hypothesis-framing`が2/3回以上起動し、競合仮説と最小確認を2/3回以上示し、既知設計のレビューと単純なskill作成では起動しない。
- Reject if: positive caseが1/3回以下、またはnegative controlへ過剰起動する。

## Conditions

| | Baseline | Pilot A | Treatment B |
| --- | --- | --- | --- |
| Model / version | gpt-5.6-terra | gpt-5.6-terra | gpt-5.6-terra |
| Reasoning | medium | medium | medium |
| Skill | 現行description | AI改善の直接triggerだけ | 直接trigger + 最初の返答の停止条件 |
| Start state | fresh subagent、同一skill catalog | fresh subagent、更新後skill catalog | fresh subagent、更新後skill catalog |
| Runs | 3 | 3 | 3 |

## Mechanical results

| Run | Baseline | Pilot A | Treatment B |
| --- | --- | --- | --- |
| 1 | fail: `ai-dev-workflow`のみ | trigger pass / workflow fail | trigger pass / workflow fail |
| 2 | fail: skill読込なし | trigger pass / workflow fail | trigger pass / workflow pass |
| 3 | fail: skill読込なし | trigger pass / workflow fail | trigger pass / workflow pass |

Pilot AとTreatment Bは3回とも`hypothesis-framing`を読み込んだ。agentへ初期catalogのdescriptionを引用させ、変更後descriptionを見ていたことも確認した。

subagent実行では永続的なsession IDが返らないため、各runの観測根拠をこのファイルに残す。

| Run | 実行識別子 | 判定根拠 |
| --- | --- | --- |
| Baseline 1 | `baseline-1` | `loaded_skills: ai-dev-workflow`。AGENTS.mdとskillの併用案へ直行 |
| Baseline 2 | `baseline-2` | `loaded_skills`なし。AGENTS.mdとskillの併用案へ直行 |
| Baseline 3 | `baseline-3` | `loaded_skills`なし。AGENTS.mdとskillの併用案へ直行 |
| Pilot A 1-3 | `description-only-1..3` | 全runで`loaded_skills: hypothesis-framing`。全runで競合仮説と最小確認より先に改善案を選択 |
| Treatment B 1 | `/root/hypothesis_gate_1` | `loaded_skills: hypothesis-framing`。事実と推測は分けたが、競合する原因候補を比較せず併用案を選択 |
| Treatment B 2 | `/root/hypothesis_gate_2` | `loaded_skills: hypothesis-framing`。競合する3つの見方と最小確認を示してから配置案を提示 |
| Treatment B 3 | `/root/hypothesis_gate_3` | `loaded_skills: hypothesis-framing`。別の問い、3つの原因候補、候補ごとの最小確認を示してから提案 |

## Blind pairwise

| Pair | Choice | Reason |
| --- | --- | --- |
| 1 | baseline相当 | 両方とも改善案へ直行し、競合仮説を十分に示さなかった |
| 2 | treatment | 競合する見方と最小確認を先に示した |
| 3 | treatment | 別の問い、原因候補、候補ごとの最小確認を先に示した |

機械的なhard requirementを先に判定したため、文章の好みではなく、競合仮説と最小確認の有無で比較した。

## Regressions

- 具体的な設計案のレビュー: `design-review`のみ起動し、`hypothesis-framing`は起動しなかった。
- 単純なskill作成: `skill-creator`のみ起動し、`hypothesis-framing`は起動しなかった。

## Invalid pilot

最初の試行では`skill-benchmark`のdescriptionを変更し、起動0/3だった。この試行は`hypothesis-framing`の自然起動という元の問いを検証していないため、treatmentには数えない。

`hypothesis-framing`へ直接triggerだけを追加したpilotは読込3/3だったが、3回とも改善案へ直行した。そこで本文冒頭へ「最初の返答では解決案を決めず、観測・競合仮説・最小確認を先に示す」停止条件を追加し、最終treatmentとした。

## Decision

- [x] adopt
- [ ] reject
- [ ] inconclusive

理由: 最終treatmentは読込3/3、手順実行2/3で採用条件を満たし、negative controlへの過剰起動もなかった。1/3は手順を十分に守らなかったため、完全保証ではなく日常利用で継続観測する。
