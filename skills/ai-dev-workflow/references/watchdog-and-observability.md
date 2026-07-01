# Watchdog And Observability

Use this reference when building or reviewing a watchdog for AI coding workflows.

## Watchdog Contract

A watchdog is not a notifier. It must close the operational loop:

- observe queue, run, worker, worktree, and QC state
- classify the current failure or stall
- enqueue the next mechanical action when policy allows
- stop with a typed handoff when automation is unsafe
- record what it observed, what it decided, and what it enqueued

## Required Classifications

At minimum classify these states:

| Classification | Detection | Default action |
|---|---|---|
| stale_running | run heartbeat or step duration exceeds policy | mark timed_out or enqueue diagnosis |
| executor_failed | executor exits before QC | enqueue diagnosis unless purpose is diagnosis/repair_action |
| qc_failed | QC exits nonzero with actionable test output | rerun implementation/fix loop until limit |
| qc_incomplete | QC was killed or did not produce final status | preserve logs and retry/diagnose based on cause |
| environment_failure | Docker/socket/buildx/network/dependency failure | enqueue environment repair or human handoff |
| missing_logs | summary exists but no failed command/cause | enqueue log extraction/diagnosis, not a vague notification |
| dirty_worktree | terminal run left product diffs | archive and enqueue reuse/action job |
| repair_action_failed | action failed after diagnosis | stop visibly; do not recursively diagnose by default |

## Logging Requirements

Workflow logs must be useful while the command is still running:

- stream long-running command output live
- retain the same output in a file for retry classification
- include command, step, elapsed time, exit code, and timeout source
- preserve child process output when an outer timeout kills the wrapper
- keep links/paths to trace, summary, retained log, worktree, issue, and PR

Do not write wrappers that hide all output until the child command exits. If an outer watchdog kills that wrapper, the failure becomes opaque.

## Notification Requirements

Failure notifications should include:

- numbered workflow progress with success/failure markers
- failed step name, not only internal runner function
- failed command and exit code or timeout source
- extracted likely cause in one sentence
- what was already tried
- what action was enqueued next, or why automation stopped
- issue, PR, run, summary, trace, and worktree links/paths where available

Avoid messages that say only "check the summary". The summary is supporting evidence; the notification should carry the operational diagnosis.

## Automated Action Rules

- If logs are missing, enqueue log extraction or diagnosis before asking a human.
- If diagnosis produces a validated non-human draft, enqueue repair_action.
- If repair_action changes code, require QC all green before success.
- If environment repair is proposed, separate host-level repair from repo-level patch.
- If retrying, retry mechanically with bounded counts and preserved evidence.
- If the same classification repeats, escalate with the repeated evidence and stop creating identical jobs.

## E2E For Watchdogs

Use fake clocks, fake executors, and fake QC scripts to cover:

- stalled run becomes timed_out and diagnosis is enqueued
- command killed by outer timeout still has partial live log evidence
- missing summary/logs triggers log extraction rather than vague notification
- environment failure routes to environment repair
- repair_action failure does not create an infinite diagnosis loop
- repeated same failure hits a bounded retry limit and handoff
