---
name: frontend-development
description: ReactやTypeScriptのフロントエンドを、業務状態・discriminated union・reducer・コンポーネント境界・副作用の責務分離に基づいて設計・リファクタリングする。画面機能、非同期リソース読み込み、URL駆動の画面、hook、状態管理の実装やレビューで使う。
---

# フロントエンド開発

フロントエンドの動作を、理解可能な業務フローの集合として設計します。まず状態の所有者と有効な遷移を決め、その後に描画と外部システムとの同期を、責務を持つ境界へ配置します。

## 業務の関心ごとを分ける

hookやコンポーネントを選ぶ前に、画面を独立した関心ごとへ分けます。例:

- 一覧の選択とナビゲーション
- 音声の読み込みと再生
- 文字起こしの読み込みと開始要求
- トラック名の編集

各関心ごとに状態の所有者を一つ置きます。関係のない状態を一つの巨大なページstateへまとめず、小さな状態機械を並列に組み合わせます。

## 状態と遷移を定義する

相互排他的な状態はdiscriminated unionで表現します。各状態に必要なデータも型へ含め、無効な組み合わせを表現できないようにします。

```ts
type TranscriptState =
  | { status: 'unavailable'; targetId: string }
  | { status: 'loading'; targetId: string }
  | { status: 'ready'; targetId: string; text: string }
  | { status: 'error'; targetId: string; message: string };
```

業務イベントと遷移条件はreducerに定義します。

```ts
type TranscriptAction =
  | { type: 'loadStarted'; targetId: string }
  | { type: 'loadSucceeded'; targetId: string; text: string }
  | { type: 'loadFailed'; targetId: string; message: string };
```

reducerは別targetから返った応答や、現在の状態では許可されないイベントを適用してはいけません。DOMイベントはコンポーネント境界で業務イベントへ変換し、reducerをDOMイベント名に依存させないでください。

親がどのworkflowやコンポーネントを適用するか判断する必要がある場合だけ、関心ごとの状態から上位のunionを導出します。

```ts
type LibraryView =
  | { kind: 'none' }
  | { kind: 'selected'; recording: Recording; target: RecordingTarget };
```

すべての子の詳細を一つの「神状態機械」に集めないでください。親は業務関心ごとの組み合わせを担当し、子は自分の内部ライフサイクルを担当します。

## 描画は状態から導出する

`view = f(state)` を基本にします。

- unionのdiscriminatorから相互排他的な描画分岐を作る
- 複数のbooleanから一つの業務状態を推測しない
- 同じ事実をpropsとlocal stateの両方で独立に判定しない
- 子が存在しないことを親の明示的な状態として扱う
- targetが必要な子には、非nullのpropsを契約として渡す

propsを受け取って表示するだけのコンポーネントには、reducerや状態機械を導入しません。入力途中の文字列のように、意味のあるライフサイクル状態や遷移条件を持たない単純なdraft値は`useState`で管理して構いません。

## 非同期処理をリソース境界に閉じ込める

ネットワーク、desktop API、audio要素、Blob URL、timer、storageなどの外部システムを扱う場合:

1. 先にライフサイクル状態を定義する。`unavailable`、`loading`、`ready`、`error`など、業務に必要な状態を用意する。
2. 外部リソースを所有するコンポーネントまたは専用hookに副作用を置く。
3. incidentalなUIフラグではなく、外部リソースの識別子に依存して処理する。
4. 古い応答を無視し、購読、object URL、timer、listenerをcleanupする。
5. reducerに結果を返し、親へloading/error用のsetterを散在させない。

`useEffect`はpropsやstateを外部システムへ同期する境界として使います。親が子の複数のフラグを監視して、別の業務手続きを開始する構造は避けます。その手続きには業務callbackまたはactionを使います。

## 状態源の境界を守る

- URLが正しい状態源なら、route dataとURL parameterからview unionを導出し、local stateへコピーしない。
- 複数画面や複数コンポーネントにまたがるworkflowは、workflow hook/reducerに所有させ、UIへ意味のあるstateとcallbackを渡す。
- APIやplatform serviceのadapterはtyped boundaryの背後に置き、外部payloadとerrorを境界で変換する。
- 親の状態を表すためだけに子へ`null`を許可しない。適用対象の親ブランチだけで子を描画するか、子自身の正当な状態として`hidden`を明示的に定義する。

## featureを業務関心ごとに整理する

アプリ全体を技術レイヤーで分けるのではなく、最初のディレクトリ境界を業務featureにします。

```text
src/features/
  recordings/
    components/
    hooks/
    recordingReducer.ts
    recordingRoute.ts
    *.test.ts
```

一つのfeatureに独立した業務関心ごとが増えたら、関心ごとの実装を近くに置くsub-featureへ分けます。

```text
src/features/
  recordings/
    recording-library/
      components/
      hooks/
      state/
      route.ts
    audio-replay/
      components/
      hooks/
      state/
    transcription/
      components/
      hooks/
      state/
```

union、reducer、状態導出、対応するテストは、所有する関心ごとの近くに置きます。feature全体で共有する場合だけfeature直下へ置きます。空のディレクトリや、一ファイルしかない関心ごとの早すぎる分割は避けます。他featureの内部ファイルを直接参照せず、型、業務イベント、関数を境界として公開します。

## 実装を確認する

statefulなfeatureを完了する前に、次を確認します。

- reducerの主要な遷移をテストしている
- 遷移できない条件と古い非同期応答をテストしている
- props、route data、URL parameterからの状態導出をテストしている
- 外部境界のcleanupとerrorを確認している
- buildとfeatureのunit testを実行している

レビューでは次を問いかけます。

1. この状態の所有者は誰か
2. 有効な状態とイベントは何か
3. 不可能な組み合わせを型で表現できてしまわないか
4. effectはリソースの所有者に置かれているか
5. UIを`view = f(state)`として説明できるか
