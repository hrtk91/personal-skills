---
name: frontend-development
description: フロントエンドの設計原則。フロントエンドの実装・設計・リファクタリング・レビューを始めるときに参照する。業務状態、discriminated union、reducer、UI境界、副作用の責務分離、非同期処理、状態管理を扱う。
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

### 3. 業務イベントと遷移をreducerに集める

reducerに、現在の状態で許可されるイベントと遷移条件を書く。許可されない業務イベントは黙って無視せず、`error`や`rejected`など後から扱える状態へ遷移させるか、呼び出し側へ型付きエラーとして返す。

UIイベントは、そのままreducerへ渡さない。UIの境界で、業務上の意味が分かるactionへ変換する。

対象を切り替えたあと、前の非同期処理の応答が遅れて返ることがある。たとえば録音Aを読み込み中に録音Bへ切り替えた場合、あとから返ったAの応答で、現在表示しているBを上書きしない。

対象切り替え後の古い非同期応答は、業務エラーではなく不要になった応答なので、現在の状態へ適用せず破棄する。必要な場合だけログや計測へ残す。

### 4. 描画はstateから決める

`view = f(state)`を基本にする。同じ事実をpropsとlocal stateの両方で判定したり、複数のbooleanから状態を推測したりしない。unionのdiscriminatorから描画を分岐する。

入力を受け取って表示するだけのUIには、無理にreducerや状態機械を作らない。入力途中の文字列のような単純な値は、使っているフレームワークのlocal stateで管理してよい。

### 5. controller/viewmodelでUIと状態をつなぐ

controller/viewmodelは、UIと状態・外部システムをつなぐグルーです。UIから業務actionを受け取り、reducerや外部I/Oの結果をUIが表示できるstateへ渡します。ReactのhookやVueのcomposableは、このcontroller/viewmodelを実装するための枠です。

controller/viewmodelの中には、担当する一つの関心ごとの状態と副作用だけを置きます。複数の業務関心ごとをまとめるworkflowは、別のcontrollerやworkflow層として名前と責務を明示します。ドメインの純粋な判定や状態遷移は、controller/viewmodelの外に置いてテストできるようにします。

## adapterで外部I/Oを分ける

外部通信は、差し替え可能なport（interface）を通して行います。adapterはportの実装であり、API、platform service、storageなどとの通信を担当します。adapterに業務状態や画面の判断を持たせません。

```text
UI → controller/viewmodel → port → adapter → 外部システム
```

controller/viewmodelは具体的なadapterではなくportに依存させます。テストではFakeやStubを差し替えられるようにします。ただし、差し替える必要のない単純な処理まで、形式的にadapterへ分けないでください。

## 非同期処理と副作用

- 外部API、platform service、audio要素、Blob URL、timer、storageなどを扱う場合は、先に`unavailable`、`loading`、`ready`、`error`などの状態を決める。
- 副作用は、その外部リソースを所有するUI、controller、専用hookなどに置く。
- propsやstateを外部システムへ同期する仕組みを使う。Reactなら`useEffect`がその手段になる。親が子のフラグを監視して、別の業務処理を開始する用途には使わない。
- 同期処理の依存値には、外部リソースを特定する値を含める。`key`による暗黙の再初期化や、空の依存配列で処理順序を隠さない。
- 非同期処理のcleanupで、購読解除、object URL解放、timer停止などを行う。

## 状態源と責務の境界

- URLやナビゲーション情報が状態源なら、そこから画面stateを導出し、local stateへ二重にコピーしない。画面の初期データを取得する仕組みは、使っているフレームワークのentrypoint境界に閉じ込める。
- 複数画面にまたがる業務workflowはworkflow controllerやreducerに持たせ、UIには意味のあるstateとcallbackを渡す。
- 子から親へはUI操作ではなく業務イベントを通知する。
- APIやplatform serviceのadapterはtyped boundaryの背後に置き、外部payloadとerrorを境界で変換する。

## featureの構成

最初のディレクトリ境界を技術ではなく業務featureにする。

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

- reducerの主要な遷移をテストする
- 対象AからBへ切り替えたあと、Aの応答が返ってきてもBを上書きしないことをテストする
- 入力、ナビゲーション情報、初期データからの状態導出をテストする
- 外部境界のcleanupとerrorを確認する
- buildとfeatureのunit testを実行する

レビューでは、次の5点を確認する。

1. この状態の所有者は誰か
2. 有効な状態とイベントは何か
3. 不可能な組み合わせを型で表せないか
4. 副作用はリソースの所有者にあるか
5. UIを`view = f(state)`として説明できるか
