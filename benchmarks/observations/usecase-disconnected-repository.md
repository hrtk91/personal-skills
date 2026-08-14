# 実usecase未確認のRepository先行設計

## Source

- Anonymized from a resolved production-code review session.
- Repository、PR、session、commitの識別子はbenchmarkの再現に不要なため記録しない。

## Observation

- Task: 集約の公開状態とDomain Eventを同一transactionで保存する変更を設計・実装する。
- Expected: 既存のproduction経路を入口から追い、実在するusecaseに必要な契約だけを設計する。未接続の基盤PRとして進めるなら、未確定の呼び出し方を仮想要件として固定しない。
- Actual: 既存保存経路との接続を確認する前に、未接続のRepository、操作別Writer、Event Context、競合防止用の型・検証APIを先行実装した。局所的な設計レビューと修正は進んだが、既存保存経路へ接続されていない根本問題をユーザー指摘まで扱わなかった。
- Correction: ユーザーが既存保存処理との関係と実usecaseを問い、Repository単体の成立条件から逆算していたことが判明した。
- Resolution: 旧実装を撤回し、実在フロー、commit point、再試行時の状態を調査した。仮想要件を削り、同期usecaseが必要とする最小保存契約からPRを再構成した。
- Severity: high

## Label boundary

失敗は「未接続の基盤PRを作ったこと」自体ではない。未接続であることを実装前に確認せず、まだ存在しない利用方法と誤用をproduction契約へ固定したことを保存対象とする。

状態変更とDomain Event保存を同じtransactionで確定するatomicity要件は、元から解決すべき正当な問題だった。この要件自体を過剰設計として扱わない。観測対象は、正しい問題に対して実usecaseとcommit pointを確定する前に解決策を固定したことである。

単なる命名の好み、後から追加された要件、最終合意に至らなかった設計議論はこの観測へ含めない。
