# Proactive conversation, email signals and current concerns

## Ownership and workspaces

Shared settings contain inference connections/model resources, messaging connections, plugins
and runtime maintenance. A model resource describes what is available; the role editor selects
what a character uses. Character-scoped inference tasks declare `scope: character` and are not
edited in the shared-defaults form. Saving a character pins its selected auxiliary model IDs.
Unchanged task configurations retain their schedule state when other role settings are edited.

Calendar, knowledge/files, mail and notifications are shared workspaces registered on
the main window. They do not require a character. A role may separately attach reminders,
review sources, channels and automation tasks to them. Messaging gateway credentials remain
shared; conversation bindings are shown within their character workspace.

Observe, Care and Email Triggers use the same automation action entry point. Each task
evaluates its own policy. The shared entry point checks the registered source, action, expiry
and conversation availability. Observe clues age out of proactive interaction after ten
minutes. This does not discard observation records from Review or the archive.
The native capture helper measures authorized area and brightness separately. An entirely
unreadable batch records its verified source without requesting vision or a bubble.
The completion notice for memory review uses a short report from its final packet.
Checkpoint notes remain in the review record.

Website observation is task-scoped: each role selects browser executables and allowed domains.
The built-in URL reader uses Windows UI Automation and works only when a browser exposes a
visible document URL through that interface. Chrome, Edge, Brave and Firefox are suggested
defaults; users can edit, remove or add process names/paths. Other browsers may work if they
expose the same UI Automation data, but are not guaranteed.

Source identification is contributed through `observation.source-readers@1`.
`contributeSourceReader` accepts a typed descriptor with a label, kind, editable
process presets and a native strategy (`uia-document` or `process-window`). Custom
plugins can register their browsers or application windows. Task rows select a
reader and process explicitly; registering a reader never grants capture consent.
Website domains still pass the native allowlist, occlusion mask and before/after
scene-proof checks. Application-window observation requires an explicit process
allowlist rule. Unsupported identification strategies require a native adapter,
not a claim of unrestricted browser support. Unloading or replacing a reader
invalidates a pending frame before it can enter vision inference.

Review can resume a paused job using an explicitly selected alternative model.
Frozen packets and completed checkpoints are retained. The run records its model
override and prior errors; changing recovery model does not rewrite task settings.
Review pins the selected model for each job. Pi is the default executor; a model
from an enabled external Worker plugin runs as an isolated Review Worker. Observe
and recall/query construction retain independently selected API models. The UI
does not prescribe a model size or describe a model as inherently lightweight.

## Care opportunities

A check interval is an opportunity to consider speaking, not a promise to call a model.
Every task owns its schedule, timezone, probability policy, daily cap, quiet interval and
prompt. The default policy draws a daily allowance of 0/1/2/3 with weights 10/35/35/20.
At each eligible slot its chance is remaining allowance divided by remaining eligible checks.
An independent fixed-percentage mode is also available. Both honor a hard daily attempt cap.
Silence, failure and unknown outcomes still consume an admitted attempt; retries cannot
circumvent the budget. Slots and daily counters survive plugin reload and process restart.
Existing same-day Care runs are counted when initializing the new policy.

Active or unresolved execution, queued input, recent actual user messages and registered
observation blockers are checked before drawing a probability or gathering model context.
Scope can be the target conversation, its character, or all Echo-managed conversations.
Human lookup is indexed and is not limited by how many program records followed the message.
Observation blocks only when it has fresh allowed visible content, not merely because its task
is enabled. Missing eligible time does not create catch-up messages. A missed probability
uses no model tokens. All checks are local; no new process or model-polling loop is introduced.

With 30 complete eligible checks, the default allowance averages 1.65 attempts/day in theory,
with at most three. Real activity/observation filtering can reduce this. This is not a billing
measurement, nor a claim to know whether an unrelated external Harness window is busy.

## Email triggers

Email Workspace owns synchronization and a bounded `mail.arrivals@1` metadata stream.
Email Triggers is an optional enhancement that consumes that contract. It does not read
the mail plugin's private records. Initial synchronization, historical backfill, repeat UIDs
and a changed UIDVALIDITY baseline do not create new-mail alerts.

Each trigger task selects accounts, exact sender addresses or domains, subject terms,
exclusions, unread-at-sync and incoming-folder conditions, matching mode, active hours,
batching interval and maximum pending age. Empty sender/subject conditions do not mean
"notify everything": that choice requires an explicit switch. Enabling or editing a rule
starts at the current stream cursor instead of replaying old mail.

Actions are either a deterministic Notification Center record, optionally linked to a
conversation/bubble, or one application-origin `trigger` turn asking the role to assess a
matched batch. Ordinary personality/memory context still applies to the latter. It is not
human speech and grants no new project or approval privileges. Model instructions treat
mail metadata as untrusted material, not executable requests. Mail content is not sent or
replied to by this plugin. Generated email reminders are forwarded to external channels only
when that source is explicitly selected in the channel binding; ordinary program notices
follow the existing notification channel policy.

Each batch has a stable identity and durable receipt. Busy conversations defer dispatch.
Unknown model runs require normal host reconciliation and are not reissued after restart.
If a batch was marked running before a conversation run was created, it can return to pending.
The age limit still applies when it resumes. The built-in notification center handles notice actions.
There are at most 200 pending metadata items per task, 20 per dispatched batch. The mail
stream retains at most 10,000 entries/30 days; finished trigger receipts expire after 90 days.
Configured maximum pending age also discards stale clues. Raw mail remains owned by Mail.
Default trigger tasks are disabled; no sender importance or personal rules are guessed.

## Current concerns

The enhancement keeps things a character currently cares about and may want to revisit.
It is not a store for every opinion and it has no solved/archive task workflow. The UI lives
beside Core Memories and Other Memories, while remaining independently optional.

Records may be added, revised or allowed to fade. Revisions and faded records remain in
local history; old-format retired records are preserved there during migration. No ordinary
or core memories are moved or rewritten by that migration.

The context reminder says to bring concerns up naturally when relevant, not recite a list.
Review separately maintains this target using `add`, `update`, and `forget`, with source
references and expected versions. It need not change concerns without new relevant evidence.
Long-term feelings, relationship experiences and stable preferences can still be memories;
the reviewer distinguishes a reported feeling or interpretation from a confirmed fact.
Individual Review tasks retain their own additional instructions for this target.
