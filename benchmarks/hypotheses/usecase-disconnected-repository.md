# 実usecase未確認のRepository先行設計

## Observation

- Source observation: `benchmarks/observations/usecase-disconnected-repository.md`
- Failure summary: 既存のproduction利用経路を確認せず、Repository単体の成立条件と仮想的な誤用からAPI・型・防御処理を先行設計した。
- Why it matters: 局所レビューを重ねても業務上使われない契約が洗練されるだけになり、広範な手戻りと恒久的な保守対象を生む。
- Invariant: 状態変更とDomain Event保存を原子的に確定する必要性は否定しない。識別したいのはatomicity要件の有無ではなく、実usecase未確定の段階で特定の解決策を固定する失敗である。

## Competing hypotheses

### H1: context探索の不足

- Mechanism: 実装前にhandler、usecase、依存注入、既存writerの呼び出し経路を検索しなかったため、追加Repositoryがproduction未接続だと認識できなかった。
- Prediction if true: task開始時にproduction call pathと接続点の提示を必須にすると、未接続を実装前に報告し、仮想契約を追加しない。
- Evidence against: call pathを把握した後でも、将来拡張を理由に同じ契約を選ぶなら探索不足だけでは説明できない。

### H2: taskとPR境界の曖昧さ

- Mechanism: 「RepositoryとEvent保存を追加する」という解決策ベースのtaskが、どのusecaseを成立させるかを要求していなかった。
- Prediction if true: taskを利用者・入力・成功時のcommit pointで記述すれば、追加する契約が縮小する。
- Evidence against: 解決策ベースのtaskでも、agentが既存利用箇所を自発的に調べて保留できるなら主因ではない。

### H3: DDDパターンの過剰適用

- Mechanism: Repository、Domain Event、楽観ロックの一般的な形を完成させることが目的化し、現在必要な業務操作より抽象の整合を優先した。
- Prediction if true: 接続有無を提示しても、将来の誤用防止や汎用性を理由に未使用の型・APIを追加する。
- Evidence against: call path確認だけで不要契約を追加しなくなるなら、モデル能力より探索手順の問題である。

### H4: review介入の局所最適化

- Mechanism: 命名、型安全性、transactionなど観点別reviewが、変更対象そのものが実usecaseに必要かを前提として扱った。
- Prediction if true: reviewを増やしても個々の契約は改善するが、production未接続は検出されない。
- Evidence against: 通常reviewだけで入口から利用経路を追い、PRの存在理由を反証できるならreview不足ではない。

### H5: tool・環境またはproject固有前提

- Mechanism: Stacked PRと未完了Issueの関係が複雑で、PR本文や差分だけでは元のrepository syncまで辿れなかった。
- Prediction if true: Issue、ADR、親子PRを同時に渡した場合だけ適切に判断できる。
- Evidence against: repository内の検索だけで未接続と元usecaseを復元できるなら、必要なcontextは利用可能だった。

## Discriminating eval

- Start state: `benchmarks/fixtures/policy-document-repository-usecase-first/`
- Task: `benchmarks/cases/policy-document-repository-usecase-first.md` のTaskを与える。
- Keep fixed: model、reasoning、repository、tool権限、task。
- Change only: 実usecase確認を要求する介入の有無。
- Expected result by hypothesis:
  - H1/H2: treatmentでproduction call pathを実装前に確認し、未接続と判断する。
  - H3: treatmentでも仮想的な型・APIを追加する。
  - H4: 通常review追加だけでは改善せず、目的・接続点を問う介入で改善する。
  - H5: Issue/PR情報を追加した条件でのみ改善する。

## Bare-model result

- Model / version: 未実施
- Reasoning: 組み込みsubagentではhost skillとrole指示を除外できず、今回のrunはstrict bare条件を満たさなかった。
- Runs: 0
- Result: 未実施

## Target-intervention-free assisted baseline

- Model / version: `gpt-5.6-sol`、Codex CLI `0.147.0`。
- Reasoning: main agentは`low`。このcase、事後情報、今回検討中の新しい介入は与えていない。fixtureは架空のRuleShelfだけで構成し、元repositoryの情報は与えていない。
- Runs: 2
- Result:
  - Run 1、session `019ffe3c-9b50-7220-9395-704fc257f756`: 既存3経路とRepository未接続を発見した後も、callerのない公開usecase、`PolicyDocumentRepository`、persistence adapter、DI、domain API、テストを追加した。
  - Run 2、session `01a0001d-a7bf-7e61-a8d8-f960429a9fbe`: product overviewで公開条件と呼出usecaseが未決定だと明記しても、既存3経路を変えず、独立した公開入口とRepositoryを新設する方針を選んだ。`gpt-5.6-sol / low` explorerと`gpt-5.6-sol / xhigh` architectを起動し、architect待ちで実装開始前に評価を打ち切った。

## Conclusion

- Supported hypothesis: assisted baselineではH2とH3に整合する挙動が出た。
- Rejected hypotheses: なし。strict bareと複数runが未実施のため棄却しない。
- Remaining uncertainty: strict bareでの再現率、複数runでの安定性、実usecase確認を明示するtreatmentの効果。
- Next action: benchmark case候補として固定し、実行基盤でhost skillを除外できるようにしてbaseline / treatmentを各3runで比較する。
