#!/usr/bin/env python3
"""Initialize, query, index, and validate structured research logs."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any


EXPERIMENT_STATUSES = {"planned", "running", "accepted", "failed", "inconclusive"}
PRINCIPLE_STATUSES = {"active", "provisional", "retired"}
CONFIDENCES = {"low", "medium", "high"}
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

EXPERIMENT_FIELDS = {
    "schema",
    "id",
    "date",
    "question",
    "status",
    "context",
    "hypothesis",
    "prior_experiment_ids",
    "method",
    "evaluation",
    "result",
    "worked",
    "failed",
    "limitations",
    "next",
}
PRINCIPLE_FIELDS = {
    "schema",
    "id",
    "statement",
    "confidence",
    "status",
    "evidence_ids",
    "rationale",
    "scope",
    "counterevidence",
}
SKILL_EVAL_FIELDS = {
    "schema",
    "id",
    "date",
    "skill_version",
    "cases",
    "rubric",
    "result",
    "failures",
    "changes",
    "next",
}


def validate_skill(skill_dir: Path) -> list[str]:
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

    metadata = skill_dir / "agents" / "openai.yaml"
    try:
        metadata_text = metadata.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        errors.append(f"{metadata}: cannot read as UTF-8: {exc}")
        return errors

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


def research_dir(root: Path) -> Path:
    return root.resolve() / ".research"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def init_log(root: Path) -> None:
    base = research_dir(root)
    for name in ("experiments", "principles", "skill-evals"):
        (base / name).mkdir(parents=True, exist_ok=True)
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
    build_index(root)
    print(base)


def card_files(base: Path) -> list[tuple[str, Path]]:
    result: list[tuple[str, Path]] = []
    for kind, folder in (
        ("experiment", "experiments"),
        ("principle", "principles"),
        ("skill-eval", "skill-evals"),
    ):
        for path in sorted((base / folder).glob("*.json")):
            result.append((kind, path))
    return result


def validate_list(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")


def validate_experiment(card: dict[str, Any], label: str, errors: list[str]) -> None:
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

    result = card.get("result")
    if not isinstance(result, dict):
        errors.append(f"{label}.result must be an object")
    else:
        if not isinstance(result.get("metrics"), dict):
            errors.append(f"{label}.result.metrics must be an object")
        validate_list(result.get("artifacts"), f"{label}.result.artifacts", errors)


def validate_principle(card: dict[str, Any], label: str, errors: list[str]) -> None:
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
    missing = SKILL_EVAL_FIELDS - card.keys()
    if missing:
        errors.append(f"{label}: missing {sorted(missing)}")
    for field in ("cases", "rubric", "failures", "changes", "next"):
        validate_list(card.get(field), f"{label}.{field}", errors)
    result = card.get("result")
    if not isinstance(result, dict) or "passed" not in result:
        errors.append(f"{label}.result must contain passed")


def validate_log(root: Path) -> list[str]:
    base = research_dir(root)
    errors: list[str] = []
    if not base.exists():
        return [f"{base} does not exist; run init"]
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
    return errors


def build_index(root: Path) -> None:
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
    base = research_dir(root)
    needles = [value.casefold() for value in keywords if value.strip()]
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


def sample_experiment(fixture: str = "fixture-a") -> dict[str, Any]:
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
    temp = Path(tempfile.mkdtemp(prefix="research-log-self-test-"))
    try:
        init_log(temp)
        write_json(
            research_dir(temp) / "experiments" / "sample-experiment.json",
            sample_experiment(),
        )
        errors = validate_log(temp)
        if errors:
            raise AssertionError(f"valid fixture failed: {errors}")

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
        errors = validate_skill(skill_dir)
        if errors:
            raise AssertionError(f"valid skill fixture failed: {errors}")

        metadata.write_bytes(b"interface:\n  display_name: \"\xff\"\n")
        errors = validate_skill(skill_dir)
        if not any("cannot read as UTF-8" in error for error in errors):
            raise AssertionError("invalid UTF-8 metadata was not rejected")
        print("self-test: OK")
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def main() -> int:
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
    args = parser.parse_args()

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
