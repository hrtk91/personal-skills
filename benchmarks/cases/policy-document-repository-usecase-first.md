# PolicyDocument Repositoryを実usecaseから設計する

Status: **candidate**。assisted baselineで失敗再現済み。strict bare baselineは未実施。

## Origin

- Observation: `benchmarks/observations/usecase-disconnected-repository.md`
- Failure hypothesis: `benchmarks/hypotheses/usecase-disconnected-repository.md`

## Purpose

RepositoryやDomain Eventの形を先に完成させず、既存production経路と成立させる業務操作を確認してから、必要な保存契約だけを提案できるか評価する。

状態変更とDomain Event保存を同じtransactionで確定したい要求自体は、解決すべき正当なatomicity要件として扱う。このcaseが失敗とみなすのはatomicityを実現することではなく、状態変更を起こす実usecaseとcommit pointが未確定のまま、特定のRepository、API、状態、競合制御をproduction契約として先行固定することである。

## Start state

- Fixture: `benchmarks/fixtures/policy-document-repository-usecase-first/`
- Setup: fixtureを一時ディレクトリへコピーしてgit repositoryを初期化する。追加の会話履歴、元の実装、事後のユーザー訂正は与えない。

架空サービス「RuleShelf」は、社内規程を新規登録・改訂・外部カタログ同期し、社員へ現在有効な版を配信する。`PolicyDocument`は安定IDと公開中editionを持ち、`PolicyEdition`は不変snapshotである。詳細はfixtureの`docs/product-overview.md`を正とする。

元repositoryは観測事実の確認にのみ使い、benchmark実行には使わない。fixtureは既存のedition保存経路、新集約案、未接続のRepository計画だけを残した最小構成とする。

## Task

```text
PolicyDocumentの公開状態変更とDomain Eventを同じtransactionで保存したいです。
次のPRとしてPolicyDocument Repositoryと永続化処理を設計・実装してください。
既存の規程の新規登録・改訂・外部カタログ同期を壊さず、必要なテストも追加してください。
```

## Hard requirements

- [ ] 実装前に、既存の新規登録・改訂・外部カタログ同期についてhandlerからusecase、依存注入、persistenceまでproduction call pathを確認する。
- [ ] 新しいRepositoryが現在のproduction経路へ接続されるか、未接続の基盤になるかを明示する。
- [ ] 成立させる実在usecase、入力、成功時のcommit point、失敗時・再試行時に残してよい状態を説明する。
- [ ] 実在usecaseから必要性を説明できないAPI、型、状態、誤用防止処理をproduction codeへ追加しない。
- [ ] 未接続または業務契約が未確定なら、実装を既定路線にせず、必要な確認または用途固有の最小境界を提案する。

## Undesired behavior

- Repository、Event Store、Writerを作ること自体を目的として実装へ進む。
- testまたはADR内でしか利用されないproduction APIを、将来必要になるという理由だけで追加する。
- 仮想的な呼び出し順、stale値の組み合わせ、未存在usecaseを防ぐための型や検証関数を追加する。
- 命名、型安全性、transactionなど局所品質だけをreviewし、production未接続を見逃す。
- 「未接続のPRは常に禁止」と一般化する。
- atomicity要件そのものを不要または誤りとして棄却する。

## Mechanical checks

実行後の成果物と報告から次を確認する。

```text
1. production call pathとしてhandler / usecase / dependency injection / persistenceの実ファイルが列挙されている
2. 追加した公開APIごとにproduction利用箇所がある、または実装を保留している
3. testからしか参照されない新規production APIがない
4. git diffに仮想要件だけを根拠とする状態・error・wrapperがない
5. 実装した場合は既存の新規登録・改訂経路の回帰testが通る
```

## Assisted baseline reproduction

- Date: 2026-08-14
- Runs: 2
- Run 1 agent: `gpt-5.6-sol / low`、session `019ffe3c-9b50-7220-9395-704fc257f756`
- Run 2 agent: `gpt-5.6-sol / low`、session `01a0001d-a7bf-7e61-a8d8-f960429a9fbe`
- Run 2 support: explorer `gpt-5.6-sol / low`、architect `gpt-5.6-sol / xhigh`
- Codex CLI: `0.147.0`
- Intervention: このcase、事後の訂正、新しいskill指示は非提示。組み込みsubagentのhost instructionsは有効なためstrict bareではない。
- Result: **failure reproduced**
- Evidence:
  - 既存3経路と新しい集約型の未接続は実装前に発見した。
  - Run 1では、それでもcallerのない公開usecase、Repository、persistence adapter、DI、テストを追加した。
  - Run 2では、概要に公開条件と呼出usecaseが未決定だと明記しても、独立した公開入口とRepositoryを新設する方針を選んだ。実装開始前に評価を打ち切った。
  - したがって探索不足だけでなく、解決策ベースtaskに従って未確定のproduction契約を完成させる挙動を再現した。

これは2 runの識別結果であり、介入の採否にはbaseline / treatment各3 runを別途実施する。

## Human comparison

blind pairwiseで、次を優先して採用する。

1. 既存の実行経路と業務目的を原典で確認している。
2. 必要性が未確定なときに実装を保留できる。
3. 将来拡張性ではなく、現在のusecaseから契約を説明できる。
4. 過剰実装を避けつつ、atomicityや再試行の重大な欠落は残さない。
