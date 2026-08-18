# 介入方式の設計で仮説整理を飛ばす

## Observation

- Source observation: `benchmarks/observations/intervention-design-skipped-hypothesis-framing.md`
- Failure summary: AIの困りごとをAGENTS.mdかskillで改善する依頼に対し、原因仮説を整理せず併用案へ収束した。
- Why it matters: 介入の必要性と種類を比較できず、測定できないルールを増やす可能性がある。

## Competing hypotheses

### H1: hypothesis-framingのtriggerにAI改善の自然な依頼が含まれていない

- Mechanism: descriptionは問題解決・設計判断・障害分析を抽象語で示すが、「AIの生成物に困り、AGENTS.mdやskillで再発防止する」という自然な依頼を明示していない。
- Prediction if true: この具体的な利用場面をdescriptionへ追加すると、同じtaskで`hypothesis-framing`が2/3回以上読み込まれる。
- Evidence against: 現descriptionにも「設計判断」「そもそも何が問題か」があり、意味上は対象に含まれる。

### H2: モデルはskillなしでも併用案を作れるため、追加workflowを不要と判断する

- Mechanism: taskの成果物だけなら直接設計できるため、最小skill選択が仮説整理を省く。
- Prediction if true: `hypothesis-framing`のdescriptionを直接明確にしても読み込みは1/3回以下のままになる。
- Evidence against: ユーザーが求めたのは結論だけでなく、介入を選ぶ前の仮説検証である。

### H3: 他skillとの競合がhypothesis-framingを隠す

- Mechanism: `skill-creator`や`ai-dev-workflow`が「skillを作る」「仕組みを作る」により直接一致して先に選ばれる。
- Prediction if true: treatmentでもそれらだけが選ばれ、`hypothesis-framing`は増えない。
- Evidence against: fixed baselineの2/3回は競合skillも読まず、直接回答していた。

### H4: tool・配備状態がskill読込を妨げる

- Mechanism: runtime cloneまたはjunctionが古く、選ばれてもSKILL.mdを読めない。
- Prediction if true: 明示読込も失敗し、baselineの判定自体が無効になる。
- Evidence against: fixed baseline前にruntime `667ab1f`とjunction、SKILL.mdの実在を確認済み。

## Discriminating eval

- Start state: `hrtk91/personal-skills@667ab1f`のskill catalogを読み込んだfresh session。
- Task: `benchmarks/cases/intervention-design-should-trigger-hypothesis-framing.md`のtask。
- Keep fixed: `gpt-5.6-terra`、reasoning `medium`、tool権限、task、3 runs。
- Pilot A: `hypothesis-framing`のfrontmatter descriptionだけを変更し、自然起動するかを確認する。
- Treatment B: Pilot Aのdescriptionを維持して本文冒頭に停止条件を追加し、競合仮説と最小確認を先に示すかを確認する。
- Expected result by hypothesis: H1ならPilot Aで2/3回以上起動する。起動しても手順を飛ばすならTreatment Bで2/3回以上が停止条件を守る。H2/H3なら起動は1/3回以下。H4は明示読込確認で先に棄却する。

## Bare-model result

- Model / version: `gpt-5.6-terra`
- Reasoning: `medium`
- Runs: 3
- Result: 3回とも併用案を生成できたが、原因仮説と介入比較を行わず、`hypothesis-framing`は0/3回だった。対象はskill selectorのため、skillを完全に除いた条件ではなく現行descriptionをbaselineとした。

## Conclusion

- Supported hypothesis: H1を支持。具体的な利用場面をdescriptionへ追加すると読込は0/3から3/3へ改善した。ただしdescriptionだけのpilotでは3回とも改善案へ直行したため、本文冒頭の停止条件も必要だった。
- Rejected hypotheses: H4は棄却。H3単独原因も、最終treatmentが3/3で起動し、negative controlでは対象skillだけが起動したため弱い。H2は手順実行2/3へ改善したため単独原因ではない。
- Remaining uncertainty: 最終treatmentでも1/3は競合仮説を十分に示さず改善案へ進んだ。指示だけで100%保証できるとは扱わない。
- Next action: 今回のdescriptionと最初の返答の停止条件を採用し、日常利用の観測で手順実行率を継続確認する。
