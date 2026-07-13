#!/usr/bin/env python3
"""
prm 集計スクリプト
Usage:
  python3 summary.py                            # チーム全体（デフォルトリポジトリ、--repoで指定）
  python3 summary.py --user hrtk91             # 個人フィルタ
  python3 summary.py --repo owner/repo          # リポジトリ指定
  python3 summary.py --user hrtk91 --since 2025-12-01  # 期間フィルタ
"""
import argparse
import gzip
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--user", help="GitHubログイン名でフィルタ")
    p.add_argument("--repo", default="OWNER/REPO", help="owner/repo 形式（自分の環境に合わせて書き換える）")
    p.add_argument("--since", help="集計開始日 YYYY-MM-DD")
    return p.parse_args()


def load_weeks(data_dir: Path, since: datetime | None) -> list[tuple[str, dict]]:
    files = sorted(data_dir.glob("*.json.gz"))
    result = []
    for f in files:
        week = f.stem.replace(".json", "")
        with gzip.open(f, "rt") as fp:
            d = json.load(fp)
        data = d.get("data", {})

        # since フィルタ: prDetails の mergedAt で判定
        if since:
            prs = data.get("prDetails", [])
            if prs:
                last_merged = max(
                    (p.get("mergedAt", "") for p in prs if p.get("mergedAt")),
                    default=""
                )
                if last_merged and datetime.fromisoformat(last_merged.replace("Z", "+00:00")) < since:
                    continue

        result.append((week, data))
    return result


def bar(count: int, total: int, width: int = 20) -> str:
    if total == 0:
        return "░" * width
    filled = round(width * count / total)
    return "●" * filled + "░" * (width - filled)


def main():
    args = parse_args()
    owner, repo = args.repo.split("/", 1)
    data_dir = Path.home() / f".pr-metrics/{owner}/{repo}/data"

    if not data_dir.exists():
        print(f"データが見つかりません: {data_dir}")
        print("まず `prm fetch` でデータを取得してください")
        return

    since = None
    if args.since:
        since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)

    weeks = load_weeks(data_dir, since)
    if not weeks:
        print("対象データなし")
        return

    user = args.user
    label = f"（{user}）" if user else "（チーム全体）"
    since_label = f" | {args.since}以降" if args.since else ""
    print(f"\n## PR メトリクス集計 {label}{since_label}\n")

    # ── 週別テーブル ──────────────────────────────
    print(f"{'週':<12} {'全PR':>5}  {'対象PR':>6}  {'LT(avg)':>9}  {'LT(med)':>9}  {'割合':>7}")
    print("─" * 58)

    all_rows = []
    total_mine = 0
    total_all = 0

    for week, data in weeks:
        total = data.get("totalPRs", 0)
        prs = data.get("prDetails", [])

        target = [p for p in prs if p.get("author") == user] if user else prs
        count = len(target)
        if total == 0 and count == 0:
            continue

        lead_times = sorted(p.get("leadTimeDays", 0) for p in target)
        avg_lt = sum(lead_times) / len(lead_times) if lead_times else 0
        med_lt = statistics.median(lead_times) if lead_times else 0
        ratio = count / total * 100 if total > 0 else 0

        all_rows.append((week, total, count, avg_lt, med_lt, ratio, target))
        total_mine += count
        total_all += total

        print(f"{week:<12} {total:>5}  {count:>6}  {avg_lt:>8.1f}d  {med_lt:>8.1f}d  {ratio:>6.1f}%")

    print("─" * 58)
    if user:
        print(f"{'合計':<12} {total_all:>5}  {total_mine:>6}  貢献割合: {total_mine/total_all*100:.1f}%\n")
    else:
        print(f"{'合計':<12} {total_all:>5}\n")

    # ── 月別サマリー ──────────────────────────────
    month_map: dict[str, list] = {}
    for week, total, count, avg_lt, med_lt, ratio, target in all_rows:
        # 週番号から月を推定（mergedAt の最初の PR で）
        first_pr = target[0] if target else None
        if first_pr and first_pr.get("mergedAt"):
            month = first_pr["mergedAt"][:7]  # YYYY-MM
        else:
            # W番号から大まかに推定
            month = week[:4] + "-??"
        month_map.setdefault(month, []).append((count, avg_lt))

    print("### 月別サマリー\n")
    print(f"{'月':<10}  {'PR数':>5}  {'平均LT':>8}")
    print("─" * 30)
    for month in sorted(month_map):
        rows = month_map[month]
        m_count = sum(r[0] for r in rows)
        m_lt = sum(r[1] for r in rows) / len(rows) if rows else 0
        print(f"{month:<10}  {m_count:>5}  {m_lt:>7.1f}d")

    # ── リードタイム傾向 ──────────────────────────
    if len(all_rows) >= 3:
        print("\n### リードタイム推移（折れ線ビジュアル）\n")
        max_lt = max(r[2] for r in [(w, t, a, me, ra, ta) for w, t, c, a, me, ra, ta in all_rows]) if all_rows else 1
        # avg_ltが最大値
        lts = [(w, a) for w, t, c, a, me, ra, ta in all_rows]
        max_lt = max(lt for _, lt in lts) if lts else 1
        for week, lt in lts:
            b = bar(int(lt * 10), int(max_lt * 10), width=25)
            print(f"  {week:<12} {b}  {lt:.1f}d")

    print()


if __name__ == "__main__":
    main()
