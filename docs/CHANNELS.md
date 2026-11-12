# Channels

ChatStick is an optional character plugin. Configure images and their intended use from
the character workspace. A reply may select one enabled image from that character's catalog.
Echo records it with the canonical assistant message. The workbench can render it from the
managed file library, and compatible adapters can attach it to an already authorized reply.
Files resolves the same stored attachment for the workbench, QQ, and the native avatar.
QQ uploads the image separately and tracks its reply sequence alongside text segments.
The native avatar can show one small image alongside text for regular and Care replies.
Observe bubbles present text. An unavailable image leaves the text usable.
ChatStick needs the file archive and character features. It runs independently of Channels
and memory recall, and contributes its short selection rules and catalog to eligible turns.

External chat and avatar replies receive short formatting guidance on their own turn.
This guidance lives in the inference input and leaves Echo's stored message and the role prompt intact.

Conversation channels are a built-in component. Enable the optional QQ or Avatar provider as needed. A provider contributes a destination without creating a second model execution.

An enabled binding is `(adapter, peer) → conversation`. Each external peer has at most one active binding. Incoming remote message IDs are deduplicated before canonical input is queued. A new peer appears in Channels but cannot call a model until explicitly bound. Channel input is never an approval authority.

Human replies return to their source binding. Normal workbench/avatar input stays local. Automation output is selected per task: main chat, native bubble, notification inbox, or a bound external channel. Observe may use an explicitly selected external channel; upgrading preserves the previous destinations. An empty selection retains the task result without presenting it.

## QQ

Configure a bot App ID and a credential reference; store the secret through the frontend. Echo uses official Tencent gateway event normalization with an owned WebSocket lifecycle. Missed heartbeat acknowledgements terminate a silent connection, reconnect uses bounded delays, and reconnect does not resend old replies. QQ REST and gateway traffic use direct networking, independent of VPN proxy settings for other providers.

Text is split into at most five passive-reply segments with stable `msg_id` / `msg_seq`. Confirmed IDs and TraceIDs are recorded. Each failed network request may retry once after 2.5 seconds; confirmed parts never replay. Certificate, parsing, HTTP and missing-message-ID errors are not blindly retried. If an earlier attempt may have reached the server, a later definite connection failure does not erase that uncertainty.

Inspect receipts in Channels. Only a definite failure can be explicitly retried, and only unconfirmed parts are attempted. An unknown result is fenced for inspection. A server acceptance receipt does not prove client visibility. Automated tests use local synthetic HTTP/WebSocket endpoints and send no real QQ messages.

QQ supports text and a single attached reply image. Unsolicited pushes require Tencent platform permission and explicit configuration. Removing QQ cancels its sockets and timers and preserves bindings and history.


## Unified task output (0.16)

`core.outputs.targets@1` is the typed, permission-checked destination registry. Providers declare targets for a conversation and implement idempotent `deliver` and read-only `inspect`. New plugins need `outputs.provide`; UI choices come from registered providers, not a hardcoded channel list. A destination has a stable ID, revision, readiness, optional presentation hint and legacy migration metadata. Replies retain one canonical record. Channels adapt delivery; they never generate another reply.

The task owner declares an `outputs` configuration field. The unified trigger path freezes a delivery plan before generation. Review freezes its report plan before reading material. Binding revisions are rechecked before submission; missing, disabled or changed targets do not redirect old results. Pending, sending, queued, delivered, failed, unknown, skipped and manually closed receipts are durable. Known failures may be explicitly retried without inference. Unknown results require inspection or explicit closure and are never replayed. Explicit closure stops tracking; it does not retract accepted upstream messages.

Main chat is a presentation destination. Generated replies stay in canonical context even when shown only elsewhere. TaskResults records automation and delegation results in the parent context. A task can retain its result without waking the parent, or request a parent reporting turn using its selected destinations and reporting instructions. The parent calls `echo_respond` separately for each destination. The task result remains available regardless of selected destinations; presentation receipts do not duplicate it as human input.

The role editor owns task output choices. Runtime task pages show results and receipts, with inspect/retry controls. Legacy binding subscriptions are retained for compatibility, but current automation settings are migrated to task-level choices. Destination bindings and credentials are local resources, so exported role packages require output choices to be checked again after import.

Delivery uses event-driven, indexed SQLite queries, no polling timer. Queue fan-out is bounded, and listings return at most 100 recent outputs. Character suspension aborts in-flight work and expires queued local presentation. Ambiguous external effects are retained for reconciliation.
