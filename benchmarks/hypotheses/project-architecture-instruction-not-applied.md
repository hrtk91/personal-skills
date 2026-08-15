# Project固有の設計原則を適用しない原因

## Observation

- Source observation: `benchmarks/observations/project-architecture-instruction-not-applied.md`
- Failure summary: AGENTSの設計原則がsubagentを含む全担当へ渡っていたが、具体的な設計案の生成・採否・handoffで評価基準として使われなかった。
- Why it matters: 指示文を追加しても適用工程がなければ、局所品質の高い原則違反が実装・reviewを通過する。

## Competing hypotheses

### H1: Project instructionの発見不足

- Mechanism: AGENTSがcontextに存在しても、変更に関係する規則を想起できず通常の設計知識だけで判断した。
- Prediction if true: AGENTSなしとありで結果が変わらず、判断直前に該当規則を提示した条件で改善する。
- Evidence against: 実sessionではAGENTS全文が注入されていた。ただし、contextに存在することは推論時の想起を保証しない。

### H2: 原則から評価基準への変換不足

- Mechanism: 規則を読めても、候補設計ごとの適合・違反を照合する工程がなく、具体的で局所的に合理的な案を優先した。
- Prediction if true: 同じ原則をAGENTSへ置くだけでは不安定だが、適用規則の列挙と候補案ごとの照合を要求するskillで改善する。
- Evidence against: AGENTSだけの複数runで一貫して原則を適用できるなら、追加手順は不要である。

### H3: 具体案へのsolution fixation

- Mechanism: taskまたは設計reviewが先に共有案を提示したため、目的と原則から案を作り直さず、その案の実現方法だけを最適化した。
- Prediction if true: AGENTS、model、task目的を固定しても、具体案を先に与えた条件だけ違反が増える。
- Evidence against: 具体案を提示しない条件でも同じ種類の原則違反を自発的に作るなら、fixationだけでは説明できない。

### H4: Delegated handoffによる再検証責任の消失

- Mechanism: design-reviewの未検証案がmainによって確定契約へ変換され、後続のexplorerとworkerはproject原則よりhandoffを優先した。
- Prediction if true: 単一agent完結より、design-review→main→worker条件で違反が増える。各subagentへAGENTSを注入するだけでは改善しない。
- Evidence against: 単一agentでも同率で違反するなら、delegationは主因ではない。

### H5: Model固有のinstruction utilization不足

- Mechanism: 特定modelまたはreasoning設定が、長いproject instructionから関連規則を選び具体案へ適用する能力を十分に持たない。
- Prediction if true: task、AGENTS、skill、agent topologyを固定し、modelだけを変えた比較で再現率が変わる。
- Evidence against: model間差より、照合手順または具体案提示の有無で結果が変わるなら、model routingだけでは解決しない。

## Discriminating eval

- Start state: 同種のRepositoryと用途固有Writerが存在し、Project AGENTSに保存境界の原則を持つ匿名fixture。
- Task: atomicityと重複排除を求めるが、具体的な実装名を正解・不正解として指定しない設計変更。
- Keep fixed: task、fixture、model、reasoning、tool権限、開始状態。
- Change only:
  1. AGENTSなし／あり。
  2. AGENTSあり／AGENTSありかつ判断直前に該当規則を再掲。
  3. AGENTS、model、task目的を固定し、具体案の先行提示なし／あり。
  4. AGENTSありのまま、原則照合手順なし／あり。比較前に手順の文面を固定する。
  5. 同条件で単一agent／delegated workflow。
  6. 最後に同条件でmodelだけを変更する。
- Expected result by hypothesis: H1は規則の直前再掲、H2は固定した照合手順、H3は具体案の先行提示、H4はtopology、H5はmodel変更で主に結果が変わる。

## Bare-model result

- Model / version: 未実施
- Reasoning: strict bareではAGENTS自体がないため、project固有規則の遵守を合否にせず、既存同種実装から境界を推測する傾向だけを観測する。
- Runs: 0
- Result: 未実施

## Conclusion

- Supported hypothesis: 現観測はH2、H3、H4に整合する。
- Rejected hypotheses: H1のうち「AGENTSがsubagentへ渡らなかった」は監査で棄却した。想起不足は未棄却。
- Remaining uncertainty: 各条件の再現率、単一agentとの差、model差。
- Next action: 匿名fixture、条件ごとの採点基準、実行手順を作る。AGENTSなし条件ではproject固有規則の遵守を採点せず、全条件共通の保証とAGENTSあり条件だけの保証を分ける。再現可能な開始状態が完成した後にcandidate caseへ進む。
