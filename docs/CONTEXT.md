# Model context

## Message headers

Canonical message bodies stay unchanged. Model inputs also carry a typed
`messageContext` snapshot, rendered at the backend boundary as:

```text
[current_time: 2026-11-11T20:20:18+08:00 | timezone: Asia/Shanghai]
[time: 2026-11-11T20:18:32+08:00 | sender: user | channel: QQ]
Message body
```

Field names are fixed English. `channel` and `task` are optional, independent
labels; an observation event has a task, not an invented inbound chat channel.
Headers are context, never permissions or a replacement for native message roles.
One message time is exposed: a validated platform send time when supplied, otherwise
the application's acceptance time. Queued inputs keep that acceptance time rather
than acquiring a new timestamp when execution starts. Domain times (capture windows,
email dates, task details) remain in the body.

The current clock is sampled once when preparing each conversation turn and saved
with that input. Old snapshots are not recomputed on replay, including after a UI
language or application timezone change. The stable prefix contains only the fixed
interpretation rules. Ordinary chat and avatar delivery never display these headers.
Older records are interpreted conservatively from saved metadata, without rewriting
the database or inventing unknown origins. Automatic compaction keeps its existing
policy and reuses the common rendering for its source text and budget accounting.

Plugins may fill the optional `messageOrigin` on a router submission, or register a
source descriptor at `core.message.sources@1` using `contributeMessageSource` from
`packages/kernel/message-context.ts`. Providers need `context.contribute`, use their
own namespace, and return optional `sender`, `channel`, and `task` strings. A
submission selects the descriptor with `messageOrigin.sourceId`; it is resolved
once and snapshotted with the message. Unloading removes the source provider but
does not change previous headers. Channels and automation reuse their registered
adapter/signal labels automatically. This extension describes provenance only;
task prompts and content still use the existing message/context mechanisms.

Generation adapters receive `ModelInput.messageContext` and must call the shared
`materializeMessage` helper from `packages/contracts/message-context.ts` before
serializing text to a model or native host. The helper is idempotent and does not
mutate the original input. All first-party API, Pi, Codex and DSH adapters use it.

## Assembly

Echo assembles conversational model input in four sections:

1. Stable context, in one leading `system` message.
2. Conversation history, in chronological order and within the remaining character budget.
3. Turn context, in separate `system` messages with `context: 'turn'`.
4. The current request, retaining its human or application authorship.

The context extension point is `core.context@3`. Providers declare namespaced block
IDs, a `stable` or `turn` layer, and optional same-layer `before` / `after` anchors.
The router validates the whole graph before preparing any content. Missing optional
anchors are ignored; duplicate IDs, cycles and cross-layer constraints are errors.
Independent blocks sort by ID, so activation order never determines prompt order.
Manifest dependencies still control plugin loading. An ordering anchor does not
create a loading dependency.

Assembly first prepares the stable layer and measures its actual size. It then
selects history within the remaining budget and prepares turn blocks against that
history. Blocks declaring `historyDependent` are recomputed if turn content evicts
history; other providers are cached within the run. A bounded convergence pass
ensures recall never suppresses a memory based on history that is later removed.
Providers receive `phase: stable | turn` and should avoid work for the other layer.

## First-party blocks

| Layer | Order | Block | Included when |
| --- | --- | --- | --- |
| Stable | 1 | `persona.profile` | Persona injection is enabled for the conversation and character |
| Stable | 2 | `memory.core` | Memory is enabled and the character has core memories |
| Stable | 3 | `delegation.guide` | A human, group, delegation or handoff turn with configured workers; or a worker turn |
| Stable | 4 | `chatstick.catalog` | Human or Care turn, with the character's ChatStick feature enabled and available stickers |
| Turn | 1 | `memory.recall` | Relevant memory versions are not already present in effective Echo history |
| Turn | 2 | `reflections.current` | Current Concerns injection is enabled; excluded from Care because Care selects its own sources |
| Turn | 3 | `delegation.turn` | Delegation is available for this turn; contains temporary authority and worker task identity |
| Turn | 4 | `core.presentation` | Human channel reply, or human/Care avatar bubble reply |

Absent or empty blocks are skipped. Conversation and character feature selections
filter providers before assembly. Workers use a provider allowlist containing only
Delegation: their stable block is the selected worker template and submission guide,
with no automatic parent Persona, Memory, Current Concerns or ChatStick injection.
Core presentation does not depend on role injection being enabled.

## Scenarios

Every row below has history between stable and turn context, followed by the
current request. It assumes the named optional features are enabled and applicable.

| Scenario | Stable context | Turn context | Current request |
| --- | --- | --- | --- |
| Workbench chat | Persona → core memories → delegation guide → ChatStick | Fresh recall → current concerns → delegation authority | Original human input |
| QQ human reply | Same as workbench | Same, then the character's external channel style | Original human input with channel origin recorded separately |
| Avatar human reply | Same as workbench | Same, then the character's bubble style | Original human input |
| Care | Persona → core memories → ChatStick | Fresh recall → bubble style | Application opportunity: task prompt → selected Care sources in configured order → silence option |
| Observe | Persona → core memories | Fresh recall → current concerns | Application observation: task-specific guidance and observation evidence; reasoning off, text-only, no QQ delivery |
| Worker | Worker template → checkpoint/submission guide | Delegation authority → task ID | Delegated goal, acceptance criteria and necessary task background |
| Worker handoff | Persona → core memories → delegation guide | Fresh recall → current concerns → review-only delegation authority | Application result notification |

Care source order comes from each task's `contextIds`, with duplicates removed.
There is no automatic Knowledge search block. Explicit Knowledge search/read tools,
including configured search strategies and semantic search, remain available.

Memory Review is a separate processing task, not an ordinary conversational turn.
It does not run this conversation injection chain. Its `system` message contains
the Review rules, task/report instructions, source-specific guidance, frozen role
background and existing memories, and the selected plugin targets. Its following
`user` message carries packet progress, continuation notes and attributed source
records; that role labels task data, not a claim that the user spoke those records.
Observe's visual interpretation call is likewise separate from the role's subsequent
conversational turn.

## Persistence, adapters and caching

Fresh recalled memories can carry record metadata. Echo stores them once as
attributed historical references and deduplicates by memory ID and version while
they remain in effective history. Presentation hints, current concerns and delegation
authority do not become canonical Echo history. Their instructions apply to the
current turn. Native harnesses can still retain their previously received envelopes
in their own histories.

All first-party API and embedded Pi main conversations execute through Pi Agent Core
with the ordered message array. Stateless auxiliary calls have no tools. Pi retains in-conversation
system messages rather than folding fresh context into the stable prefix. Contributed
generation adapters receive the same order, reference IDs and turn metadata.
The optional Codex and DSH Worker plugins maintain native conversations: stable-context updates and unseen
historical references are acknowledged separately, and current turn context travels
with the current request. These envelopes are necessary because a native harness
does not expose arbitrary insertion into its existing message sequence.

Old automatically imported Knowledge references remain visible as historical Echo
records but are excluded from future Echo model inputs and migration seeds. Echo
does not erase anything previously delivered into an existing native harness session.

Keeping changing references out of the leading system prefix makes that prefix
more stable. Actual cache hits depend on the provider and native harness; Echo
does not guarantee or measure provider cache savings from this ordering alone.
The configured context budget is measured in characters, not exact model tokens.
