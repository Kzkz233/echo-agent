# Work sessions

Delegated tasks and Agent automation use the same `WorkSessions` runtime. A work session belongs to one character and has one parent conversation, one backend binding and at most one active execution. Its origin identifies the task type, task ID and owning plugin. The task workspace shows these sessions alongside manually delegated work.

An automation owns its execution settings. Its work-session view links to that automation instead of offering another editable configuration. Continuing tasks reuse their conversation; tasks configured for fresh context create a separate session for each run. Paused Review batches retain their frozen materials without preventing later batches from collecting new material.

## Context and limits

Child conversations include persona and core memory by default. Automatic memory recall, concerns and sticker context are optional. Plugins declare context blocks through `core.context@3`, with a label and a worker default (`default`, `optional`, or `required`). Users select registered blocks in role defaults or override that selection for a task. Unloading a provider removes its injection without erasing saved selections.

Pi workers inherit the character's context-compaction policy unless overridden for the task. Compaction applies both between runs and during an ongoing tool loop, preserving tool-call/result pairs. Canonical history is retained. Output limits apply to each model call and inherit the selected model unless explicitly overridden. There is no cumulative task token allowance. Native workers manage compaction in their own host; unsupported controls are not offered as if Echo could enforce them.

## Authorization

Manual delegation and general prompt automation use the character's existing model, directory and tool grants. Automation does not bypass those grants. Domain-specific automation can issue a scoped, temporary authority for its own operations: Review permits only the configured memory operations, on the owning character, with evidence from its frozen materials. File writes and terminal access remain disabled for Review. Grants expire when execution ends or the task is revoked.

Review reads sources through `review.readMaterial`, checkpoints each packet, searches bounded memory candidates with `memory.search`, and reads full current records before `memory.change`. Ordinary changes are version checked. Core changes create a pending user approval; they do not modify active core memory. Optional Review targets remain registered contributions. The former JSON review implementation is retained only for historical checkpoints and explicit legacy configurations.

## Results

`TaskResults` records one durable, model-visible result in the parent conversation. Its idempotency key prevents duplicate records and inference. Channel presentation records remain separate.

- **Report results off:** retain the result without waking the character or sending to a channel.
- **Report results on:** wake or queue the parent to report through the selected channels, using the task's reporting instructions and `echo_respond`.

Destinations are frozen before execution; changing a binding cannot redirect a result already in progress. Human input retains queue priority. Expired queued observation results do not trigger stale inference. Program-only notices also record their result without requiring another model call.

Review interruptions use the same result path, preserving confirmed changes and recording one failure per execution attempt. They do not rerun the worker. The reporting switch decides whether the parent is woken; repeated scheduler checks do not repeat a failure report. An explicit resume can later produce a separate completion report. Ordinary delegated tasks use the character's handoff defaults; automation owns its own reporting settings.

Interrupted reviews include a count of journal-confirmed ordinary-memory operations from that batch's executions. Worker tool receipts are attached to their run; older completed traces are verified against the journal. Reply receipts list completed and remaining destinations so an accepted partial delivery cannot be mistaken for completion of every selected channel.

Application schedules, including mailbox synchronization, remain outside character configuration. Characters choose mailbox access and reminder tasks. Editing, disabling or removing a character's mail capability does not alter application synchronization plans.

General prompt tasks are supplied by the Task System through the ordinary automation type registry. `delegation.schedule` creates a prompt task, while `automation.manage` manages registered task types within the current character's authorization. Plugins still supply specialized scheduling, material readers and execution logic; the runtime does not execute arbitrary uploaded scripts.
