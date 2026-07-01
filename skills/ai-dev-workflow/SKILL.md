---
name: ai-dev-workflow
description: Design, implement, or harden AI coding workflows that run LLM implementation jobs with isolated worktrees, QC gates, diagnosis/repair loops, notifications, merge gates, and cleanup. Use when creating reusable repo automation, agent-workflow/takt/Codex/Claude-style coding pipelines, failure recovery flows, workflow templates, or when asked to make the workflow itself reliable with abnormal-path integration tests.
---

# AI Dev Workflow

Use this skill to build a reliable AI coding workflow, not just a script that starts an agent. The main output should be a small runner/wrapper plus a tested workflow contract.

## Core Rule

Design the state machine first. Then implement scripts/config. Then write integration tests for the state machine, especially abnormal paths.

Do not stop at “diagnosis was created” or “QC was rerun.” A workflow is complete only when the configured completion condition is reached, usually QC green, handoff explicitly required, or a typed terminal state is recorded.

## Required Workflow Contract

Before editing, define the workflow in these states:

```text
queued
running
succeeded
qc_failed
failed
timed_out
blocked
diagnosis
repair_action
cleanup
```

For each state transition, specify:

- trigger: what event moves the workflow
- owner: machine, LLM, human, or external service
- artifact: state file, summary, draft, patch, PR, or notification
- next action: enqueue, retry, repair_action, cleanup, merge, or stop
- completion condition: exact green/handoff condition

Read [workflow-contract.md](references/workflow-contract.md) when designing or changing state transitions.

## Implementation Pattern

Prefer a small deterministic runner around flexible LLM work:

- runner owns queue, worktree isolation, timeout, state files, retry limits, notifications, and cleanup
- LLM executor owns analysis, implementation, diagnosis, and repair edits
- QC command owns completion truth
- repo adapters own issue selection, notification text, merge policy, and repo-specific checks

Keep AI judgment out of mechanical control flow:

- Loop counts are numeric.
- Terminal states are typed.
- `diagnosis` does not mean repaired.
- `repair_action` is where fixes happen.
- `human_needed` stops the chain.
- Dirty worktrees are archived/classified before cleanup.

## Mandatory E2E Coverage

Every workflow template must include integration tests that run against a fake repo and fake executor. These tests should not call live services.

At minimum cover:

- happy path: task -> executor -> QC green -> succeeded
- QC repair loop: QC fails, executor reruns, QC eventually green
- loop exhaustion: QC stays red and terminal state is visible
- executor failure: diagnosis job is enqueued
- diagnosis success: validated draft creates repair_action job
- diagnosis failure: no repair_action is created
- human_needed: no repair_action is created
- repair_action success: QC green and succeeded
- repair_action failure: terminal state visible, no recursive diagnosis loop
- timeout/stale running recovery
- dirty worktree archive/reuse/cleanup behavior
- notification content includes progress and failure cause

Read [e2e-coverage.md](references/e2e-coverage.md) before finishing a new workflow or changing failure recovery.

## Naming

Use names that describe what actually happens:

- `diagnosis`: inspect failure and create a typed repair draft
- `repair_action`: perform the fix and make QC green
- `qc_loop`: executor/QC retry loop before diagnosis
- `worktree_janitor`: archive/classify/delete run worktrees
- `merge_gate`: decide whether PR can merge

Avoid naming a diagnosis-only workflow “repair.” It creates the wrong operational expectation.

## Output Checklist

When implementing an AI dev workflow, finish with:

- state transition summary
- changed files
- exact commands/tests run
- E2E coverage added or updated
- known states intentionally not automated
- current queue/worker status if touching live automation

If a live existing failed run has already passed diagnosis before the new repair_action hook exists, enqueue or explicitly account for the repair_action once after deploying the new runner.
