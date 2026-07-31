---
name: research-experiment-loop
description: 実験・調査を継続するプロジェクトで、複数の研究テーマごとに過去の「考えた方針・試したこと・成功・失敗・制約」を検索可能な研究ログへ蓄積し、重複実験を避けて次の仮説、比較条件、終了基準を決める。モデル評価、アルゴリズム探索、性能調査、プロトタイプ比較、原因切り分けで「過去結果を踏まえて次を考える」「研究ログを更新する」「この方針は以前試したか」「実験計画を立てる」「スキル自身を評価・改善する」ときに使う。
---

# 研究実験ループ

研究ログを長文の記憶ではなく、検索できる実験カードと方針カードとして扱う。全履歴を常時
コンテキストへ入れず、今回に関係するカードだけを取得する。

## 保存先

対象プロジェクトのrootにある `.research/` を使う。既存の正式な保存先がある場合はそれを優先し、
`.research/config.json` の `source_documents` から既存資料・課題・評価artifactを参照する。
原データや大きな生成物をカードへ複製せず、パスと要約だけを残す。

研究テーマはconfigの`tracks`へ、安定したhyphen-case IDと表示名で宣言する。テーマ別の
サブディレクトリは作らず、実験カードの`track`と方針カードの`tracks`で分類する。
IDは特定製品や分野の固定enumではなく、対象プロジェクトが定義する。
一つの実験には、主たる問いに対応する`track`を一つ指定する。複数テーマへ再利用できる知見は、
実験を重複保存せず、複数の`tracks`を持つ方針カードへ昇格する。

## 実行環境

以下の`<python>`は、利用可能なPythonコマンドのプレースホルダーとする。実行前に一度だけ
Python 3を解決し、以後は同じ実体を使う。

1. 実行環境がworkspace runtimeや依存ランタイムを提供する場合は、そのPython実体を使う。
2. 対象プロジェクトに既存のPython実行方法がある場合は、それを使う。
3. それ以外は`python3`、`python`、Windowsの`py -3`を順に確認する。
4. `<python> --version`でPython 3であることを確認する。

このスクリプトは標準ライブラリだけを使う。実行のためにパッケージを追加したり、PATHや
対象プロジェクトの環境設定を変更したりしない。解決した実体はプロジェクトへ記録しない。

初回だけ実行する。

```text
<python> "<skill-dir>/scripts/research_log.py" init "<project-root>"
```

## 必須ループ

### 1. 過去を検索する

実験開始前に必ず実行する。

```text
<python> "<skill-dir>/scripts/research_log.py" query "<project-root>" <keyword...>
```

特定テーマだけを調べる場合は、別テーマの類似語が混ざらないよう絞り込む。

```text
<python> "<skill-dir>/scripts/research_log.py" query "<project-root>" --track <track-id> <keyword...>
```

実験の主たる問いに対応するテーマを先に決める。configに存在しない場合は、既存カードを
テーマなしで検索して重複を確認したうえで、安定したIDと表示名を`tracks`へ追加する。

関連カードを2〜5件読み、次を分けて整理する。

- 確認済みの事実
- 過去に棄却した方法と失敗条件
- 現在採用中の方針
- fixture・device・モデルなど比較を制限する条件
- まだ検証されていない推論

検索結果が空でも、既存docs・issue・artifactを検索して最初のカードを作る。検索せずに
「新しい方針」と判断しない。

### 2. 実験契約を先に書く

実行前に `experiments/<id>.json` を `status: planned` で作る。スキーマは
[schemas.md](references/schemas.md)を読む。

最低限、次を先に固定する。

- questionと反証可能なhypothesis
- 過去実験との差分
- baselineの有無と、存在する場合は同一条件で比較できる根拠
- precision、recall、過剰結合、分断、時間、deviceなど独立したmetrics
- acceptanceとstop condition
- 変更しない条件

ここでfixtureはデータセットに限らず、入力、workload、環境、deviceなど固定する比較条件を
指す。fixtureや採点器が異なる値を、同じ指標名だけで直接比較しない。探索初期など意味のある
baselineが存在しない場合は`baseline: null`、`comparable: false`と理由を残す。

### 3. 最小の識別実験を行う

仮説間の差が分かる最小入力から始める。実験中は観測した出力、エラー、設定、変更識別子、
artifactを保持する。失敗を消さず、方法の失敗・実行基盤の失敗・対象の限界・評価不足を分ける。

複数変更を同時に入れた場合、改善要因を一つに帰属させない。

### 4. 結果カードを閉じる

同じカードへ次を記録する。

- measured resultとbaseline差分
- worked / failed
- 失敗の再現条件
- limitations
- artifact paths
- 次に識別すべき仮説
- `accepted`、`failed`、`inconclusive` の判断

成功だけでなく、再試行してはいけない条件を `failed` に具体的に書く。

事前検索や実験契約を省略した研究プロセスを後から修復する場合は、実験カードとは別に
`.research/skill-evals/<id>.json`へプロセス違反、修復内容、再発防止策を記録する。
validator対象外の任意メモだけで監査を完了扱いにしない。

### 5. 方針カードを更新する

再利用可能な知見だけを `principles/<id>.json` に昇格する。単一fixtureの結果は
confidenceを上げすぎない。反証結果は上書きせず `counterevidence` に追加する。

方針は必ずexperiment IDへ追跡可能にする。

### 6. 検証して索引を更新する

```text
<python> "<skill-dir>/scripts/research_log.py" validate "<project-root>"
<python> "<skill-dir>/scripts/research_log.py" index "<project-root>"
```

validation errorを残したまま完了扱いにしない。

## 次の方針を選ぶ規則

候補ごとに次を比較する。

1. 既存の失敗原因を本当に変えているか
2. 成功時にプロジェクトの目的や対象指標へつながるか
3. 失敗しても仮説を一つ減らせるか
4. baselineと比較可能か
5. 実行時間・計算資源に対して情報量が高いか

モデル、パラメータ、手段を替えるだけで、過去の失敗機構が変わらない案は優先しない。
最も情報利得が高い候補を推奨し、代替案と棄却理由も短く残す。

## スキル自身の検証ループ

このスキルを変更したときは、通常の研究対象と同じく評価対象として扱う。
[self-evaluation.md](references/self-evaluation.md)を読み、次を必ず実施する。

1. `<python> "<skill-dir>/scripts/research_log.py" validate-skill "<skill-dir>"`を実行する。
2. `<python> "<skill-dir>/scripts/research_log.py" self-test`を実行する。
3. fresh subagentで最低3ケースをforward-testする。
4. 期待解を渡さず、研究artifactとユーザー依頼だけを渡す。
5. rubricを採点し、critical項目が一つでも失敗したらSKILL.mdを修正する。
6. 全ケースを最初から再実行する。
7. `skill-evals/<id>.json` に失敗、変更、再評価結果を残す。

評価に使ったartifactと期待結果を同じ場所へ置いてsubagentへ漏らさない。スキルが
自分の説明を復唱できるかではなく、未知のログから過去の失敗を回収し、比較可能な次実験を
提案できるかを測る。

## 出力

方針検討時は次の順で返す。

1. 過去から再利用した事実
2. 避けるべき失敗済み方針
3. 今回の未解決点
4. 推奨する次実験と識別できること
5. acceptance、必要資源、比較上の注意
6. 更新したカードとvalidation結果

スコアが改善しても、比較条件の一般化、プロジェクト目的との接続、速度など未達の範囲を
混ぜない。
