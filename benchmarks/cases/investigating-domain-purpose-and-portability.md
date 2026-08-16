# investigating-domainの目的保持と構造非依存性

Status: **candidate**。旧版とPR #39版のbaseline / treatment比較用。

## Origin

- Observation: `investigating-domain`のWeb構造依存を外した際、業務ドメイン調査という目的まで一般的な実装調査へ広げてしまった。
- Failure hypothesis: プロジェクト固有の探索経路を削るだけでは、スキル固有の目的も失われる。業務知識として復元する対象と、一般的な実装調査との境界を明示する必要がある。

## Purpose

業務ドメイン調査では、リポジトリ構造を仮定せずに概念、関係者、ルール、状態遷移、不変条件、未決定事項を復元できるかを比較する。同時に、一般的なイベント処理の調査を業務ドメインへ無理に読み替えないか確認する。

## Start state

- Positive fixture: `benchmarks/fixtures/policy-document-repository-usecase-first/`
- Negative fixture: repository rootの`skills/skill-observation-recorder/`
- Baseline skill: `main`の`skills/investigating-domain/SKILL.md`
- Treatment skill: PR #39の`skills/investigating-domain/SKILL.md`
- 各runは過去会話、他runの出力、採点結果を渡さないfresh subagentで行う。
- モデル、推論設定、ツール権限、task、fixtureをbaseline / treatment間で固定する。

## Positive task

```text
指定されたinvestigating-domain skillを使って調査してください。
この規程公開ドメインでは、PolicyDocumentとPolicyEditionはそれぞれ何を表し、誰がどの条件で操作しますか。公開時に守るべき業務ルールと不変条件、現行実装で実現済み・未実現・未決定の範囲を、証拠位置付きで説明してください。変更はしないでください。
```

## Positive hard requirements

- [ ] RuleShelfを社内規程を社員へ配信するサービスと説明し、規程公開が現在有効な版の提供と切替履歴の監査を担うことを、個別の型より先に示す。
- [ ] `PolicyDocument`を同じ規程を束ねる安定IDと公開中editionの所有者として説明する。
- [ ] `PolicyEdition`を公開後に変更しない内容snapshotとして説明する。
- [ ] 規程管理者、社員、監査担当者の目的または操作を区別する。
- [ ] 公開版参照の更新とDomain Event保存を同一transactionで確定する不変条件を説明する。
- [ ] 新規登録、改訂、外部同期の既存3経路と`PolicyEditionPublisher`の関係を確認する。
- [ ] `PolicyDocument`とDomain Eventの型はあるが、既存3経路へ未接続であることを示す。
- [ ] 自動公開、承認公開、外部同期固有ルールが未決定であることを示す。
- [ ] 事実、推論、未確認を区別し、重要な主張へ証拠位置を付ける。

## Positive undesired behavior

- システムと対象業務の全体像を示さず、型や実装経路の説明から始める。
- Webのhandlerからpersistenceまでのcall pathだけを説明し、業務上の意味を統合しない。
- ADRや計画を実装済みの保証として扱う。
- 未決定の公開契機を推測で確定する。
- `pages/`や画面を必須の探索起点として要求する。

## Negative task

```text
指定されたinvestigating-domain skillがこの依頼へ適用されるか判断してください。
skill-observation-recorderのSessionEndから記録保存までの実行経路と、失敗時にどのqueue状態やartifactが残るか調査したいです。変更はしないでください。
適用範囲外なら、その理由と、代わりに必要な調査の種類だけを答えてください。
```

## Negative hard requirements

- [ ] 業務概念、業務ルール、権限、業務状態遷移の復元が主目的ではないと識別する。
- [ ] `investigating-domain`の適用範囲外と判断する。
- [ ] 必要なのはイベント起点の実行経路、queue状態、失敗・回復経路の実装調査だと示す。
- [ ] 対象コードを業務ドメインへ無理に読み替えない。

## Mechanical checks

Positiveは9件、Negativeは4件のhard requirementsをrunごとに0/1で採点する。根拠のない言及は得点に含めない。次も別に記録する。

- 事実誤認数
- 未確認事項を断定した数
- Web構造を必須とした数
- 業務知識ではなくcall pathの列挙が出力の中心になった数

## Comparison

- Baseline / treatmentを各3回実行する。
- Positiveはhard requirementsの合計と誤りを比較する。
- Negativeは適用範囲外という判断の再現率を比較する。
- treatmentがPositiveの必須条件を悪化させず、Negativeで3回とも適用範囲外を識別した場合に採用候補とする。
- 出力の読みやすさは条件名を伏せたA/Bで利用者に提示し、自動採点だけで決めない。
