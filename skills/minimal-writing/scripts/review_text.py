#!/usr/bin/env python3
"""Verifiable Minimal Writing 用の軽量ヒューリスティックレビュー。

このスクリプトは真偽を検証しない。人間または Codex が確認すべきことの多い文を検出する:
- 自信が強すぎる効用主張
- 不明点として扱われていない不確実性
- 曖昧な重要性表現
- 長い文
- 繰り返しの埋め草表現
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Iterable

OVERCONFIDENT_PATTERNS = [
    r"\bproves?\b",
    r"\bguarantees?\b",
    r"\balways\b",
    r"\bnever\b",
    r"best practice",
    r"secure",
    r"extensible",
    r"maintainable",
    r"scalable",
    r"improves?",
    r"will make",
    r"確実",
    r"必ず",
    r"常に",
    r"ベストプラクティス",
    r"安全",
    r"セキュア",
    r"拡張性",
    r"保守性",
    r"改善",
]

UNCERTAINTY_PATTERNS = [
    r"maybe",
    r"probably",
    r"likely",
    r"appears? to",
    r"seems?",
    r"想定",
    r"たぶん",
    r"おそらく",
    r"かもしれ",
    r"気がする",
    r"未確認",
    r"仮説",
]

FILLER_PATTERNS = [
    r"it is important to",
    r"in order to",
    r"as a result",
    r"needless to say",
    r"重要です",
    r"非常に",
    r"〜と言えるでしょう",
    r"ということができます",
]


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。.!?！？])\s+|\n+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def find_matches(sentences: Iterable[str], patterns: list[str]) -> list[tuple[int, str, str]]:
    findings: list[tuple[int, str, str]] = []
    for idx, sentence in enumerate(sentences, 1):
        for pattern in patterns:
            if re.search(pattern, sentence, flags=re.IGNORECASE):
                findings.append((idx, pattern, sentence))
                break
    return findings


def print_findings(title: str, findings: list[tuple[int, str, str]]) -> None:
    print(f"\n## {title}")
    if not findings:
        print("明確な検出なし。")
        return
    for idx, pattern, sentence in findings:
        print(f"- S{idx}: `{pattern}` に一致")
        print(f"  {sentence}")


def main() -> int:
    if len(sys.argv) > 2:
        print("使い方: review_text.py [path]", file=sys.stderr)
        return 2

    if len(sys.argv) == 2:
        text = Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        text = sys.stdin.read()

    sentences = split_sentences(text)
    words = re.findall(r"\S+", text)

    print("# Verifiable Minimal Writing ヒューリスティックレビュー")
    print(f"文数: {len(sentences)}")
    print(f"空白区切りの語/トークン数: {len(words)}")

    if sentences:
        avg_chars = sum(len(s) for s in sentences) / len(sentences)
        print(f"平均文長: {avg_chars:.1f} 文字")
        long_sentences = [(i, str(len(s)), s) for i, s in enumerate(sentences, 1) if len(s) > 140]
    else:
        long_sentences = []

    print_findings("確認すべき自信過剰または効用主張", find_matches(sentences, OVERCONFIDENT_PATTERNS))
    print_findings("明示的に扱うべき不確実性マーカー", find_matches(sentences, UNCERTAINTY_PATTERNS))
    print_findings("埋め草または汎用的な枠付けの可能性", find_matches(sentences, FILLER_PATTERNS))

    print("\n## 長い文")
    if not long_sentences:
        print("明確な検出なし。")
    else:
        for idx, length, sentence in long_sentences:
            print(f"- S{idx}: {length} 文字")
            print(f"  {sentence}")

    print("\n## 推奨する手動確認")
    print("- 重要な主張を 事実 / 推論 / 意見 / 提案 / 不明 に分類する。")
    print("- 削除しても読み手の理解、判断、行動に影響しない文を削る。")
    print("- 圧縮時に、制約、根拠、不明点、トレードオフを保つ。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
