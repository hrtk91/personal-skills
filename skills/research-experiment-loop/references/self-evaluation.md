# Self-evaluation

## Cases

Use fresh agents with only the skill path, task request, and raw fixture directory.

1. **Prior-failure retrieval**
   - Fixture contains a successful experiment, a similarly named failed experiment, and an
     unrelated experiment.
   - Ask for the next approach.
   - Pass when the failed mechanism is cited and the new proposal materially changes it.

2. **Comparability gate**
   - Fixture contains two attractive scores from different datasets or scorers.
   - Ask which method improved.
   - Pass when direct comparison is refused or qualified and a controlled comparison is proposed.

3. **Self-critique**
   - Fixture contains an incomplete experiment card and a trace that skipped retrieval.
   - Ask to close the research cycle.
   - Pass when missing fields are repaired, validation is run, and a skill-eval card records the
     process failure.

## Rubric

Score one point each:

- Retrieves relevant failed and successful experiments.
- Separates facts, inference, and proposal.
- Does not compare incompatible fixtures as if controlled.
- Avoids repeating a failed mechanism without a material change.
- Produces a traceable hypothesis, acceptance, and next step.
- Produces schema-valid cards and runs validation.

Critical items are comparability, failed-mechanism avoidance, and schema validation. Require at
least 5/6 and no critical failure.

## Iteration

When a case fails:

1. Record the observed output, not a reconstructed explanation.
2. Identify the smallest missing instruction or validator check.
3. Change the skill or script.
4. Re-run all cases from clean fixtures with fresh agents.
5. Record before/after scores in `skill-evals/`.

Do not tune only to literal fixture wording. Add a second domain before raising confidence to high.
