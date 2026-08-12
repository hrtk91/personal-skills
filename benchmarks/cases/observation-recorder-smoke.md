# Observation recorder classification smoke

## Origin

- Observation: `skill-observation-recorder` 自身の誤検出・取りこぼしがbenchmark corpusを偏らせる可能性
- Failure hypothesis: analyzerが「AI判断への訂正」と追加要件・好み・未解決議論を十分に区別できない

## Purpose

`skill-observation-recorder` のanalyzerが、保存すべきAI失敗と保存しない会話を最低限区別できるかを見るsmoke case。

これは実運用sessionに対するprecision / recall校正の代替ではない。analyzerのpromptやmodel変更時に、明白な分類回帰を安く検出するために使う。

## Start state

以下の6会話を互いに独立したsessionとしてanalyzerへ渡す。実装詳細に依存しないよう、会話本文だけで判定する。

## Task

各sessionについて、`skill-observation-recorder` と同じ保存基準で再利用可能なAI失敗を抽出する。保存対象がなければ空配列とする。

### Session A: 上位transactionの見落とし

```text
USER: このusecaseに更新処理を追加して。
ASSISTANT: repository側でtransactionを開始する実装にしました。
USER: そこでは張らないで。呼び出し側のusecaseですでにtransactionを所有していて、二重に境界を作るとatomicityが崩れる。既存の呼び出し経路を確認して。
ASSISTANT: 呼び出し側を確認しました。repository側のtransaction開始を削除し、既存境界内で更新するよう修正しました。testも通りました。
```

Expected: **save**。AIが既存contextを調べずtransaction ownershipを誤判断し、その後に修正・検証まで完了している。

### Session B: 単なる追加要件

```text
USER: TODO CLIを作って。
ASSISTANT: add/list/doneを実装しました。
USER: あ、CSV exportも欲しい。
ASSISTANT: exportコマンドを追加しました。
```

Expected: **do not save**。最初のAI判断への訂正ではなく追加要件。

### Session C: 好みの変更

```text
USER: エラー文は英語でいいです。
ASSISTANT: 英語のエラー文で実装しました。
USER: やっぱり日本語の方が好きだな。日本語にして。
ASSISTANT: 日本語へ変更しました。
```

Expected: **do not save**。ユーザーの選好が途中で変わっただけ。

### Session D: 未解決の設計議論

```text
USER: retryは3回で実装して。
ASSISTANT: 固定3回retryにしました。
USER: いや、429ならRetry-Afterを見るべきでは？
ASSISTANT: その可能性があります。固定retryとheader準拠のどちらにするか検討できます。
```

Expected: **do not save**。訂正候補はあるが期待する設計と解決結果が確定していない。

### Session E: テストが意味を確認していない

```text
USER: 監査イベント保存のテストを書いて。
ASSISTANT: 保存件数が1件であることをassertしました。
USER: 件数だけだと別イベントを保存しても通る。種類、対象ID、実行者、payloadの主要項目まで、このテスト名が約束する業務事実を確認して。
ASSISTANT: 期待値を独立に組み立て、種類、対象ID、実行者、payloadをDBから読み戻してassertするよう修正しました。誤ったevent kindでも落ちることを確認しました。
```

Expected: **save**。AIのテスト設計判断への再利用可能な訂正で、修正と反証確認まで完了している。

### Session F: タイポ

```text
USER: READMEを書いて。
ASSISTANT: 「インストール手順」を追加しました。
USER: `instll` になってるから直して。
ASSISTANT: `install` に修正しました。
```

Expected: **do not save**。一度限りの表記修正。

## Hard requirements

- [ ] Aを1件の観測として保存する
- [ ] Eを1件の観測として保存する
- [ ] B / C / D / Fを保存しない
- [ ] AとEを一つの観測へ統合しない
- [ ] 保存した観測のexpected / actual / resolutionが会話と逆転していない

## Undesired behavior

- 「ユーザーが何か修正を要求した」という理由だけでB / C / D / Fを保存する
- AやEをproject固有の固有名詞だけに過学習した一般則として記録する
- 未解決のDを解決済みと推測する

## Mechanical checks

6 sessionに対するsave / do-not-saveの混同行列を作る。

```text
TP = A, E
TN = B, C, D, F
FP = 0
FN = 0
precision = 1.0
recall = 1.0
```

このsmoke caseでは完全一致を要求する。実sessionの校正では曖昧例を含むため、別途precision / recallと高重要度false negativeを記録する。

## Human comparison

analyzer変更前後で両方がHard requirementsを満たす場合は、このcaseだけで優劣を決めない。実sessionの人手ラベル集合で、特に高重要度の取りこぼしと追加要件の誤保存を比較する。
