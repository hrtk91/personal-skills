# 症状を固定する前にBenchmarkの問いを整える

Status: **candidate**。実運用で失敗観測済み。匿名packetとbaseline runは未実施。

## Origin

- Observation: `benchmarks/observations/benchmark-case-overfit-to-symptom.md`
- Failure hypothesis: `benchmarks/hypotheses/benchmark-case-overfit-to-symptom.md`

## Purpose

実運用の一つの具体的な失敗からbenchmarkを作るとき、表面症状を直接禁止するcaseへ進まず、観測事実、競合原因、測りたい能力を分離できるか評価する。

## Start state

- Input packet: 未作成の匿名packet。同じproject原則に反する異なる二症状と、同じ表面症状だが違反理由が異なる対照観測を含める。
- Setup: case template、model、reasoning、tool権限を固定する。treatmentだけ`hypothesis-framing`を提示する。

## Task

```text
添付した実運用の失敗観測を、skillやAGENTS.mdの効果を比較できるbenchmark caseへ変換してください。
failure hypothesis、Hard requirements、Undesired behavior、Mechanical checksを作成してください。
```

## Hard requirements

- [ ] 観測事実と原因の解釈を分ける。
- [ ] 表面症状とは独立した、測りたい能力または判断を明示する。
- [ ] 少なくともmodel、context/instruction、task、skill、workflowを競合原因として検討する。
- [ ] 各仮説を見分けるため、一度に一変数だけ変えるevalを設計する。
- [ ] 同じ潜在原則に反する別症状にも合格条件を適用できる。
- [ ] 同じ表面症状でも原因が異なる対照例を誤って同一失敗にしない。

## Undesired behavior

- 観測に登場したmodule名、関数名、実装patternの禁止をPurposeにする。
- 介入したいskillの文言を先に決め、その正当化になるoracleを作る。
- 一つの結果でAGENTS、skill、modelの効果を同時に結論づける。
- 具体症状を一切検査しない、という逆方向の一般化をする。

## Mechanical checks

```text
1. Purposeが固有module名を含まず、能力または判断として書かれている
2. hypothesisごとに異なるpredictionと反証条件がある
3. Change onlyが一つの比較単位へ分割されている
4. Hard requirementsを類似症状へ置換しても成立する
5. 元症状は補助oracleとして追跡できる
```

## Human comparison

A/Bをblindで比較し、症状への忠実さではなく、原因の識別可能性、別症状への一般化、反証可能性、不要な介入を増やさない点で採用したい方を選ぶ。
