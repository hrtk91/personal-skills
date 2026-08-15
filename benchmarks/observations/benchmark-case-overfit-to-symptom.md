# Benchmark caseを観測された症状へ過適合させた

## Source

- Anonymized from the follow-up discussion that converted `project-architecture-instruction-not-applied.md` into a benchmark proposal.
- 元の固有module名は、観測と訂正の境界を示すためだけに利用し、fixtureの評価条件にはしない。

## Observation

- Task: AGENTSに設計原則があったのに違反実装が作られた原因を、AGENTSなし／あり、skillなし／あり、model差で比較できるcaseとしてPR #37へ追加できるか検討する。
- Expected: 観測事実、表面症状、競合原因を分け、どの実装形でも共通して測れる能力を評価対象にする。
- Actual: main agentは最初に、共有persistence kernelを作る、Repository adapterを薄いwrapperにする、Writerがkernelを直接呼ぶ、という具体的な症状をcaseの中心にした。
- Correction: ユーザーが、本質はkernelの有無ではなく、AGENTSに書かれた設計原則を守らないことではないかと指摘した。
- Resolution: 評価対象を、project固有の原則を発見し、具体案へ適用し、衝突時に立ち止まれる能力へ変更した。kernelは一つの観測例に限定した。
- Severity: medium

## Label boundary

具体的な症状をMechanical checkへ含めること自体は失敗ではない。既知の回帰を確実に検出する補助oracleとしては有効である。

保存対象は、原因仮説を整理する前に症状を評価対象そのものへ昇格し、別の形で現れる同じ原則違反を測れないcaseを提案したことである。
