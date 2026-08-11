# Worktree Janitor Contract

## State transition

| From | Trigger | To | Artifact |
| --- | --- | --- | --- |
| observed | all safety checks pass | candidate | state JSON with HEAD, branch, PR and timestamp |
| candidate | grace period has not elapsed | candidate | unchanged state JSON |
| candidate | HEAD or eligibility changes | observed | old candidate removed |
| candidate | grace elapsed and revalidation passes | cleanup | JSONL result in stdout/journal |
| cleanup | worktree and branch removal succeed | cleaned | candidate removed from state JSON |
| any | dirty, active, protected or external error | preserved | reason in JSONL result |

## Required safety checks

- configured repository and base branch
- linked worktree with a local branch
- clean index, tracked files and untracked files
- no `.keep-worktree` marker in the worktree root
- branch does not match protected patterns
- no process cwd resolves inside the worktree
- GitHub PR is merged into the configured base branch
- current local HEAD equals the merged PR head OID
- candidate signature is unchanged for the configured grace period

External command failure, malformed output and missing metadata are preservation conditions.

## Ownership

- runner: discovery, classification, state, grace period and cleanup
- Git: worktree and local branch truth
- GitHub CLI: PR merge truth
- human: configuration and explicit keep marker
- systemd: periodic trigger and retained journal

## Completion

A cleanup is complete only when the worktree is no longer registered and its directory is gone. When branch deletion is enabled, the local branch is deleted only while it still points to the validated HEAD; a concurrently changed branch is preserved and reported. Partial failure is reported without force-removing dirty data.
