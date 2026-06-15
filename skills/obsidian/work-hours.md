# 労働時間集計

`pmset -g log` のSleep/Wakeイベントから実労働時間と休憩時間を集計する。

## 呼び出し

```bash
bash ~/.claude/skills/obsidian/scripts/work-hours.sh [YYYY-MM-DD]
```

- 引数省略時は今日
- 過去日も指定可（pmsetログ保持期間内、概ね数日〜1週間）
- 依存: `jq`, `pmset`, macOS標準の `awk` / `date`

## 判定ロジック

- **起点**: `Sleep/Wakes since boot at` の時刻（朝の起動）
- **休憩入り**: `Idle Sleep`（操作放置による自動スリープ）
- **休憩明け**: `FullWake (UserActivity)` / `HID Activity` Wake
- `Sleep Service Back to Sleep` / `Maintenance Sleep` は無視（休憩中のメンテナンス）
- 5分未満のセグメントは隣接にマージ（チラ見ノイズ除去）
- 終端: 今日なら現在時刻、過去日なら最終Sleepイベント

## 出力フォーマット（JSON）

```json
{
  "date": "2026-05-07",
  "boot": "09:20:30",
  "end": "21:45:14",
  "segments": [
    {
      "type": "work",
      "start_time": "09:20:30",
      "end_time": "12:39:24",
      "duration": "3h 18m",
      "duration_seconds": 11934,
      "start": "2026-05-07 09:20:30",
      "end": "2026-05-07 12:39:24"
    },
    ...
  ],
  "total_work": "9h 31m",
  "total_break": "2h 52m",
  "total_work_seconds": 34316,
  "total_break_seconds": 10368
}
```

## 振り返りでの記載

日次振り返りで**持続可能性ランク**を評価する材料にする。デイリーノートの「振り返り」セクション末尾に **🕐 労働時間** ブロックを追記する。

### 追記フォーマット

```markdown
🕐 労働時間
- 実労働: 9h 31m / 休憩: 2h 52m
- 09:20-12:39 (3h 18m) → 昼休 54m → 13:33-16:58 (3h 25m) → 夕方休 1h 58m → 18:57-21:45 (2h 48m)
```

`segments` から `start_time-end_time (duration)` の連結文字列を生成して時系列で並べる。breakは `→ 昼休 54m →` のように矢印で繋ぐ。

### 持続可能性ランクの目安

| 実労働 | ランク |
|--------|--------|
| ≤ 8h | S |
| 8h〜9h | A |
| 9h〜10h | B |
| 10h〜11h | C |
| > 11h | D |

休憩がしっかり取れているか（昼1h以上 / 連続作業 ≤ 4h）も併せて評価する。

## 注意事項

- `Idle Sleep` は最後の操作から約15分のアイドル猶予後に発生するため、実際の操作終了時刻は記録より数分早い可能性あり（誤差 ±15分以内）
- ブートの正確な時刻が取れない場合（早朝起動して再ログインなど）、最初のWakeイベントを起点にフォールバックする実装ではない点に注意
- 過去日を指定する場合、pmsetログの保持期間を超えると取得できない
