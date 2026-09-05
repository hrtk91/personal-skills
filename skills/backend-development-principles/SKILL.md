---
name: backend-development-principles
description: バックエンドの責務、依存方向、DIとport、外部境界、状態の所有を設計・実装・レビューする際に使う。
---

# バックエンド開発

バックエンドは、業務上の意味を外部技術から隔離し、境界を契約として扱う。`adapter`、`usecase`、`domain`は固定の雛形ではなく、変更理由と依存方向を分けるための基本層とする。

## レイヤーと依存方向

依存は外側から内側へ向ける。基本形は次のとおり。

```text
入口(adapter) → usecase → domain
                 └─ calls ─→ port契約 ←─ implements ─ 出口(adapter)
```

- `domain`: 業務ルール、不変条件、状態遷移、Value ObjectやAggregateを置く。外部I/Oを持たず、副作用のない処理を主体にする。HTTP、DB、OS、フレームワーク、wire形式を知らない。
- `usecase`: 一つの業務操作や業務フローを進める。Domainの操作とportを呼び、処理順序、業務上の結果、必要な整合性の単位を調整する。HTTPのdecodeやSQLの組み立ては担当しない。
- `adapter`: HTTP、CLI、TCP、DB、filesystem、外部サービスなどの外部詳細を扱う。外部表現の変換、保存、portの実装、外部エラーの変換を担当し、業務ルールや中心状態の遷移を所有しない。

`domain`や`usecase`から具体的なadapterへ逆依存させない。portは、呼び出し側が必要とする最小の能力の契約として、内側の層で定義する。portの配置場所は言語や既存規約に合わせてよいが、具体実装へ依存する方向は変えない。

## DIと具象依存の組み立て

UseCaseが必要とする外部能力は、UseCase側が定義した狭いportとして明示的に受け取る。portは「何ができるか」を表す契約であり、DIはcomposition rootがその具象実装を供給する仕組みである。具体的なadapter型をUseCaseへ渡すことや、UseCase・Domainが実行時に依存を探すことを基本にしない。

DB接続、外部client、clock、ID生成器、workerなどの具象依存は、アプリケーションの起動入口やhostに集約して生成・接続・注入する。依存の生成が複雑ならfactoryをcomposition rootの組み立て補助として使ってよいが、UseCaseやDomainからfactory、global registry、service locatorを呼ばない。テストでは、必要なportだけをFakeやStubへ差し替えられるようにする。

portは外部clientのAPIをそのまま写すのではなく、UseCaseが必要とする能力と失敗を表す。読み取り、集計、検索、command側の保存など、必要な能力や整合性が異なる場合は、一つの大きなRepositoryへまとめず分ける。

## UseCaseへ渡す値とportで取得する値

UseCaseへの依存注入と、入口adapterからの入力渡しを混同しない。

- 入口adapterから渡す: 外部形式を境界で変換したcommand・入力値・認証主体など、呼び出し時点で確定した値
- UseCaseがportで取得する: 業務判断やmutationに必要な現在の正本状態、外部サービスの結果、時刻、IDなど、処理の責任をUseCaseが持つ値や能力

mutationでは、adapterが先にDBなどから正本状態を読み、具体的な結果をUseCaseへ渡すことを原則にしない。UseCaseがportを通して取得し、読み込みから保存までの整合性・競合検出をportの契約で保証する。read-only queryや、鮮度・整合性が契約で保証されたsnapshotを扱う場合は、値を引数で受け取ってよい。どちらを選ぶ場合も、取得責任と状態の所有者を説明できるようにする。

## 境界で型とエラーを変換する

外部payload、wire DTO、HTTP status、SQL row、serialization型をDomainやUseCaseへ横流ししない。

- 入口adapterで形式をdecodeし、認証・入力形式のエラーを境界で扱い、内部の入力型へ変換する。
- Domainで業務上の妥当性と不変条件を検証する。handlerの分岐やpersistenceの部分更新へ業務ルールを重複させない。
- 出口adapterで内部の結果・業務エラーを外部のresponse・status・保存形式へ変換する。
- 境界を越える値は、その境界の契約に必要な型として定義する。外部の表示文言や保存形式を中心層の型にしない。

## 状態、失敗、再実行を契約にする

可変な業務状態の正本と所有者を一つに定め、状態を変更する操作をDomainの許可された遷移またはUseCaseの調停へ集約する。読み取り操作が状態遷移やresource回収を暗黙に始めないようにする。

非同期処理、タイムアウト、イベント、再送、部分失敗がある場合は、次を業務契約として明示する。

- 受付中、処理中、完了、失敗などの中間・終端状態
- 完了通知の順序、重複、欠落への扱い
- 同じmutationを再送できるか、できるなら冪等性keyや競合検出をどうするか
- 同時に成立すべき状態と記録の確定単位、rollback、cleanup

すべてのAPIへ冪等性やtransactionを一律に追加するのではなく、再送や部分失敗が起きる境界で必要性を判断する。

## 最低限の確認

- Domainの不変条件とUseCaseの業務フローが、具体的な外部技術なしで説明・テストできる
- `UseCase`の依存が狭いportで明示され、具象依存の生成・選択がcomposition rootまたはそこから呼ぶfactoryに閉じている
- 入口adapterからは境界変換済みの入力を受け、mutationの正本状態はUseCaseがportで取得する。値を直接渡す例外では鮮度・整合性の所有者を説明できる
- 各境界で入力、出力、エラーを内部契約へ変換し、DTOや表示表現を横流ししていない
- 可変状態の正本と所有者、許可された遷移が一つに定まっている
- 非同期・再送・部分失敗がある場合、重複実行、途中状態、rollback、cleanupをテストしている
- 純粋なDomain／UseCaseのテストと、実際の外部境界を確認する統合テストを組み合わせている。バックエンド全体をモック化することを目的にしない
