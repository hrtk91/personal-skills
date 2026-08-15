# Greenfield Rust TODO CLI

## Origin

実運用の単一失敗ではなく、モデル更新時やskill変更時に要件達成・検証・過剰実装の大きな回帰を見る代表的なsmoke case。

## Purpose

小さなアプリを一から完成させるtaskで、要件達成、検証、過剰実装の差を見るsmoke case。

## Start state

空ディレクトリで開始する。agentには実装前のコードや設計を与えない。

## Task

```text
RustでCLIのTODOアプリを一から実装してください。

要件:
- `add <title>` でTODOを追加し、割り当てたIDを標準出力へ出す
- `list` で全TODOをID順に表示する
- `done <id>` で完了状態にする。存在しないIDは非0で終了する
- データはプロセス終了後も永続化する
- 保存先は `TODO_FILE` 環境変数で指定できる
- READMEに実行方法を書く
- 自動テストを用意する

実装、テスト、動作確認まで完了してください。
```

## Hard requirements

- [ ] `add`、`list`、`done` が要件通り動く
- [ ] `TODO_FILE` で保存先を分離できる
- [ ] 再起動後もデータが残る
- [ ] 存在しないIDへの `done` が非0終了する
- [ ] 自動テストがあり成功する
- [ ] READMEに利用方法がある

## Undesired behavior

- 要件にないWeb UI、server、認証などを追加する
- 一用途のために大きなframeworkや多層の抽象化を導入する
- 動作確認をせず完了扱いする
- `TODO_FILE` を無視する共有状態を持つ

## Mechanical checks

成果物の実際のコマンド名に合わせて実行する。

```text
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test

TODO_FILE=<temp-file> <app> add first
TODO_FILE=<temp-file> <app> add second
TODO_FILE=<temp-file> <app> done 1
TODO_FILE=<temp-file> <app> list
TODO_FILE=<temp-file> <app> done 999  # non-zeroを確認
```

`list` でID 1が完了、ID 2が未完了であることを確認する。新しいprocessから同じ `TODO_FILE` を指定して永続化を確認する。

## Human comparison

A/Bをblindで比較し、実際に保守して使いたい方を選ぶ。主に次を見る。

- 要件に対して差分・依存・概念が過大でないか
- コードから主要な処理と永続化境界を追いやすいか
- テストが利用者向けの振る舞いを確認しているか
