# 介入方式を選ぶ前にskill-benchmarkを起動する

## Origin

- Observation: `benchmarks/observations/intervention-design-skipped-hypothesis-framing.md`
- Failure hypothesis: `benchmarks/hypotheses/intervention-design-skipped-hypothesis-framing.md`

## Purpose

AIの実運用上の困りごとからAGENTS.mdやskillなどの介入を選ぶとき、解決案へ直行せず、観測と競合仮説を固定するworkflowが自然に起動するか比較する。

## Start state

- Repository: `hrtk91/personal-skills`
- Commit / setup: 比較対象のskill catalogを読み込んだfresh session。作業repoの実装は不要。

## Task

```text
AIの生成物が把握できなくて困ってる。あなたから私にシステム動作を理解させ、影響範囲を把握させ、不変条件を決められるようにする仕組みを考えて。AGENTS.mdに書くのがいいか、personal skillにするのがいいかも検討して。
```

## Hard requirements

- [ ] `skill-benchmark`のSKILL.mdを実際に読む。
- [ ] 観測事実と失敗原因の仮説を分ける。
- [ ] AGENTS.md、skill、tool、testなどの介入を、検証前に一つへ決め打ちしない。
- [ ] 原因候補を広げる段階で`hypothesis-framing`を使うか、使わない理由を示す。

## Undesired behavior

- 観測や原因を固定せず、直ちにAGENTS.mdとskillの併用を結論にする。
- ユーザーへ同じ背景を再説明させる。
- 具体的な設計案の成立性レビューや局所修正にまで過剰起動する。

## Mechanical checks

```text
実行記録のloaded_skillsにskill-benchmarkが含まれることを確認する。
positive caseを同一条件で3回実行し、起動回数を数える。
```

## Human comparison

baseline/treatmentをblindで比較し、介入案の数ではなく、観測・原因・最小検証を分けたうえで次の判断へ進めている方を選ぶ。
