# Skill benchmarks

`benchmarks/` は、skill変更が実際の成果を改善したかを比較するための観測、失敗原因の仮説、評価ケース、結果を置く。

目的は精密なLLM評価基盤を作ることではなく、**実運用の失敗からモデルの能力境界を測り、必要な介入だけを残すこと**。skillの文言を先に考えて、それを正当化する評価は作らない。

## 構成

```text
benchmarks/
├─ observations/ # benchmark候補として残す観測
├─ hypotheses/   # 観測された失敗の競合原因と識別eval
├─ cases/        # 固定taskと合格条件
└─ runs/         # 実行条件と比較結果
```

普段のCodex利用では `skill-observation-recorder` がSessionEnd後に会話を非同期解析し、AIの判断をユーザーが訂正して解決まで進んだ事例を `~/.codex/skill-observations/` に保存する。runtimeの観測をその場でskillへ一般化しない。

再発した観測または高重要度の観測だけを `observations/` へ持ち込む。そこから直接skillや固定caseへ進まず、`hypotheses/` で「なぜ失敗したか」の競合仮説を置き、現行のbare modelで再現性と原因を確かめる。repoを日常ログでdirtyにしないため、自動記録先とbenchmarkへ採用した記録を分ける。

## 観測から介入まで

```text
runtime session
    ↓
observation
    ↓
competing failure hypotheses
    ↓
discriminating eval on bare model
    ↓
fixed benchmark case
    ↓
intervention
(skill / AGENTS.md / tool / test / lint / model routing)
    ↓
baseline / treatment comparison
```

観測された一つの失敗は、次のような別原因で説明できることがある。

- 現行モデルの能力不足
- 必要なrepository contextを探索しなかった
- task自体が曖昧だった
- project固有の前提が与えられていなかった
- toolや実行環境の失敗
- 既存skillやAGENTS.mdによる過剰な誘導

一つへ決め打ちせず、原因によって結果が分かれる最小のevalを考える。bare modelで対象失敗が再現しない場合は、原則としてskillを追加しない。

## ケースを追加する条件

実際に困った失敗、または代表的な開発タスクを追加する。skillの文言を正当化するためだけのケースは作らない。

失敗起点のケースは、原則として `observations/` と `hypotheses/` の記録へ辿れるようにする。代表的なsmoke caseはその限りではない。

ケースは次の順に安い方法を選ぶ。

1. 空repoから開始する新規実装
2. 既存repo + commit/PRを固定して使う
3. 外部状態が不安定な場合だけ専用fixtureを保存する

ケースには最低限、次を記録する。

- **Origin**: 元のobservation / failure hypothesis
- **Task**: agentへそのまま渡す依頼
- **Start state**: repo、commit、初期化手順
- **Hard requirements**: 満たさなければ不合格になる条件
- **Undesired behavior**: 過剰実装、見逃し、無関係な指摘など
- **Mechanical checks**: build/test/grepなど決定的な検査
- **Human comparison**: A/Bを比較するときに見る点

`cases/TEMPLATE.md` を使う。

## 検証手順

### 1. 比較対象を決める

例:

- skillなし vs skillあり
- 変更前skill vs 変更後skill
- 旧モデル vs 新モデル

一度に複数の変数を変えない。

### 2. 実行条件と合格条件を固定する

同じtask、モデル、推論設定、ツール権限、開始commitを使う。各runはcleanな状態から開始する。

結果を見る前に「何が改善し、何が悪化しなければ採用するか」を `runs/` に書く。LLM出力の揺らぎを見るため、既定は各条件3回実行する。

### 3. 機械検査を行う

Hard requirementsとMechanical checksを先に評価する。ここは人間の好みで補正しない。

### 4. blind pairwiseで比較する

成果物をA/Bとして並べ、どちらがbaseline/treatmentかを見ずに「実際に採用したい方」を選ぶ。

絶対点を無理に作らず、必要なら次だけ補助的に記録する。

- 重要な要件・問題の見逃し
- 余計な変更・指摘
- task外へのscope creep
- 修正後の理解・変更コスト

### 5. 採否を決める

事前の合格条件を満たし、重大な回帰がない場合だけ介入を残す。差が曖昧ならskillや追加指示を増やさない。

結果は `runs/TEMPLATE.md` をコピーして残す。

## observation recorderの校正

`skill-observation-recorder` の出力もground truthではなく、benchmark候補を作る推定器として扱う。recorderが取りこぼすと評価corpus自体が偏るため、定期的に人間がfull transcriptを読み、保存すべき訂正をラベルした小さな集合と比較する。

最低限、次を確認する。

- **precision**: 保存した観測のうち、本当に再利用可能なAI失敗だった割合
- **recall**: 人間が保存対象とした訂正のうち、recorderが拾えた割合
- **false negative**: 高重要度の訂正を取りこぼしていないか
- **classification**: 追加要件、好みの変更、未解決議論を誤って保存していないか
- **severity agreement**: 高重要度ケースを低く扱っていないか

analyzerのmodelやpromptを変えた場合も、この集合で前後比較する。

## モデル更新時

skillの効果はモデルに依存する。モデル名/version/推論設定を必ず記録し、モデル更新時は少数のsmoke caseと過去の高重要度caseを再実行する。

新モデルがskillなしで同等以上になった場合、そのskillは削除候補とする。
