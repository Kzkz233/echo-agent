# Plugin architecture

Every plugin has one application-level lifecycle. Enabling a module loads one shared
instance; it does not create one service instance per character. A module can also
contribute a character-level feature through `core.characters.features@1`. That feature
owns per-character configuration, context, data or task eligibility, while the module's
global settings and operations remain application-scoped. Persona consumes this contract
and `core.automation.types@1`; it does not persist a second copy of live plugin
configuration. See [Characters](CHARACTERS.md).

Fields owned by a character contribution are shown in the character editor and omitted
from the plugin's global settings view. Shared parser/runtime settings and shared model
routes remain global and are shown with their owning module. Operation permissions in a
plugin manifest gate application calls; selecting a character feature does not grant or
revoke the application's MCP permission list. Strict per-character MCP access needs a
character-bound tool identity and is not implied by a role checkbox.

Every first-party feature has `plugins/<id>/echo-plugin.json` with API version 1, an English name and package label `@echo/<id>`. These labels are conventions, not npm publication. Bundled and local-process plugins use the same manifest validation. Local extensions cannot gain first-party identity by claiming that prefix.

## Core and optional foundations

The technical kernel provides typed operations, versioned extension points, lifecycle, events, permissions and a nearest-deadline clock. The product core uses these facilities for roles, conversations, routing, receipts, automation, channels and notifications. Persona, Scheduler, Channels and Notifications are required application modules. They use the plugin registration lifecycle internally and appear in runtime diagnostics. The plugin manager UI only offers controls for optional packages.

Register an automation task with `core.automation.types@1` and a signal source with `core.automation.signals@1` when the task needs a conversation or notice action. Source IDs use the plugin namespace. `automation.contribute` grants registration and `automation.dispatch` grants submission through the private plugin operation. The caller can only dispatch its own active source and the source's declared action. A channel binding must explicitly allow a contributed source before relaying it. Each plugin continues to own its settings, policy and task state.

Use `conversations.setReference` with `conversation.reference` for persisted links that must block conversation deletion. The reference is owned by the calling plugin, even while it is disabled. Built-in and bundled modules can also report references from the data they already own. Deletion checks use these references without embedding each feature's storage schema in core.

Inference adapters and task choices use `core.inference.adapters@1` and `core.inference.tasks@1`. Embeddings owns `embeddings.encode@1`; Semantic Search consumes it and Local Model Runtime optionally provides GGUF/ONNX encoders. These use the same scoped registry as other contributions. See [Inference](INFERENCE.md).

Files is an optional application-wide foundation: registered library roots, SQLite text/metadata containers, immutable binary objects and media access. Knowledge adds logical packages, Markdown, source bindings and keyword search; it is a shared application capability, not a per-character retrieval configuration. Documents and Semantic Search are independent enhancements. Persona/Memory/Review use the same storage and retrieval contracts.

Avatar provides ordinary frame animation and all bubble/input behavior. Agenda provides the calendar and reminders. Mail provides reading/drafts; Mail Actions contributes frozen actions to the independent Approvals center.

## Lifecycle

Required dependencies form a DAG. Optional runtime collaboration can be a graph: a new plugin contributes an offering to an existing extension point; it does not modify the consumer's code or create a reverse activation dependency.

Activation is ordered. Offerings remain pending until their owner and definition are ready. Failed activation retracts everything it registered. Disable revokes new calls, aborts in-flight work, disposes subscriptions/workers/processes and disables hard dependents first. Desired enable state is separate from actual state: a consumer can wait for an unavailable required plugin and return when that dependency is explicitly enabled. Disabling a dependency is respected; the consumer cannot silently turn it back on.

Late results from an unloaded generation cannot commit. Cleanup failures do not skip unrelated cleanup. A process that refuses cancellation is a trusted local program, not an OS sandbox; the host fences its result and refuses a new instance while tracked calls remain undrained. Native binaries and source upgrades require restarting the affected process; activation is not arbitrary source hot replacement.

## Operations and extension points

`context.registry.register()` declares owner-namespaced name, permission, input/output Zod schemas, MCP availability and handler. The scoped registry cannot spoof another owner or gain undeclared permissions. Every resource must register a disposer.

Any plugin can define `plugin.topic@version`; the host does not have a fixed list of domains. Definitions declare input/output schemas, provider and consumer permissions, and one/many cardinality. Providers register their own namespaced IDs and handlers. They can arrive before the definition and wait as pending. Same-version schema or permission changes are rejected within a process; publish a new version for changed contracts.

Typed domain contracts sit on this generic mechanism:

`cardinality: "one"` describes one explicitly selected provider per domain operation, not a ban on installing alternatives. Consumers must select an ID (or reject ambiguous choices); the registry never fans a single invocation out to multiple providers.

| Point                                 | Domain meaning                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `core.context@3`                      | Ordered stable and per-turn context blocks, scoped to one conversation |
| `core.automation.types@1`             | Task catalog, typed settings fields, and opt-in save/remove/run actions     |
| `review.materials@1`                  | Full attributed material records, selectable by provider ID                |
| `review.material-streams@1`           | Optional role-owned selections within a material provider                  |
| `review.archives@1`                   | Deterministic raw archive work                                             |
| `files.extract@1`                     | Extracted document text or unsupported                                     |
| `core.retrieval@1`                    | Candidate IDs/versions/scores; no records outside supplied scope           |
| `scheduler.handlers@1`                | Durable scheduled business action                                          |
| `care.blockers@1`                     | Optional current-activity gate                                             |
| `notifications.channels@1`            | Presentation/delivery and receipts, independent of inference               |
| `approvals.prepare/execute/inspect@1` | Validated preview/frozen action, execution, read-only reconciliation       |
| `avatar.renderers@1`                  | Optional native character renderer; common input/bubbles stay in Avatar    |
| `agenda.inputs@1`                     | Input-to-draft conversion without committing entries                       |
| `agenda.projections@1`                | Read-only groups/columns referencing canonical item IDs                    |
| `agenda.reminders@1`                  | Optional reminder presentation without invoking a model                    |

The mechanism is generic; an agenda projection is still not interchangeable with a Review material. Domain schemas enforce meaningful contracts. Multiple parsers/retrieval providers require explicit selection; the host does not choose a paid service automatically.

## Local extension process

A trusted local directory contains `echo-plugin.json`:

```json
{
  "apiVersion": 1,
  "id": "example",
  "name": "Example",
  "version": "0.2.0",
  "description": "Local extension",
  "dependencies": [],
  "permissions": ["example.read"],
  "command": "node",
  "args": ["extension.mjs"],
  "settings": [],
  "views": []
}
```

The user explicitly registers that directory. The command starts without a shell; `node` resolves to Echo's bundled executable. Stdout is newline-delimited JSON-RPC 2.0 only; logs go to stderr. A separate process does not restrict the program's OS permissions.

Host → child:

- `echo/initialize {apiVersion,pluginId,settings}` → operations, optional extension-point definitions and providers.
- `echo/invoke {name,input,invocationId}` → operation output.
- `echo/provide {point,id,input,invocationId}` → contributed output.
- `echo/cancelInvocation {invocationId}` and `echo/settingsChanged` notifications.

Child → host:

- `echo/call {name,input}` through declared permissions.
- `echo/capabilities.list`, `.invoke`, `.define`, `.provide`, `.remove` through owner-scoped validation.

Contracts use JSON Schema at the process boundary and Zod validation internally. Unknown host methods, ownership spoofing, undeclared permissions and self recursion are rejected. Unload retracts offerings and closes the child. See the executable example under `examples/hello-extension` and real process tests.

## Frontend and external tools

Manifest settings (`text`, `textarea`, `boolean`, `number`, `select`, `path`) render in Plugins. Settings are schema checked; secrets use credential references. Frequent first-party features have dedicated views. Arbitrary third-party web code is not injected into the trusted UI.

The bundled contract audit checks every declared setting/enum, static UI RPC method and object input key, view ownership, declared operation permissions, and repeat enable/disable cleanup across all packages. It complements in-flight cancellation tests and browser workflows; it is not proof of every dynamic response shape. Generic CRUD handlers still include permissive output schemas, while cross-plugin extension points, imported avatar material records and external extension JSON schemas validate their domain output. Do not describe those generic CRUD outputs as fully statically typed.

MCP is an authenticated loopback `/mcp` facade over the same operations. The frontend controls exported permissions; defaults are read only. Tools use their ordinary names with dots converted to underscores, without a PW prefix. A plugin does not need its own HTTP/MCP service. Same-process work uses typed async function calls, not internal HTTP ports.

Under **Extensions → External MCP**, add a Streamable HTTP URL or a trusted local stdio command. Save the connection, discover its tools, then grant individual tools in the character's app tool permissions. HTTP bearer tokens and stdio environment variables are kept in Echo's credential store. Third-party tools use the role's change-capable tool mode because their behavior is defined by the external server. The public loopback MCP endpoint does not re-export these tools.

The included **DeepSeek Web Search** template starts without a key. Enter your own DeepSeek API key to make its Search and Fetch tools available to authorized characters. Search returns links and excerpts. Fetch reads a selected public page. Discovery verifies the local tool catalog without making a billed request or validating the key with DeepSeek.

Approving an action requires the frontend caller and a frozen, current request. Exposing a proposal tool to MCP does not expose the approval decision. Avatar, QQ or another notification channel does not become an approval authority merely by displaying a message.

Review also defines `review.targets@1` (describe an optional non-core target, then apply stable proposals after full reading) and `review.reports@1` (idempotent program notices). Current Concerns contributes `reflections.state`; it never edits Review itself or gains access to core memories. Target selection is explicit. Frozen jobs keep their original context and target descriptions; an unavailable selected target leaves application pending instead of silently discarding proposals.

The Review editor derives source and target guidance fields from the active providers. A policy stores the user's instructions by provider ID. Echo conversation material uses `core.conversation`. Frozen packets record the source IDs they contain, and Review attaches the matching instructions to each model request. Disabling a provider hides its fields from the editor and preserves its saved instructions for re-enabling later.

Review can include every observation task for the selected character or an explicit subset. A newly selected task resumes from its own cursor. Unscoped sources such as mail remain checkboxes. Raw observation archiving retains the character's original records independently of which ones were sent to Review.

Channels defines `channels.send@1` and `channels.inspect@1`. Avatar and QQ contribute at the same presentation layer. A source binding maps an adapter/peer to one canonical conversation; unrelated web input does not fan out. `notifications.publish@1` publishes idempotent inbox/conversation notices. These are distinct contracts even though the extension mechanism is shared. See [Channels](CHANNELS.md).

Scheduler defaults to fencing a failed handler with unknown effects. A provider may explicitly throw `SafeTaskFailure` for an operation such as read-only IMAP synchronization: it records failure, preserves progress and permits the next scheduled slot. It never replays the current slot. Arbitrary errors, output-validation failures and lifecycle cancellation are not evidence of safe external effects.

First-party views are grouped by task rather than one sidebar entry per plugin. Knowledge and Archives groups Knowledge / File Archive / Media Assets. Persona, Memory, Review, Reflections and Proactive Conversation share the Persona and Memory section. The shell filters sheets by enabled view contributions and falls back to an available base sheet on unload. Grouping does not add a dependency or merge data ownership. Third-party plugins still receive generated settings UI; arbitrary third-party web code is not run in the trusted workbench.

## Product metadata and resource settings

`enhances: ["avatar"]` describes the feature a package extends. It is shown in the plugin list and details, but does not add a runtime dependency. Use `dependencies` for capabilities required throughout activation, and typed optional contributions for features that can appear later.

A settings field may declare `resource: "conversation" | "persona" | "vault" | "model"`. Its value remains a stable ID, while the UI renders a selector of current human-readable resources. Missing resources remain visibly unavailable. Settings labels and descriptions are localized; protocol IDs are never translated.

Current Concerns contributes `reflections.state` to `review.targets@1` and `reflections.current` to `care.context@1`. Memory Review and Proactive Conversation do not own copies of reflection records. Disabling a provider withdraws its contributions without disabling the consuming base feature.

### Model context contributions

`core.context@3` asks eligible providers to describe their blocks before preparing text.
Each block has a namespaced ID and a `stable` or `turn` layer. Optional `before` and
`after` constraints refer to same-layer block IDs. Missing anchors are ignored.
An invalid order is reported before any provider prepares its content. Blocks with no
relative constraint sort by ID. Loading dependencies remain in the plugin manifest.

The router assembles stable blocks, chronological history, turn blocks, and the
current request. Stable blocks never write history. Turn blocks can carry record
metadata when the content is a durable, attributed reference such as a recalled
memory. Otherwise their content exists only in the current Echo model request.
Connections that retain native histories acknowledge imported references by ID.
The channel hint is a core turn block and remains available when role injection is
off. Knowledge search runs when explicitly requested through the workbench or tools.

See [Model context](CONTEXT.md) for the first-party order, scenario matrix and native
harness persistence limits.

