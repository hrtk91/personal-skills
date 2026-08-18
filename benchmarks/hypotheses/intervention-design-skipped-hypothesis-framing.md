# 介入方式の設計で仮説整理を飛ばす

## Observation

- Source observation: `benchmarks/observations/intervention-design-skipped-hypothesis-framing.md`
- Failure summary: AIの困りごとをAGENTS.mdかskillで改善する依頼に対し、原因仮説を整理せず併用案へ収束した。
- Why it matters: 介入の必要性と種類を比較できず、測定できないルールを増やす可能性がある。

## Competing hypotheses

### H1: skill-benchmarkのtriggerが実験用語へ寄りすぎている

- Mechanism: descriptionがbenchmark、eval、observationの作成を中心に書かれ、自然な「困っているので仕組みを考えて」が対象だと認識されない。
- Prediction if true: 介入方式を選ぶ自然文をdescriptionへ追加すると、同じtaskで`skill-benchmark`が2/3回以上読み込まれる。
- Evidence against: 現descriptionにもAGENTS.mdと実運用の失敗は含まれている。

### H2: モデルはskillなしでも併用案を作れるため、追加workflowを不要と判断する

- Mechanism: taskの成果物だけなら直接設計できるため、最小skill選択が仮説整理を省く。
- Prediction if true: descriptionを明確にしても読み込みは1/3回以下のままになる。
- Evidence against: ユーザーが求めたのは結論だけでなく、介入を選ぶ前の仮説検証である。

### H3: 他skillとの競合がskill-benchmarkを隠す

- Mechanism: `skill-creator`や`ai-dev-workflow`が「skillを作る」「仕組みを作る」により直接一致して先に選ばれる。
- Prediction if true: treatmentでもそれらだけが選ばれ、`skill-benchmark`は増えない。
- Evidence against: fixed baselineの2/3回は競合skillも読まず、直接回答していた。

### H4: tool・配備状態がskill読込を妨げる

- Mechanism: runtime cloneまたはjunctionが古く、選ばれてもSKILL.mdを読めない。
- Prediction if true: 明示読込も失敗し、baselineの判定自体が無効になる。
- Evidence against: fixed baseline前にruntime `667ab1f`とjunction、SKILL.mdの実在を確認済み。

## Discriminating eval

- Start state: `hrtk91/personal-skills@667ab1f`のskill catalogを読み込んだfresh session。
- Task: `benchmarks/cases/intervention-design-should-trigger-skill-benchmark.md`のtask。
- Keep fixed: `gpt-5.6-terra`、reasoning `medium`、tool権限、task、3 runs。
- Change only: `skill-benchmark`のfrontmatter description。
- Expected result by hypothesis: H1ならtreatmentで2/3回以上起動する。H2/H3なら1/3回以下。H4は明示読込確認で先に棄却する。

## Bare-model result

- Model / version: `gpt-5.6-terra`
- Reasoning: `medium`
- Runs: 3
- Result: 3回とも併用案を生成できたが、原因仮説と介入比較を行わず、`skill-benchmark`と`hypothesis-framing`は0/3回だった。対象はskill selectorのため、skillを完全に除いた条件ではなく現行descriptionをbaselineとした。

## Conclusion

- Supported hypothesis: H1を暫定支持。
- Rejected hypotheses: H4は棄却。H3単独原因は弱い。
- Remaining uncertainty: description変更後に実際のfresh sessionで起動するか。既知の設計レビューや局所修正へ過剰起動しないか。
- Next action: `skill-benchmark`のdescriptionだけを狭く変更し、positive 3回とnegative controlを実行する。
