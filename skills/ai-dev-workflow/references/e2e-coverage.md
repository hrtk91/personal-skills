# E2E Coverage Matrix

Use this reference before declaring an AI dev workflow reliable.

## Test Shape

Create integration tests that use:

- temporary git repo
- temporary workflow state directory
- fake executor script
- fake QC command
- no network
- no real GitHub, Discord, Slack, deploy, or production daemon

The fake executor should branch on task text or environment variables to simulate:

- successful implementation
- executor failure
- diagnosis draft creation
- diagnosis failure
- human_needed draft
- repair_action success
- repair_action failure
- QC becoming green after N attempts

## Required Cases

| Case | Expected result |
|---|---|
| happy path | one workflow job succeeds, no diagnosis job |
| QC repair loop succeeds | executor and QC attempts > 1, final succeeded |
| QC repair loop exhausted | final qc_failed, diagnosis queued if enabled |
| executor failure | final failed, diagnosis queued if enabled |
| diagnosis creates draft | diagnosis succeeds and repair_action queued |
| diagnosis fails | diagnosis terminal failure, no repair_action |
| human_needed draft | diagnosis succeeds, no repair_action |
| repair_action succeeds | repair_action succeeds with QC green |
| repair_action QC fails | repair_action qc_failed visible, no recursive diagnosis |
| stale running recovery | old running jobs become failed on worker restart |
| dirty artifact-only worktree | archived and cleaned |
| dirty product worktree | archived and converted to reuse/action job |
| notification failed run | includes numbered progress and failure cause |
| merge gate approved | merge action only after green checks |
| merge gate blocked | no merge and clear reason |

## Assertions

Assert database/queue state, not only process output:

- job purpose: `workflow`, `repair`/`diagnosis`, `repair_action`
- job status
- run id linkage
- repair draft id and action marker
- summary path exists
- worktree path state
- notification text contains progress and cause

## Anti-Patterns

- Only testing the successful path.
- Treating a created draft as a completed repair.
- Letting repair_action failures recursively create more diagnosis jobs by default.
- Testing against live GitHub or live notification services.
- Cleaning dirty worktrees without archiving product diffs.
