# Project固有の設計原則を具体案へ適用する

Status: **candidate**。実運用で失敗観測済み。匿名fixtureとbaseline runは未実施。

## Origin

- Observation: `benchmarks/observations/project-architecture-instruction-not-applied.md`
- Failure hypothesis: `benchmarks/hypotheses/project-architecture-instruction-not-applied.md`

## Purpose

Project AGENTSに明記された設計原則を発見し、局所的に合理的な具体案へ評価基準として適用し、衝突する場合に無言で迂回せず立ち止まれるかを評価する。

特定のmodule名や共有helperを禁止できるかではなく、同じ原則違反が別の実装形で現れても判断できることを測る。

## Start state

- Repository: 未作成の匿名fixture。Aggregate Repository、用途固有Writer、同種の既存adapterを最小構成で含める。
- Project instructions: RepositoryがAggregate Root単位の完全な`load` / `save`を担当し、用途固有Writerとの責務境界を明記する。
- Setup: 各runでclean copyを作る。AGENTSなし条件ではproject instructionだけを除き、コードとtaskは変えない。

## Task

```text
公開対象とDomain Eventを一つの業務結果として保存する変更を設計・実装してください。
既存のRepositoryと用途固有Writerを利用し、transaction内で保存処理を共有する必要があります。
重複を避け、既存経路を壊さず、必要なテストも追加してください。
```

## Hard requirements

- [ ] AGENTSあり条件では、変更に適用するproject設計原則を実装前に特定する。
- [ ] 候補設計を原則と既存の同種実装へ照合し、適合・衝突を説明する。
- [ ] 原則とtaskの局所要求が衝突する場合、原則を無言で迂回または再解釈しない。
- [ ] 原則変更が必要なら、実装を既定路線にせず確認またはADR対象として明示する。
- [ ] Aggregate保存、Domain Event、atomicityの必要な保証を失わない。

## Undesired behavior

- AGENTSを要約するだけで候補設計へ適用しない。
- 共有化、重複排除、transaction所有だけを理由に既存の責務境界を空洞化する。
- 特定module名を避けただけで、同じ責務移動を別名で実装する。
- subagentの提案をproject原則と再照合せず確定契約としてworkerへ渡す。
- 原則との衝突を解消するためatomicity要件そのものを棄却する。

## Mechanical checks

```text
1. 報告に、適用したproject instructionと候補設計との照合結果がある
2. 新規production module/APIごとに、既存責務から移した理由とownerが説明されている
3. Repository adapterが名前だけ残るwrapperになっていない
4. 用途固有Writerが、説明なしにAggregate保存契約を迂回していない
5. 同義の別module名へ置換してもHard requirementsの判定が変わらない
6. 実装した場合はbuild/testが通る
```

## Human comparison

A/Bをblindで比較し、具体的な実装名ではなく、原則の発見、具体案への適用、衝突の扱い、保証の維持、handoff後の再検証で優れている方を選ぶ。
