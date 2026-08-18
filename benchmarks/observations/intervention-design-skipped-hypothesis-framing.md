# 2026-08-18 介入方式の設計で仮説整理を飛ばした

- Task: AIがシステム動作・影響範囲・不変条件をユーザーへ説明する仕組みを考え、AGENTS.mdとpersonal skillのどちらがよいか検討する。
- Repository / commit: `hrtk91/personal-skills@667ab1f`
- Model / version: `gpt-5.6-terra`、reasoning `medium`
- Expected: 観測された困りごとを固定し、原因と介入候補を整理するために`skill-benchmark`から`hypothesis-framing`へ進む。
- Actual: fresh subagent 3回すべてで`skill-benchmark`と`hypothesis-framing`を読まず、0回または`ai-dev-workflow`だけを読み、直ちにAGENTS.mdとskillの併用案へ収束した。
- Why it matters: 原因を識別せず介入を選ぶと、skill追加が必要か、AGENTS.mdだけで足りるか、別の機械的保証が必要かを比較できない。
- Resolution: 未解決。現descriptionをbaselineとして固定し、介入方式の選択をtriggerへ追加したtreatmentを新規sessionで比較する。
- Severity: medium
- Related output or diff: baseline 3回の`loaded_skills`は`ai-dev-workflow`、なし、なし。元の実運用でも`hypothesis-framing`は未起動だった。
