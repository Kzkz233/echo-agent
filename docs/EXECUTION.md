# Execution workspace and worker delivery

## Conversation controls

Role-managed main conversations use the built-in Pi agent loop; the composer shows the
selected language model rather than an engine switcher. Configure the main model, project
directories and permissions in Edit Character. Each subtask has its own execution snapshot,
and group members inherit the character configuration. The public conversation operation cannot bypass this
ownership. Reconnecting the same configured binding and per-chat reasoning controls remain
available. Independent core conversations without a managed character retain their own
configuration so the kernel can run without Persona.

The inference interface exposes an optional session capability descriptor and structured
execution updates. The workbench renders only supported controls. Codex and embedded Pi
support active steering; DSH currently uses Echo's durable next-turn queue. DSH output is
shown when the SDK publishes events, including settled assistant messages. No simulated
per-token animation is used to disguise a nonstreaming protocol.

Echo persists plans, public reasoning information, tool calls, command output, file changes,
usage and native child-agent activity separately from conversation messages. Native deltas
are coalesced every 120 ms. A run retains at most 256 items, with 64 KiB of text and 32 KiB
of details per item. Long data is visibly marked truncated. Collapsed history loads activity
on demand. Execution logs do not become ordinary chat inputs or Review materials.

Steering targets one existing Echo/native run. The durable submission receipt is written
before dispatch. Acknowledged input joins canonical history as user speech. A timeout or
disconnect remains unknown and is not retried. Users can acknowledge that they checked an
unknown delivery without resending it. Queueing creates a new turn after current work;
queued inputs can be removed before execution. Cancellation is not a promise to undo work.

The composer supports image/text upload, paste/drop, and text references within a configured
project. Images are normalized to JPEG within 1920 px; text is UTF-8 up to 256 KiB. Up to
four attachments are allowed per message, each uploaded file at most 8 MiB. Originals used
for inference are stored separately from transcript metadata, scoped to the conversation,
and included in app backups. Arbitrary PDFs/audio are not advertised as working composer
attachments; the Knowledge/Document Processing plugins own richer document ingestion.

## Host mapping

- Codex App Server maps native item/plan/diff/usage events and `turn/steer`. Commands and
  file approvals retain the owning thread/turn. Native item completion remains authoritative.
- DSH SDK maps durable `session.event`, status and announced child sessions. Only descendants
  announced under the owned root can issue bridged approvals. Child output never replaces
  the root's final answer. SDK process teardown remains scoped to Echo's isolated home.
- Pi Agent Core exposes its message/tool events and steer queue. Echo keeps the existing
  native project read/search/edit/write tools. Explicit terminal opt-in lazily loads the official Pi Coding
  Agent PowerShell/Bash tool, and every command requires a workbench approval. This adds an
  execution tool, not a second owner for Echo's canonical chat history. The terminal runs
  with local user permissions; a project directory is not an OS sandbox.

Ordinary APIs remain generation transports; main conversations use Pi's tool loop on
top of those transports. Stateless auxiliary calls disable tools. Native capabilities and settings are not assumed identical
across hosts. Echo does not replicate every proprietary desktop feature or native command.

## Subtask authorization and acceptance

Delegation is a core role capability. A role grants additional execution models, directory
read/write scope, application tools, approval policy, optional terminal access, maximum
duration and concurrency. The main model is always available. The main agent chooses a
subset of these grants for each new subtask, together with its goal, acceptance criteria
and instructions. Manual delegation uses the same admission path. There is no reusable
Worker profile to create first. Each task freezes its own execution snapshot; continuation
revalidates it against the current role grants. A role sets main-conversation tools and
delegable tools separately. Each child receives only its selected tools that are still
delegable and available from active plugins. An empty selection grants no tools.
Upgrading preserves effective grants for existing conversations and subtasks.
Portable packages exclude local model bindings and directory grants.

Admission is serialized, while permitted executions can run concurrently. Requests are
deduplicated before creating worker identities. Overlapping active writable project roots
are rejected; choose a separately prepared worktree/directory or wait. Echo does not silently
merge concurrent modifications. Native host subagents are activity under their parent task,
not duplicate Echo Worker tasks.

A durable task identity survives multiple execution attempts. Each attempt has its own run,
result, checkpoints and acceptance state. The worker may submit a structured summary,
artifact paths, verification notes and unresolved issues. Echo checks artifact containment,
existence, size and SHA-256 for files up to 8 MiB. This proves file identity, not correctness
of the worker's explanation or success of arbitrary claimed tests. Worker-reported checks
remain distinguishable from program evidence.

Successful execution becomes **completed / awaiting review**. Only the originating role
or the user can mark that attempt accepted or needing revision. Missing/out-of-root artifacts
block acceptance. Workers cannot accept themselves. Accepted attempts are optional Review
materials. Continuation validates current policy; changed privileges require a new task.

When configured, settlement schedules one application-origin handoff into the originating
conversation. Related concurrent tasks are collected after they settle. Durable outbox and
submission IDs suppress repeat handoffs; unknown execution blocks automatic continuation.
The role can inspect and accept results during that handoff but cannot recursively start
more workers from it. There is no periodic model call to ask whether a task has finished.
If the parent is a plain API, it can summarize while acceptance remains available in the UI.

## Group context

Groups keep a canonical shared transcript with explicit authorship. Every member uses a
separate host conversation for that group, distinct from its private main conversation.
Context providers are explicitly limited to persona and delegation. Private main histories,
memory recall and knowledge injection are not automatically copied into groups. This is
context isolation, not a multi-tenant security boundary around all host filesystem tools.

The model receives its persona, the group's collaboration instructions/shared background/
roster when those change, and shared messages since that member's last acknowledged cursor.
The window defaults to the latest 40 new records and can be configured from 5 to 100. Full
shared history stays in Echo; the native session retains previously received group turns.
The member's own answers are not sent back as newly received messages. This is bounded
incremental delivery, not an additional model-generated summary or automatic compaction.

The cursor captures the input snapshot before generation and advances only after a confirmed
result. Messages that arrive while a role speaks remain unread for its next turn. Native
success recovered after a crash restores the reply and cursor without another model call.
Members selected for a turn speak once in the chosen order, with a bounded participant list;
there is no unbounded autonomous chat or extra LLM selecting every speaker.

## References and design choices

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) supplies structured execution
  items, active steering and turn-scoped approvals.
- [DeepSeek subagents](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
  informed the separation of durable child identity, each activation, caller/parent delivery
  and ownership. [DeepSeek Team](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/team/README.md)
  separates shared task coordination from the child runtime.
- [AutoGen group chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
  informed shared message broadcasting, centralized speaker selection and explicit termination.
  Echo currently uses user selection and deterministic ordering, avoiding a selector-model call.
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
  documents the event/session boundary; terminal tools are loaded from its official package.

These are design references and public protocol integrations. Echo does not import private
Workspace implementations or embed the complete DeepSeek/AutoGen frameworks.
