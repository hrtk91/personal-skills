# 観測された症状へ過適合したBenchmark設計

## Observation

- Source observation: `benchmarks/observations/benchmark-case-overfit-to-symptom.md`
- Failure summary: 原因仮説を整理する前に、観測された共有moduleを直接禁止・検出するcaseを提案した。
- Why it matters: treatmentがその固有症状だけを避けるよう学習され、同じ原則違反の別表現や別原因の同じ症状を識別できなくなる。

## Competing hypotheses

### H1: `hypothesis-framing`の起動漏れ

- Mechanism: case作成を単なる文書化と扱い、問いの再設定と競合仮説の整理をせず、最初に思いついた症状を評価対象にした。
- Prediction if true: 同じ観測に`hypothesis-framing`を適用した条件では、症状、潜在原則、原因候補を分離したcaseになる。
- Evidence against: skillなしでも複数観測から共通原則と識別evalを安定して作れるなら、起動追加は不要である。

### H2: 直前の具体語によるanchoring

- Mechanism: 原因分析の直前まで特定moduleを議論していたため、その名前と構造をbenchmarkのoracleへ写した。
- Prediction if true: 会話履歴から具体的な解決案を除いた同一taskでは、skillなしでも潜在原則を抽出できる。
- Evidence against: 履歴を除いても症状を直接禁止するcaseへ収束するなら、anchoringだけでは説明できない。

### H3: Case templateの抽象化支援不足

- Mechanism: 現templateはHard requirementsとUndesired behaviorを要求するが、観測された症状と測りたい能力を分ける欄がなく、具体的な禁止条件へ寄りやすい。
- Prediction if true: skill起動だけでなく、`Observed symptom`と`Underlying capability`を分けるtemplateで複数担当の成果が改善する。
- Evidence against: templateを変えず`hypothesis-framing`だけで安定するなら、template変更は不要である。

### H4: Model固有の抽象化不足

- Mechanism: 特定modelが一つの実例から、反事実でも成立する評価対象へ一般化できない。
- Prediction if true: task、履歴、skill、templateを固定しmodelだけを変えたとき、症状への過適合率が変わる。
- Evidence against: model差よりskillまたは履歴の有無で結果が変わるなら、modelだけの問題ではない。

## Discriminating eval

- Start state: 一つの設計原則に反する異なる二症状と、同じ表面症状だが違反理由が異なる対照観測を含む匿名packet。
- Task: 観測からfailure hypothesisとbenchmark caseを作る。
- Keep fixed: packet、model、reasoning、tool権限、case template。
- Change only: 最初に`hypothesis-framing`なし／あり。その後、会話履歴の具体案なし／あり、template変更なし／あり、model差を別比較にする。
- Expected result by hypothesis: H1はskill、H2は具体案を含む履歴、H3はtemplate、H4はmodel変更で主に改善する。

## Bare-model result

- Model / version: 未実施
- Reasoning: 今回は一つの実運用観測でskill未起動時の失敗が一度観測されたのみで、再現率は不明。
- Runs: 0
- Result: 未実施

## Conclusion

- Supported hypothesis: 現観測はH1とH2に整合する。
- Rejected hypotheses: なし。
- Remaining uncertainty: 独立したpacketでも再現するか、template自体の影響、model差。
- Next action: candidate caseとして固定し、まずskillなし／ありだけを各3run比較する。再現しなければskill変更へ進まない。
