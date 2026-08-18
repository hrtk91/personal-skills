# 変更説明テンプレート

必要な節だけ使う。空欄を埋めるために推測を足さない。

## 実装前briefing

```markdown
### 現在の動作（事実）

<ユーザー操作> → <entrypoint> → <境界/process> → <状態/resource> → <外部I/O・保存結果>

### 変更後の動作（提案）

<何の所有者・状態・境界がどう変わるか>

### 影響map

| 対象 | 現在 | 変更 | consumer・別入口 | 失敗時 | 確認予定 |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

### 不変条件

| ID | 条件 | 種別 | 根拠・決定者 | 検証方法 |
|---|---|---|---|---|
| I1 | ... | 既存 / 維持案 / 変更候補 / 未確認 | ... | ... |

### 決定点

| ID | 選択肢 | 各案の影響 | 決定者 |
|---|---|---|---|
| D1 | A / B | I1: ... | user / specification |

### 変更しない範囲

- ...
```

## 実装中の更新

```text
新事実: <確認できた事実>
影響: <I番号 / D番号 / scope>
判断: 続行 / briefing更新 / decision待ち
```

## handoff・PR

```markdown
### 実際に変わった動作

- ...

### 予定と実績の差

- 予定どおり: ...
- 予定外: ...
- 見送った範囲: ...

### 確定した影響範囲

| 対象 | 実差分 | consumer・別入口 | 互換性・失敗経路 |
|---|---|---|---|
| ... | ... | ... | ... |

### 不変条件と証拠

| ID | 結果 | 証拠 | 未検証 |
|---|---|---|---|
| I1 | 維持 / 変更 | test / log / manual check | ... |

### 検証

- `<command>`: pass / fail / 未実行
```

## 小さい例

```text
現在: UI -> Tauri command -> TCP client -> host process -> recording core -> WASAPI
変更: recording coreがsessionとfinalizerを所有し、hostはTCP変換だけを担当する

I1 1つの録音sessionだけが入力deviceを所有する（既存）
I2 runtime準備前にRecordingを公開しない（維持案）
D1 waiting capture leaseをhostへ残すか、coreへ移すか（未決定）
```
