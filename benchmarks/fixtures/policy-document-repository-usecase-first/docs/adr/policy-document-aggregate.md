# PolicyDocument aggregate

RuleShelfの利用者、現在の経路、解決したい問題は`../product-overview.md`を正とする。

RuleShelfでは、`PolicyDocument`が安定したIDと現在公開中のeditionを所有する。`PolicyEdition`は公開後に変更しない内容snapshotである。公開状態の変更とDomain Eventは同じtransactionで確定する。

次の変更候補は`PolicyDocumentRepository`とEvent永続化である。
