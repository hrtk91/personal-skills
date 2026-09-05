---
name: frontend-development-principles
description: フロントエンドの状態管理、UI境界、副作用、非同期処理の責務を設計・実装・レビューする際に使う。
---

# フロントエンド開発

フロントエンドの実装では、先に「何が起きる画面なのか」と「その状態を誰が持つのか」を決める。その後でUI、状態管理、外部システムとの境界を配置する。React、Vue、Svelteなどのフレームワーク固有の書き方は、この原則を実現する手段として選ぶ。

## 基本原則

### 1. 業務の関心ごとごとに状態を持つ

画面を、一覧の選択、音声再生、文字起こし、編集などの業務関心ごとに分ける。各関心ごとに状態の所有者を一つ置く。関係のない状態を一つの巨大な「神state」にまとめない。

### 2. 状態はdiscriminated unionで表す

`null`や複数のbooleanの組み合わせで業務状態を表さない。`loading`、`ready`、`error`のような状態と、その状態で必要なデータを一つのunionにまとめる。

```ts
type ResourceState =
  | { status: 'loading'; targetId: string }
  | { status: 'ready'; targetId: string; value: string }
  | { status: 'error'; targetId: string; message: string };
```

対象がないことが親の状態なら、親が`none`や空状態を表す。対象が必要な子には、非nullのpropsを渡す。

### 3. 状態更新と業務判断を分ける

effect、watcher、refなどで処理を書き始める前に、有効な状態、状態を変えるイベント、各イベントを確定できる状態源を列挙する。複数の値の変化から「処理が始まったはず」と推測せず、router、form、外部APIなどがすでに持つ確定情報を使う。

複数のイベントによる状態更新が散らばり、遷移をまとめて扱う必要がある場合はreducerを使う。既存の状態管理機構やドメインの型が遷移を管理している場合は、同じ判断をreducerへ重複して実装しない。

reducerは現在の状態とactionから次の状態を返す純粋な関数とし、通信や一連の処理の実行を持たせない。操作の可否や計算、業務上の遷移条件はUIから独立した関数や型に置き、reducerの各caseへ埋め込まず、必要な判断を委譲する。画面stateのreducerは表示対象と取得結果の一致など画面の整合性を守り、業務側の判断を表示に利用しても同じ業務ルールを再実装しない。

許可されない業務操作は黙って無視せず、操作を受け付ける処理から型付きエラーを返すか、拒否の結果を`error`や`rejected`など後から扱える状態へ反映する。reducerを使う場合も、呼び出し側への操作結果と次のstateを混同しない。

UIイベントは、そのままreducerへ渡さない。UIの境界で、業務上の意味が分かるactionへ変換する。

対象を切り替えたあと、前の非同期処理の応答が遅れて返ることがある。たとえば録音Aを読み込み中に録音Bへ切り替えた場合、あとから返ったAの応答で、現在表示しているBを上書きしない。

対象切り替え後の古い非同期応答は、業務エラーではなく不要になった応答なので、現在の状態へ適用せず破棄する。必要な場合だけログや計測へ残す。

### 4. 描画はstateから決める

`view = f(state)`を基本にする。同じ事実をpropsとlocal stateの両方で判定したり、複数のbooleanから状態を推測したりしない。unionのdiscriminatorから描画を分岐する。

入力を受け取って表示するだけのUIには、無理にreducerや状態機械を作らない。入力途中の文字列のような単純な値は、使っているフレームワークのlocal stateで管理してよい。

### 5. データの準備と変更要求は画面入口を第一選択にする

`view = f(state)`を実現するため、表示用データの取得・構成と変更要求の受付は、採用するフレームワークの画面入口へ集める。Remix / React Routerではloader・clientLoaderとroute actionを第一選択にする。componentやhookへ取得・更新処理を書く前に、この入口で扱えるか確認する。同等の仕組みがない構成でも、画面データを準備する入口と変更要求を受ける入口を明示する。

loaderはURLなどから対象を解決し、表示に必要なデータとリソースの参照先を揃える。Viewは渡されたデータを表示し、操作をForm・fetcherなどフレームワークの送信手段でroute actionへ渡す。route actionは入力を境界で検証・変換して業務処理へ委譲し、結果を返す。変更後の表示はフレームワークの再検証・再取得を使い、同じデータをhookのlocal stateへコピーして独自に更新しない。route actionとreducerへ渡すactionは別の契約として区別する。

loaderやroute actionには業務ルールや業務フローを埋め込まず、UI・routerから独立した関数や型へ委譲する。controller、viewmodel、usecaseという層名やクラスは必須にしないが、業務処理をReactなしで実行・検証できる境界を保つ。

hookやcomposableは、画面データへの接続と、再生制御・購読・cleanupなどUI側で必要なリソースの寿命を扱う。例えば既存録音の表示では、loaderが文字起こしの内容と再生用URLなどを準備し、文字表示は内容を描画し、プレイヤーは再生・停止・シーク・バッファリングを管理する。音声本体の一括取得までloaderへ要求しない。解放が必要な一時URLやライブ購読など、画面入口で完結しないものは生成から解放までの所有者を明示する。入力途中の値やダイアログ開閉などのUI固有stateはlocal stateで扱ってよい。

## adapterで外部I/Oを分ける

外部通信は、差し替え可能なport（interface）を通して行います。adapterはportの実装であり、API、platform service、storageなどとの通信を担当します。adapterに業務状態や画面の判断を持たせません。

```text
表示データ: loader → 独立した取得処理 → port → adapter → 外部システム
変更要求: View → route action → 独立した業務処理 → port → adapter → 外部システム
```

外部I/Oを呼ぶ処理は具体的なadapterではなくportに依存させます。テストではFakeやStubを差し替えられるようにします。ただし、差し替える必要のない単純な処理まで、形式的にadapterへ分けないでください。

外部のWidgetやbrowser APIを組み込む場合は、script読込、型定義、生成、更新、破棄を独自実装する前に、公式SDKと公式資料で案内されるlibraryを確認する。既存libraryへ任せる範囲と、アプリケーションが持つ状態・業務イベント・入力値を分ける。独自実装は、既存の選択肢で必要な契約を満たせない場合に限る。

## 非同期処理と副作用

- 外部API、platform service、audio要素、Blob URL、timer、storageなどを扱う場合は、先に`unavailable`、`loading`、`ready`、`error`などの状態を決める。
- 表示データの取得と変更要求は画面入口で扱う。UI側のリソース制御は、そのリソースを所有するcomponent、専用hook、composableなどに置く。
- propsやstateを外部システムへ同期する仕組みを使う。Reactなら`useEffect`がその手段になる。親が子のフラグを監視して、別の業務処理を開始する用途には使わない。
- 同期処理の依存値には、外部リソースを特定する値を含める。`key`による暗黙の再初期化や、空の依存配列で処理順序を隠さない。
- 非同期処理のcleanupで、購読解除、object URL解放、timer停止などを行う。

## 状態源と責務の境界

- URLやナビゲーション情報が状態源なら、そこから画面stateを導出し、local stateへ二重にコピーしない。画面の初期データを取得する仕組みは、使っているフレームワークのentrypoint境界に閉じ込める。
- 複数画面や業務関心ごとにまたがる業務フローは、UI・routerから独立した関数やモジュールにまとめ、画面入口から呼び出す。画面を閉じても継続すべき処理は、componentのmountや購読の有無に依存させない。処理の実行と状態更新を分け、reducerに外部I/Oや一連の処理を実行させない。
- 子から親へはUI操作ではなく業務イベントを通知する。
- APIやplatform serviceのadapterはtyped boundaryの背後に置き、外部payloadとerrorを境界で変換する。

## featureの構成

新しく構成を決める場合は、業務featureごとに関連する処理を近くへ置く。既存コードの変更では、その構成と理由を確認し、今回の問題を解決するために必要な範囲で見直す。

```text
src/features/
  recordings/
    components/       # UI component/view
    state/            # union、reducer、状態導出
    adapters/         # 外部APIやplatform serviceとの境界
    tests/
```

feature内に独立した関心ごとが増えたら、`recording-library/`、`audio-replay/`、`transcription/`のようなsub-featureへ分ける。その中も同じ方針で、UI、state、外部境界を整理する。画面に入るときのデータ取得やURL解析は、採用しているフレームワークの画面入口に閉じ込める。Reactなら`hooks/`、Vueなら`composables/`を、UIと状態を接着する実装の置き場として使う。union、reducer、状態導出、テストは所有する関心ごとの近くに置く。空のディレクトリや早すぎる分割は避ける。

## 最低限の確認

- 業務判断と主要な状態遷移を、それぞれの所有者でテストする。reducerを使う場合は、その状態更新も確認する
- 対象AからBへ切り替えたあと、Aの応答が返ってきてもBを上書きしないことをテストする
- loaderの対象解決・取得結果と、route actionの成功・拒否・失敗および変更後の再取得を、該当する画面入口で確認する
- 入力、ナビゲーション情報、初期データからの状態導出をテストする
- 外部境界のcleanupとerrorを確認する
- 外部統合では、読込失敗、通信失敗、無効な応答、期限切れ、再実行、画面離脱など、該当するライフサイクルを確認する
- buildとfeatureのunit testを実行する

レビューでは、次の5点を確認する。

1. この状態の所有者は誰か
2. 有効な状態とイベントは何か
3. 不可能な組み合わせを型で表せないか
4. 副作用はリソースの所有者にあるか
5. UIを`view = f(state)`として説明できるか。表示データの取得・変更をloader／route actionからcomponentやhookへ分散させていないか
