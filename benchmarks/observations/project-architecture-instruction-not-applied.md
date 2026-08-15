# Project固有の設計原則を設計判断へ適用しなかった

## Source

- Anonymized from a resolved production-code design and review session.
- Repository、PR、session、commitの識別子はbenchmarkの再現に不要なため記録しない。

## Observation

- Task: Aggregateの状態、snapshot、Domain Eventを一つの業務結果として保存する投稿処理を設計・実装する。
- Given instruction: Project AGENTSには、RepositoryがAggregate Root単位の完全な`load` / `save`を担当すること、複数対象を同一transactionで確定する処理は用途固有Writerへ置くこと、変更前に既存実装と設計原則を確認することが明記されていた。
- Expected: 設計案をproject固有の原則と既存の同種実装へ照合し、衝突する案は確定前に止める。原則を変える必要があるなら、暗黙に迂回せず変更理由と影響を明示する。
- Actual: 設計reviewがAggregateの保存実装を共有persistence moduleへ移し、Repository adapterと用途固有Writerの双方から利用する案を提案した。main agentは既存Repository実装と原則を再照合せず確定案として後続agentへ渡し、Repository adapterがtransaction wrapperだけになる変更が実装された。
- Correction: ユーザーが、新しい共有moduleの名前ではなく、Repositoryの保存実装が既存の責務から外れていることを指摘した。
- Resolution: 実装修正を一時停止し、AGENTSの存在時期、size、override、subagentへの注入、設計reviewからworkerまでのhandoffを監査した。AGENTSは実装前から存在し、subagentにも全文が渡っていた。
- Severity: high

## Label boundary

特定のmodule名や`kernel`という語を禁止する観測ではない。保存helperの抽出が常に誤りとも扱わない。

保存対象は、project固有の設計原則が利用可能だったにもかかわらず、設計案の評価基準として適用せず、局所的に合理的な具体案を原則より優先したことである。subagentが提案したことだけでなく、main agentが原典と既存実装を確認せず確定契約へ昇格させたことも含む。
