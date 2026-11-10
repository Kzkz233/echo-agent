# Characters, packages and delegated work

Structured execution, subtask authorization and incremental group context are detailed in
[Execution workspace](EXECUTION.md).

Echo's main window contains characters, groups and shared workspaces for knowledge, calendar, mail and notifications. Settings holds only shared connections/model resources, installed plugins and maintenance. Roles own their usage, permissions, channels and tasks. Closing settings does not close conversations or the native avatar.

## One configuration through the character lifecycle

Create a character through six steps: starting template and capabilities, identity
and appearance, memory and knowledge, execution backends and permissions, tasks,
then confirmation. Save an unfinished draft or edit an existing character through
the same editor. The task list opens that editor at the task step.

The identity step includes optional expression preferences for QQ, desktop bubbles,
and ChatStick. A blank field uses the corresponding default. QQ and bubble preferences
apply to the matching turn. Observation keeps its own interaction prompt on each task.
Sticker preferences guide selection when ChatStick is enabled for the character.
The application validates attachment format and delivery permissions.

The Persona plugin owns identity and the character manifest. Each enabled plugin
owns its configuration and operational records. `core.characters.features@1`
provides versioned describe/read/validate/save/pack/unpack operations, using
`character.contribute` and `character.configure` permissions. A plugin's `.character`
descriptor registers `<plugin-id>.character`; descriptors contain editable fields,
optional task types, a schema and owner callbacks. Installing a new contributor adds
choices to the editor without teaching Persona about its business logic.

Task descriptors still use `core.automation.types@1`. Character setup creates actual
owner-managed tasks rather than another scheduler. Sources and prompts remain on
individual tasks. Mail sync can be selected through the Mail capability even though
Scheduler owns its execution. Required plugin dependencies form a DAG. Optional
providers and role capability selection do not introduce reverse hard dependencies.

The character record holds selected capability IDs, main-conversation ID, task
references, route overrides and a revision. Plugin configuration is stored only by
its owner. Main conversations use one active backend binding. A newly created role
without a chosen backend waits for configuration rather than invoking a global model.
Main conversations use the built-in Pi agent loop with the selected language model. Codex
and DSH are optional subtask executors; pure API calls remain available for auxiliary tasks.

Saving validates selections and resource bindings, rejects stale revisions, stages
tasks paused, applies plugin configuration, binds the main conversation, and enables
the requested tasks last. A durable request receipt prevents repeated successful
saves from duplicating conversations or tasks. A partial save is marked for attention;
unknown host bindings require reconciliation rather than a second host session.
Capability-dependent background work pauses while configuration is incomplete.

## Portable character packages

`echo-character-v1` contains persona text, versioned feature defaults, task templates,
and optional validated frame assets. API credentials, local paths, backend
bindings, conversation history and memory records are excluded. Export presents a
preview because persona and task prompts themselves may contain personal information.
Packages do not execute scripts or install missing plugins.

Import creates an editable draft with a new identity. Tasks start paused and resource
bindings must be selected on this machine. Missing plugins are reported. Author
defaults and locally resolved assets are tracked separately. Updating the same package
uses a three-way merge: untouched values follow the author's new defaults, locally
changed values remain, and arrays are treated as whole values. Review the resulting
draft before saving. A changed package identity is not an update to an existing role.

## Groups

A group has members, shared background and an attributed shared transcript. For each
turn the user selects who responds; selected members respond sequentially once. Each
member has a dedicated host conversation for that group, using its main backend,
persona and current permissions. Private main-chat history and private memory are not
automatically copied into the group. Each member has its own acknowledged shared-message
cursor. Only new shared records are sent, defaulting to a 40-message window; its own
answers are excluded from new input. Group background is included when it changes.

Group turns have durable request IDs and completed-member checkpoints. Unknown
execution blocks another turn. Reconciliation restores already completed host replies
to the shared transcript without running the model again. Remaining unexecuted members
are not silently replayed. Delegated results originating in a member's group conversation
are also mirrored into the shared transcript with that member's attribution.

## Task delegation

Task delegation is a core character capability. Each role chooses its authorization
ceiling, maximum concurrency and return policy. Every new subtask selects its own model,
reasoning, project directories, permissions, instructions and per-attempt timeout within
those grants. No reusable Worker configuration is required.
Project work requires Pi, Codex or DSH; a plain text API is not advertised as a project
execution agent. The main character and worker may use different backends.

A request specifies a goal, acceptance criteria and bounded relevant context. Echo
creates a separate worker conversation and durable task. The worker receives that
brief, not the role's complete private chat or memory. Project tools and approvals are
the selected backend's real capabilities. Codex has read-only/workspace-write policy;
Pi exposes its configured tools and project-write policy; DSH's native file privileges
remain governed by its preset. DSH approval requests are relayed to Echo when supported.
The application does not equate these hosts' permission implementations.

Native approvals and questions appear in the workbench and a global pending indicator.
Workers can save checkpoints and submit artifact paths and verification notes. Execution
completion awaits separate acceptance. Results return as program records; when configured,
an event-driven handoff lets the main role inspect and summarize them. Accepted
work is an optional Review source. Checkpoints are references and text, not an invented
cross-host serialization of native tool state. Nested worker delegation is currently
disabled; the parent role can arrange follow-up tasks.

MCP writes require a short-lived authority supplied to a live eligible turn, scoped to
its originating conversation. A caller-supplied conversation ID alone cannot authorize
a task. User interface requests use the authenticated local operation interface. Stable
request IDs prevent repeat acceptance. Unknown side effects require host reconciliation.
Resuming validates the current role policy and concurrency; changed backend/project/
permissions require a new delegation. Revoking or changing a role's delegation policy
cancels its active workers. Plugin unload cancels workers and unregisters contributions.

## Verification boundary

Automated coverage uses temporary data and local fake inference/host endpoints. It
checks configuration reuse, package asset validation and upgrade merging, ownership,
permission withdrawal, duplicate suppression, group attribution, interruption recovery,
UI creation/editing and the independent native settings window. It does not spend paid
model tokens or prove that an arbitrary third-party preset grants a specific sandbox.


## Character activity (0.15)

`characters.setActive` changes the runtime activity of an existing character using an optimistic revision. It does not rewrite the character draft, per-task enable intent, avatar profile, memory or history. `character.activity.changed` is the lifecycle event. Router-owned cancellation signals fence in-flight generation even across an immediate disable/enable cycle. Queued inputs, bubbles and unstarted channel deliveries are cancelled or expired; messages arriving while inactive are consumed without replay. Irreversible external effects already performed cannot be undone; ambiguous deliveries remain unknown and are never retried automatically.

Observe releases sampling when no active character needs it and starts with fresh frames. Care suspends admissions. Review preserves validated checkpoints; an interrupted read can resume on reactivation when its task is still enabled, while arbitrary failed/unknown workers require explicit review. Group rounds involving a disabled member stop. Shared application-level services remain available. Extensions with character-owned timers or workers must subscribe to the lifecycle event, cancel their work and use the role-scoped Router signal for generation; listening to application/plugin shutdown alone is insufficient.

Starter examples are composed through the same character, task, avatar import and group operations as user-created roles. They are created only by an explicit action, never during startup or upgrade. Artwork provenance survives role export/import in the atlas manifest. Multiple active roles can display independent native avatars.
