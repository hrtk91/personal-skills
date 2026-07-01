# Review Checklist

Use this checklist when reviewing an AI dev workflow, watchdog, QC wrapper, or repo automation change.

## State Machine

- Are terminal states typed and persisted?
- Is "diagnosis created" clearly separate from "repair completed"?
- Are retry limits mechanical and visible?
- Can a failed repair_action recurse forever?
- Is cleanup safe for dirty product worktrees?

## Completion Conditions

- Does success require the configured QC to be all green?
- Are failed tests repaired and rerun, not merely diagnosed?
- Are environment blocks distinct from implementation failures?
- Are skipped checks justified by affected-file logic?
- Are arbitrary short timeouts prevented from creating false blocked states?

## Watchdog Behavior

- Does the watchdog classify cause, or only detect failure?
- Does it enqueue the next allowed action?
- Does it stop with a typed handoff when unsafe?
- Does it detect stale running jobs and missing logs?
- Does it de-duplicate repeated identical failures?

## Observability

- Do long-running commands stream logs live?
- Is the same output retained for machine classification?
- Can a notification identify the failed numbered step and command?
- Are run, issue, PR, summary, trace, worktree, and retained log linked or named?
- If an outer timeout kills the wrapper, is partial evidence still available?

## E2E Coverage

- Are happy path and every major abnormal path covered with fake repo/fake executor tests?
- Are executor failure, QC failure, QC loop exhaustion, diagnosis failure, human_needed, repair_action success/failure, stale running, dirty worktree, missing logs, and notification content covered?
- Do tests assert queue/state artifacts, not only process output?
- Are live services excluded from workflow E2E tests?

## Naming

- Do names describe actual behavior?
- Is diagnosis-only behavior never called repair?
- Are working directories, worktrees, and runtime directories named in user-facing terms?
