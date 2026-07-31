#!/usr/bin/env python3
"""構造化された研究ログを初期化・検索・検証・索引化する。

読み始める場所:
1. CLI全体の流れを知りたい場合は、末尾の ``main`` を読む。
2. 各コマンドの実処理は、``init_log``、``query``、``validate_log``、
   ``build_index``を読む。
3. カードごとの制約は、``validate_experiment``、``validate_principle``、
   ``validate_skill_eval``を読む。
4. スキル自身の検証は、``validate_skill``と``self_test``を読む。

ファイルは「定数 → スキル検証 → ログI/O → カード検証 → コマンド処理 →
self-test → CLI入口」の順に並べる。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any


# =============================================================================
# 1. スキーマ定数
# =============================================================================

# 実験カードのライフサイクル。実行前の契約はplanned、実行中はrunning、
# 結果を閉じるときはaccepted / failed / inconclusiveのいずれかにする。
EXPERIMENT_STATUSES = {"planned", "running", "accepted", "failed", "inconclusive"}

# 方針カードの現在の扱い。activeは採用中、provisionalは検証不足、
# retiredは反証または前提変更により現在は使わない方針を表す。
PRINCIPLE_STATUSES = {"active", "provisional", "retired"}

# 方針カードの証拠強度。単一fixtureの結果だけでhighへ上げない。
CONFIDENCES = {"low", "medium", "high"}

# スキル名をフォルダ名とCLIで安全に扱えるhyphen-caseへ制限する。
# この形式により、先頭・末尾のハイフンや連続ハイフンも許可しない。
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

# 各集合はカード直下の必須キーだけを定義する。ドメイン固有の測定値や
# 将来のschema拡張を妨げないため、ここにない追加キーは拒否しない。

# 実験カードは「何を、どの条件で試し、何が分かったか」を再現できる形で残す。
EXPERIMENT_FIELDS = {
    # 識別情報
    "schema",
    "id",
    "date",
    # 問い、前提、仮説、過去実験との関係、実行方法
    "question",
    "context",
    "hypothesis",
    "prior_experiment_ids",
    "method",
    # ライフサイクルと評価契約、測定結果
    "status",
    "evaluation",
    "result",
    # 成功・失敗・適用限界と次の検証
    "worked",
    "failed",
    "limitations",
    "next",
}

# 方針カードは、複数の実験から再利用できる判断と反証履歴を残す。
PRINCIPLE_FIELDS = {
    # 識別情報と方針本文
    "schema",
    "id",
    "statement",
    # 現在の確からしさと採用状態
    "confidence",
    "status",
    # 根拠、適用範囲、反証
    "evidence_ids",
    "rationale",
    "scope",
    "counterevidence",
}

# スキル評価カードは、forward-testの合否と改善履歴を追跡する。
SKILL_EVAL_FIELDS = {
    # 識別情報
    "schema",
    "id",
    "date",
    "skill_version",
    # 評価ケース、採点基準、結果
    "cases",
    "rubric",
    "result",
    # 観測した失敗、加えた変更、次の検証
    "failures",
    "changes",
    "next",
}


# =============================================================================
# 2. スキルディレクトリの検証
# =============================================================================

def validate_skill(skill_dir: Path) -> list[str]:
    """SKILL.mdとUIメタデータが、外部依存なしで読める形式か検証する。"""

    # 処理順:
    # 1. SKILL.mdをUTF-8で読み、frontmatterの境界を確認する。
    # 2. frontmatterのキー、name、descriptionを検証する。
    # 3. agents/openai.yamlをUTF-8で読む。
    # 4. 必須UIフィールドと値の制約を検証して、全エラーを返す。

    # 1. SKILL.mdをUTF-8で読み、frontmatterの境界を確認する。
    errors: list[str] = []
    skill_dir = skill_dir.resolve()
    skill_md = skill_dir / "SKILL.md"
    try:
        content = skill_md.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        return [f"{skill_md}: cannot read as UTF-8: {exc}"]

    frontmatter_match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", content, re.DOTALL)
    if not frontmatter_match:
        return [f"{skill_md}: invalid YAML frontmatter boundaries"]

    # 2. frontmatterのキー、name、descriptionを検証する。
    frontmatter: dict[str, str] = {}
    for line in frontmatter_match.group(1).splitlines():
        match = re.match(r"^([a-zA-Z0-9_-]+):\s*(.+?)\s*$", line)
        if not match:
            errors.append(f"{skill_md}: unsupported frontmatter line {line!r}")
            continue
        key, value = match.groups()
        frontmatter[key] = value.strip("\"'")

    unexpected = set(frontmatter) - {"name", "description"}
    if unexpected:
        errors.append(f"{skill_md}: unexpected frontmatter keys {sorted(unexpected)}")

    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    if not SKILL_NAME_PATTERN.fullmatch(name):
        errors.append(f"{skill_md}: name must use lowercase hyphen-case")
    if name and name != skill_dir.name:
        errors.append(f"{skill_md}: name {name!r} does not match folder {skill_dir.name!r}")
    if not description:
        errors.append(f"{skill_md}: description is required")
    elif len(description) > 1024 or "<" in description or ">" in description:
        errors.append(f"{skill_md}: description has invalid length or angle brackets")

    # 3. agents/openai.yamlをUTF-8で読む。
    metadata = skill_dir / "agents" / "openai.yaml"
    try:
        metadata_text = metadata.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        errors.append(f"{metadata}: cannot read as UTF-8: {exc}")
        return errors

    # 4. 必須UIフィールドと値の制約を検証して、全エラーを返す。
    if not re.search(r"(?m)^interface:\s*$", metadata_text):
        errors.append(f"{metadata}: interface mapping is required")
    interface_values: dict[str, str] = {}
    for key in ("display_name", "short_description", "default_prompt"):
        match = re.search(
            rf'(?m)^  {key}:\s*"((?:[^"\\]|\\.)*)"\s*$',
            metadata_text,
        )
        if not match:
            errors.append(f"{metadata}: quoted interface.{key} is required")
        else:
            interface_values[key] = match.group(1)

    short_description = interface_values.get("short_description", "")
    if short_description and not 25 <= len(short_description) <= 64:
        errors.append(f"{metadata}: short_description must be 25-64 characters")
    default_prompt = interface_values.get("default_prompt", "")
    if name and default_prompt and f"${name}" not in default_prompt:
        errors.append(f"{metadata}: default_prompt must mention ${name}")
    return errors


# =============================================================================
# 3. 研究ログの保存先とJSON I/O
# =============================================================================

def research_dir(root: Path) -> Path:
    """対象リポジトリから研究ログの保存先を求める。"""

    return root.resolve() / ".research"


def write_json(path: Path, value: Any) -> None:
    """日本語を保持した読みやすいJSONとして保存する。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> Any:
    """UTF-8またはUTF-8 BOM付きのJSONを読む。"""

    return json.loads(path.read_text(encoding="utf-8-sig"))


def init_log(root: Path) -> None:
    """空の研究ログ構造を作り、最初の索引を生成する。"""

    # 処理順:
    # 1. カード種別ごとの保存ディレクトリを作る。
    # 2. 未作成の場合だけconfig.jsonを初期化する。
    # 3. 索引を生成し、研究ログの保存先を表示する。

    # 1. カード種別ごとの保存ディレクトリを作る。
    base = research_dir(root)
    for name in ("experiments", "principles", "skill-evals"):
        (base / name).mkdir(parents=True, exist_ok=True)

    # 2. 未作成の場合だけconfig.jsonを初期化する。
    config = base / "config.json"
    if not config.exists():
        write_json(
            config,
            {
                "schema": 1,
                "source_documents": [],
                "artifact_roots": [],
                "notes": "Add existing research docs and artifact directories.",
            },
        )

    # 3. 索引を生成し、研究ログの保存先を表示する。
    build_index(root)
    print(base)


def card_files(base: Path) -> list[tuple[str, Path]]:
    """カード種別とJSONパスを、安定した順序で列挙する。"""

    result: list[tuple[str, Path]] = []
    for kind, folder in (
        ("experiment", "experiments"),
        ("principle", "principles"),
        ("skill-eval", "skill-evals"),
    ):
        for path in sorted((base / folder).glob("*.json")):
            result.append((kind, path))
    return result


# =============================================================================
# 4. カードスキーマの検証
# =============================================================================

def validate_list(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")


def validate_experiment(card: dict[str, Any], label: str, errors: list[str]) -> None:
    """実験カードの必須項目、比較可能性、結果形式を検証する。"""

    # 処理順:
    # 1. カード直下の必須項目、status、配列項目を検証する。
    # 2. evaluationの形と必須項目を検証する。
    # 3. baselineとfixtureの比較可能性を検証する。
    # 4. resultのmetricsとartifactsを検証する。

    # 1. カード直下の必須項目、status、配列項目を検証する。
    missing = EXPERIMENT_FIELDS - card.keys()
    if missing:
        errors.append(f"{label}: missing {sorted(missing)}")
    if card.get("status") not in EXPERIMENT_STATUSES:
        errors.append(f"{label}: invalid status {card.get('status')!r}")
    for field in (
        "context",
        "prior_experiment_ids",
        "method",
        "worked",
        "failed",
        "limitations",
        "next",
    ):
        validate_list(card.get(field), f"{label}.{field}", errors)

    # 2. evaluationの形と必須項目を検証する。
    evaluation = card.get("evaluation")
    if not isinstance(evaluation, dict):
        errors.append(f"{label}.evaluation must be an object")
        return
    for field in (
        "fixture",
        "baseline",
        "metrics",
        "acceptance",
        "stop_condition",
        "comparable",
        "comparability_note",
    ):
        if field not in evaluation:
            errors.append(f"{label}.evaluation missing {field}")
    validate_list(evaluation.get("metrics"), f"{label}.evaluation.metrics", errors)
    validate_list(evaluation.get("acceptance"), f"{label}.evaluation.acceptance", errors)

    # 3. baselineとfixtureの比較可能性を検証する。
    baseline = evaluation.get("baseline")
    if not isinstance(baseline, dict):
        errors.append(f"{label}.evaluation.baseline must be an object")
    elif evaluation.get("comparable") is True:
        baseline_fixture = baseline.get("fixture")
        if baseline_fixture and baseline_fixture != evaluation.get("fixture"):
            errors.append(
                f"{label}: comparable=true but fixtures differ "
                f"({baseline_fixture!r} != {evaluation.get('fixture')!r})"
            )
        if not evaluation.get("comparability_note"):
            errors.append(f"{label}: comparable=true requires comparability_note")

    # 4. resultのmetricsとartifactsを検証する。
    result = card.get("result")
    if not isinstance(result, dict):
        errors.append(f"{label}.result must be an object")
    else:
        if not isinstance(result.get("metrics"), dict):
            errors.append(f"{label}.result.metrics must be an object")
        validate_list(result.get("artifacts"), f"{label}.result.artifacts", errors)


def validate_principle(card: dict[str, Any], label: str, errors: list[str]) -> None:
    """方針カードの状態、根拠、適用範囲を検証する。"""

    missing = PRINCIPLE_FIELDS - card.keys()
    if missing:
        errors.append(f"{label}: missing {sorted(missing)}")
    if card.get("confidence") not in CONFIDENCES:
        errors.append(f"{label}: invalid confidence {card.get('confidence')!r}")
    if card.get("status") not in PRINCIPLE_STATUSES:
        errors.append(f"{label}: invalid status {card.get('status')!r}")
    for field in ("evidence_ids", "scope", "counterevidence"):
        validate_list(card.get(field), f"{label}.{field}", errors)
    if not card.get("evidence_ids"):
        errors.append(f"{label}: principle requires evidence_ids")


def validate_skill_eval(card: dict[str, Any], label: str, errors: list[str]) -> None:
    """スキル評価カードの評価項目と結果形式を検証する。"""

    missing = SKILL_EVAL_FIELDS - card.keys()
    if missing:
        errors.append(f"{label}: missing {sorted(missing)}")
    for field in ("cases", "rubric", "failures", "changes", "next"):
        validate_list(card.get(field), f"{label}.{field}", errors)
    result = card.get("result")
    if not isinstance(result, dict) or "passed" not in result:
        errors.append(f"{label}.result must contain passed")


# =============================================================================
# 5. 研究ログに対するコマンド処理
# =============================================================================

def validate_log(root: Path) -> list[str]:
    """研究ログ全体と、カード間で参照するIDの整合性を検証する。"""

    # 処理順:
    # 1. .researchの存在を確認する。
    # 2. 全カードを読み、共通項目と重複IDを検証しながらID集合を作る。
    # 3. カード種別ごとのschemaと、方針から実験への参照を検証する。
    # 4. 収集した全エラーを返す。

    # 1. .researchの存在を確認する。
    base = research_dir(root)
    errors: list[str] = []
    if not base.exists():
        return [f"{base} does not exist; run init"]

    # 2. 全カードを読み、共通項目と重複IDを検証しながらID集合を作る。
    seen_ids: dict[str, Path] = {}
    experiment_ids: set[str] = set()
    cards: list[tuple[str, Path, dict[str, Any]]] = []
    for kind, path in card_files(base):
        try:
            card = load_json(path)
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{path}: invalid JSON: {exc}")
            continue
        if not isinstance(card, dict):
            errors.append(f"{path}: card must be an object")
            continue
        card_id = card.get("id")
        if not isinstance(card_id, str) or not card_id:
            errors.append(f"{path}: non-empty id is required")
        elif card_id in seen_ids:
            errors.append(f"{path}: duplicate id also in {seen_ids[card_id]}")
        else:
            seen_ids[card_id] = path
        if card.get("schema") != 1:
            errors.append(f"{path}: schema must be 1")
        cards.append((kind, path, card))
        if kind == "experiment" and isinstance(card_id, str):
            experiment_ids.add(card_id)

    # 3. カード種別ごとのschemaと、方針から実験への参照を検証する。
    for kind, path, card in cards:
        label = str(path.relative_to(base))
        if kind == "experiment":
            validate_experiment(card, label, errors)
        elif kind == "principle":
            validate_principle(card, label, errors)
            for evidence_id in card.get("evidence_ids", []):
                if evidence_id not in experiment_ids:
                    errors.append(f"{label}: unknown evidence id {evidence_id!r}")
        else:
            validate_skill_eval(card, label, errors)

    # 4. 収集した全エラーを返す。
    return errors


def build_index(root: Path) -> None:
    """有効なカードから検索用の軽量な索引を再生成する。"""

    base = research_dir(root)
    cards = []
    for kind, path in card_files(base):
        try:
            card = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        cards.append(
            {
                "kind": kind,
                "id": card.get("id"),
                "status": card.get("status"),
                "title": card.get("question")
                or card.get("statement")
                or card.get("id"),
                "path": str(path.relative_to(root.resolve())),
            }
        )
    write_json(base / "index.json", {"schema": 1, "cards": cards})
    print(base / "index.json")


def query(root: Path, keywords: list[str]) -> None:
    """カード本文を検索し、関連度が高い上位10件をJSON Linesで出力する。"""

    # 処理順:
    # 1. 検索語を大文字小文字を区別しない形式へ正規化する。
    # 2. 各カード内の出現回数を数え、候補を収集する。
    # 3. スコアとパスで安定ソートし、上位10件の要約を出力する。

    # 1. 検索語を大文字小文字を区別しない形式へ正規化する。
    base = research_dir(root)
    needles = [value.casefold() for value in keywords if value.strip()]

    # 2. 各カード内の出現回数を数え、候補を収集する。
    matches: list[tuple[int, str, Path, dict[str, Any]]] = []
    for kind, path in card_files(base):
        try:
            card = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        haystack = json.dumps(card, ensure_ascii=False).casefold()
        score = sum(haystack.count(needle) for needle in needles)
        if score or not needles:
            matches.append((score, kind, path, card))

    # 3. スコアとパスで安定ソートし、上位10件の要約を出力する。
    for score, kind, path, card in sorted(
        matches, key=lambda item: (-item[0], str(item[2]))
    )[:10]:
        print(
            json.dumps(
                {
                    "score": score,
                    "kind": kind,
                    "id": card.get("id"),
                    "status": card.get("status"),
                    "summary": card.get("question")
                    or card.get("statement")
                    or card.get("id"),
                    "path": str(path),
                    "failed": card.get("failed", []),
                    "next": card.get("next", []),
                },
                ensure_ascii=False,
            )
        )


# =============================================================================
# 6. 自己テスト用fixture
# =============================================================================

def sample_experiment(fixture: str = "fixture-a") -> dict[str, Any]:
    """自己テストで使う最小の正常な実験カードを返す。"""

    return {
        "schema": 1,
        "id": "sample-experiment",
        "date": "2026-01-01",
        "question": "Does the new method improve recall?",
        "status": "accepted",
        "context": ["Prior method missed one case."],
        "hypothesis": "The new stage recovers the missing case.",
        "prior_experiment_ids": [],
        "method": ["Run fixed fixture."],
        "evaluation": {
            "fixture": fixture,
            "baseline": {"experiment_id": "baseline", "fixture": fixture},
            "metrics": ["recall"],
            "acceptance": ["recall >= 0.8"],
            "stop_condition": "Score the fixed fixture once.",
            "comparable": True,
            "comparability_note": "Same fixture and scorer.",
        },
        "result": {"metrics": {"recall": 0.9}, "artifacts": ["result.json"]},
        "worked": ["Recovered the case."],
        "failed": [],
        "limitations": ["One fixture."],
        "next": ["Validate another fixture."],
    }


def self_test() -> None:
    """正常系と主要な失敗系を、一時ディレクトリだけで回帰テストする。"""

    # テストの流れ:
    # 1. Arrange: 一時研究ログと正常な実験カードを準備する。
    # 2. Act/Assert: 正常な研究ログがvalidationを通ることを確認する。
    # 3. Act/Assert: fixture不一致の直接比較が拒否されることを確認する。
    # 4. Arrange: 正常なスキルfixtureとUIメタデータを準備する。
    # 5. Act/Assert: 正常なスキルfixtureがvalidationを通ることを確認する。
    # 6. Act/Assert: 不正なUTF-8メタデータが拒否されることを確認する。
    # 7. Cleanup: 成否にかかわらず一時ディレクトリを削除する。

    # 1. Arrange: 一時研究ログと正常な実験カードを準備する。
    temp = Path(tempfile.mkdtemp(prefix="research-log-self-test-"))
    try:
        init_log(temp)
        write_json(
            research_dir(temp) / "experiments" / "sample-experiment.json",
            sample_experiment(),
        )

        # 2. Act/Assert: 正常な研究ログがvalidationを通ることを確認する。
        errors = validate_log(temp)
        if errors:
            raise AssertionError(f"valid fixture failed: {errors}")

        # 3. Act/Assert: fixture不一致の直接比較が拒否されることを確認する。
        invalid = sample_experiment("fixture-current")
        invalid["id"] = "invalid-comparison"
        invalid["evaluation"]["baseline"]["fixture"] = "fixture-other"
        write_json(
            research_dir(temp) / "experiments" / "invalid-comparison.json",
            invalid,
        )
        errors = validate_log(temp)
        if not any("fixtures differ" in error for error in errors):
            raise AssertionError("incompatible fixture comparison was not rejected")

        # 4. Arrange: 正常なスキルfixtureとUIメタデータを準備する。
        skill_dir = temp / "portable-skill"
        (skill_dir / "agents").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\n"
            "name: portable-skill\n"
            "description: Portable validation fixture.\n"
            "---\n"
            "\n"
            "# Portable Skill\n",
            encoding="utf-8",
        )
        metadata = skill_dir / "agents" / "openai.yaml"
        metadata.write_text(
            'interface:\n'
            '  display_name: "Portable Skill"\n'
            '  short_description: "Validate a portable skill metadata fixture"\n'
            '  default_prompt: "Use $portable-skill to validate this fixture."\n',
            encoding="utf-8",
        )

        # 5. Act/Assert: 正常なスキルfixtureがvalidationを通ることを確認する。
        errors = validate_skill(skill_dir)
        if errors:
            raise AssertionError(f"valid skill fixture failed: {errors}")

        # 6. Act/Assert: 不正なUTF-8メタデータが拒否されることを確認する。
        metadata.write_bytes(b"interface:\n  display_name: \"\xff\"\n")
        errors = validate_skill(skill_dir)
        if not any("cannot read as UTF-8" in error for error in errors):
            raise AssertionError("invalid UTF-8 metadata was not rejected")
        print("self-test: OK")
    finally:
        # 7. Cleanup: 成否にかかわらず一時ディレクトリを削除する。
        shutil.rmtree(temp, ignore_errors=True)


# =============================================================================
# 7. CLI入口
# =============================================================================

def main() -> int:
    """引数を解釈し、選択された研究ログコマンドを一度だけ実行する。"""

    # 処理順:
    # 1. subcommandと引数の定義を組み立てる。
    # 2. コマンドライン引数を解析する。
    # 3. 選択された処理へdispatchし、成功または失敗の終了コードを返す。

    # 1. subcommandと引数の定義を組み立てる。
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("init", "validate", "index"):
        child = subparsers.add_parser(command)
        child.add_argument("root", type=Path)
    skill_parser = subparsers.add_parser("validate-skill")
    skill_parser.add_argument("skill_dir", type=Path)
    query_parser = subparsers.add_parser("query")
    query_parser.add_argument("root", type=Path)
    query_parser.add_argument("keywords", nargs="*")
    subparsers.add_parser("self-test")

    # 2. コマンドライン引数を解析する。
    args = parser.parse_args()

    # 3. 選択された処理へdispatchし、成功または失敗の終了コードを返す。
    if args.command == "init":
        init_log(args.root)
    elif args.command == "validate":
        errors = validate_log(args.root)
        if errors:
            for error in errors:
                print(f"ERROR: {error}")
            return 1
        print("validation: OK")
    elif args.command == "index":
        build_index(args.root)
    elif args.command == "query":
        query(args.root, args.keywords)
    elif args.command == "validate-skill":
        errors = validate_skill(args.skill_dir)
        if errors:
            for error in errors:
                print(f"ERROR: {error}")
            return 1
        print("skill validation: OK")
    else:
        self_test()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
