# 2026-08-18 介入方式の設計で仮説整理を飛ばした

- Task: AIがシステム動作・影響範囲・不変条件をユーザーへ説明する仕組みを考え、AGENTS.mdとpersonal skillのどちらがよいか検討する。
- Repository / commit: `hrtk91/personal-skills@667ab1f`
- Model / version: `gpt-5.6-terra`、reasoning `medium`
- Expected: `hypothesis-framing`を使い、観測された困りごとと原因仮説を分けてから介入候補を選ぶ。
- Actual: fresh subagent 3回すべてで`skill-benchmark`と`hypothesis-framing`を読まず、0回または`ai-dev-workflow`だけを読み、直ちにAGENTS.mdとskillの併用案へ収束した。
- Why it matters: 原因を識別せず介入を選ぶと、skill追加が必要か、AGENTS.mdだけで足りるか、別の機械的保証が必要かを比較できない。
- Resolution: `hypothesis-framing`へAI改善の場面を直接追加し、本文冒頭で改善案より先に観測・競合仮説・最小確認を出す停止条件を追加した。fresh sessionでは読込3/3、手順実行2/3へ改善した。
- Severity: medium
- Related output or diff: baseline 3回の`loaded_skills`は`ai-dev-workflow`、なし、なし。元の実運用でも`hypothesis-framing`は未起動だった。
