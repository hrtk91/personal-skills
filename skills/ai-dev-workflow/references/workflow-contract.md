# Workflow Contract

Use this reference when creating or changing an AI coding workflow state machine.

## Canonical Flow

```text
enqueue task
  -> create isolated worktree
  -> run executor
  -> run QC
  -> if QC red and attempts remain: append failure context and rerun executor
  -> if QC green: succeeded
  -> if terminal failure: enqueue diagnosis
  -> diagnosis creates validated draft
  -> if human_needed: stop with handoff
  -> else enqueue repair_action
  -> repair_action runs in fresh worktree
  -> repair_action must pass QC or fail visibly
  -> cleanup archives dirty worktrees and removes safe terminal worktrees
```

## Transition Rules

| From | Trigger | To | Required artifact |
|---|---|---|---|
| queued | worker claims job | running | queue row with run id |
| running | executor success | run_qc | logs and summary state |
| run_qc | QC green | succeeded | summary and notification |
| run_qc | QC red, attempts remain | run_executor | appended QC context |
| run_qc | QC red, attempts exhausted | qc_failed | failed summary |
| running | executor nonzero | failed | executor logs/observability |
| failed/qc_failed/timed_out/blocked | auto diagnosis enabled | diagnosis queued | diagnosis job id marker |
| diagnosis | validated draft | repair_action queued | repair.ini and action marker |
| diagnosis | human_needed | stopped | validated draft with human_needed |
| diagnosis | diagnosis failure | stopped | failed diagnosis run |
| repair_action | QC green | succeeded | repaired summary |
| repair_action | QC red/fail | terminal visible | failed action summary |
| terminal | cleanup policy allows | cleanup | archive or clean removal |

## Mechanical Guardrails

- The runner, not the LLM, decides retries, terminal status, and cleanup eligibility.
- A normal workflow failure may enqueue diagnosis. A diagnosis failure must not recursively enqueue diagnosis.
- A repair_action failure must not recursively enqueue diagnosis unless an explicit higher-level policy says so.
- A validated draft is a handoff artifact, not proof of repair.
- Every generated notification should include a numbered progress list and the failed command or failed step.

## Repo Adapter Boundary

Keep these repo-specific:

- issue/PR selection
- exact QC command
- affected-check logic
- merge policy
- notifier destination and message style
- executor workflow names

Keep these generic:

- queue schema
- worktree lifecycle
- state machine
- retry/loop mechanics
- diagnosis/action chaining
- cleanup safety checks
