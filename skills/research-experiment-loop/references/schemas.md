# Research log schemas

Store UTF-8 JSON under `.research/`. Use relative artifact paths when possible.

## Experiment card

```json
{
  "schema": 1,
  "id": "minutes-atomic-topic-v10",
  "date": "2026-07-27",
  "question": "Can atomic topics improve agenda membership?",
  "status": "accepted",
  "context": ["Long blocks contain multiple decision axes."],
  "hypothesis": "Proposal anchors plus conservative grouping reduce over-merge.",
  "prior_experiment_ids": ["minutes-one-shot-clustering"],
  "method": ["Extract atomic claims", "Judge proposal pairs"],
  "evaluation": {
    "fixture": "qmsum-es2004a-ja",
    "baseline": {
      "experiment_id": "minutes-two-pass",
      "fixture": "qmsum-es2004a-ja"
    },
    "metrics": ["proposal_recall", "topic_f1", "over_merge"],
    "acceptance": ["proposal_recall >= 0.8", "over_merge == 0"],
    "stop_condition": "Stop after the fixed fixture is scored.",
    "comparable": true,
    "comparability_note": "Same fixture and scorer."
  },
  "result": {
    "metrics": {"proposal_recall": 1.0, "topic_f1": 0.718},
    "artifacts": ["dist/eval/result.json"]
  },
  "worked": ["Proposal recovery found the missing anchor."],
  "failed": ["Free clustering over-merged decision axes."],
  "limitations": ["One meeting", "CPU fallback"],
  "next": ["Validate unchanged rules on another meeting."]
}
```

Allowed experiment status:

- `planned`
- `running`
- `accepted`
- `failed`
- `inconclusive`

## Principle card

```json
{
  "schema": 1,
  "id": "do-not-union-whole-blocks",
  "statement": "Do not merge complete blocks from one shared subtopic.",
  "confidence": "high",
  "status": "active",
  "evidence_ids": ["minutes-pair-structure", "minutes-atomic-topic-v10"],
  "rationale": "Long blocks contain multiple independent decision axes.",
  "scope": ["meeting-minutes", "long-context"],
  "counterevidence": []
}
```

Confidence is `low`, `medium`, or `high`. Status is `active`, `provisional`, or
`retired`.

## Skill evaluation card

```json
{
  "schema": 1,
  "id": "research-experiment-loop-v1",
  "date": "2026-07-27",
  "skill_version": "1",
  "cases": ["prior-failure-retrieval", "comparability-gate", "self-critique"],
  "rubric": ["retrieval", "comparability", "traceability"],
  "result": {"passed": true, "score": 6, "maximum": 6},
  "failures": [],
  "changes": ["Initial version"],
  "next": ["Forward-test on a different project."]
}
```
