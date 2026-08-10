---
name: stabilize-route-animations
description: routeや画面の切替animationを診断・安定化する。画面遷移時のちらつき、二重再生、全要素の再animation、enterとleaveの中断、loader完了前の描画、React commitとpaintのずれ、素早い連打、prefers-reduced-motion時の待機不整合を調査・修正・テストするときに使う。
---

# 画面遷移アニメーション安定化

animationをCSSだけの問題として扱わず、ユーザー操作、状態遷移、navigation、route commit、paintの順序として診断する。

## 1. 再生源を列挙する

対象画面のrootから子要素まで、次を検索する。

- `animation`、`transition`、`@keyframes`
- View Transitionの名前とold/new疑似要素
- mount時に常時適用されるenter animation
- route、layout、詳細panelなど複数階層のanimation
- loading、spinnerなど状態継続中のanimation

一つの切替で同じ要素または祖先と子へ複数のenter/leaveが適用されていないか確認する。画面rootの遷移中に、子要素のmount animationまで一斉に再生しない。

## 2. phaseと所有者を確認する

画面切替を少なくとも次のphaseで扱う。

```text
idle -> leaving -> switching -> entering -> idle
```

- `leaving`: 現在画面だけを退出させる。
- `switching`: 現在画面を透明のまま固定し、routeを交換する。
- `entering`: 新画面のcommit後に入場させる。
- `idle`: animation用classを外す。

phaseは画面遷移を開始するcontrollerまたはshellが一つだけ所有する。複数booleanで組み合わせず、unionまたは単一discriminatorで表す。

## 3. navigationとpaintを同期する

CSS durationと同じ長さのtimerを置くだけでは不十分。routerはloaderやtransition updateを持ち、`navigate()`直後のstate更新と同じReact commitになる保証はない。

次を守る。

1. leave完了後に`switching`へ遷移し、画面rootを`opacity: 0`で固定する。
2. 次の描画フレームでnavigationを開始する。
3. navigationとloaderの完了を待つ。Data/Framework Routerで`navigate()`がPromiseを返す場合はawaitし、Declarative Routerなどawaitできない場合はnavigation state、location key、route rootのcommitを観測する。
4. さらに次の描画フレームで`entering`へ遷移する。
5. enter完了後に`idle`へ戻す。

新routeを通常表示で1フレームpaintしてからenter classを付けない。navigation待ち中にenter終了timerを進めない。

可能なら所有する画面rootの`animationend`または`animationcancel`でphaseを進め、eventが届かない場合だけfallback timeoutを使う。固定timerを使う場合はCSSと別々にdurationをハードコードせず、単一のduration tokenから導出する。navigation、loader、animationが失敗またはcancelされた場合も透明な`switching`へ残さず、エラー表示または`idle`へ回復する。

## 4. 中断と連打を定義する

- enter中の逆方向操作でenterを即cancelすると、computed opacityやtransformがkeyframe先頭へ飛び、ちらつく。
- 操作を無視せずpending requestとして保持し、enter完了直後にleaveを開始する。
- leave中の重複操作は二重timerや競合navigationを作らない。
- pending requestを複数許す場合は、独自履歴にせず最後の有効な要求だけを保持する。
- timer、`requestAnimationFrame`、pending requestは所有者のunmountで破棄する。

## 5. reduced motionを揃える

CSSの`animation-duration`だけを短縮し、JavaScriptが元のduration待つ状態を作らない。`prefers-reduced-motion: reduce`ではanimation phaseとtimerを省略し、navigationを即時実行する。

## 6. 検証する

単体テストでは外から観測できるphaseとrouteを確認する。

- click直後は`leaving`
- route交換中は新画面が通常表示にならない
- navigation完了後だけ`entering`
- enter完了後はanimation classが残らない
- enter中の逆操作は保留され、完了後に実行される
- reduced motionでは待機phaseが残らない
- loaderが遅延してもenter期間を先に消費しない
- unmount後にtimerやframe callbackがstateを更新しない
- navigation、loader、animationの失敗やcancel後に透明な画面へ残らない
- CSS durationを変更してもJS側だけ古い待機時間にならない

CSSやReact test rendererだけで視覚品質を断定しない。ローカル実画面で往復操作を行い、可能なら各frameのclass、computed opacity、transform、URL、console errorを観測する。ブラウザ操作APIがanimation終了まで待つ場合は、その計測結果を瞬間frameの証拠として扱わない。

## 避ける実装

- route root、画面固有root、View Transitionへ同じenter/leaveを重ねる
- mountされた全子要素へ無条件でanimationを付ける
- `navigate()`の戻りやloaderを待たずenter timerを開始する
- enter途中でclassをleaveへ直接差し替える
- CSS durationとJS timerが同値という理由だけで同期済みと判断する
- テスト成功だけでちらつきがないと言い切る
