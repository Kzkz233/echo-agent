# Implementation map

Echo is an independent application. Public sources and release inputs contain generic fixtures only. An optional private acceptance runtime is kept outside the checkout; it is not a release input or a dependency on the original application.

| Directory                            | Responsibility                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                 | Persisted roles/sources and backend request/result schemas                                                        |
| `packages/kernel`                    | Canonical history, routing, queues, permissions, lifecycle, extension points, clock, events, secrets              |
| `packages/backends`                  | Direct API, embedded pi, official Codex App Server and DSH SDK adapters                                           |
| `plugins/files`                      | Optional library/container foundation, binary objects and scoped media access                                     |
| `plugins/knowledge`                  | Markdown entries, properties/versions, one source to one current package, keyword retrieval and portable exports  |
| `plugins/documents`                  | On-demand PDF/Office parsing Worker                                                                               |
| `plugins/embeddings`, `local-models` | Vector contract/validation and optional on-demand ONNX model runtime with bounded residency                       |
| `plugins/semantic`                   | Model-independent semantic/hybrid ranking and resumable vector indexing                                           |
| `plugins/persona`, `memory`          | Character context, one manual/automatic recall path, effective-history version deduplication                      |
| `plugins/reflections`                | Persona subjective state, ordinary context, optional Review updates and proactive context                         |
| `plugins/review`                     | Daily/round triggers, full incremental material packets, checkpoints, raw archives and memory drafts              |
| `plugins/observation`                | Local source proof/masking, HSV gating, real-time four-frame mosaic and same-chat interaction                     |
| `plugins/avatar`                     | Basic native frame animation, bubble delivery receipts and pinned-conversation reply input                        |
| `plugins/agenda`                     | Calendar entries, priorities, time ranges, durable reminders and bindings                                         |
| `plugins/care`                       | Optional concerns and quiet/cooldown/activity-gated same-chat interaction                                         |
| `plugins/mail`                       | Optional TLS IMAP metadata/body reads and SMTP draft state                                                        |
| `plugins/approvals`, `mail-actions`  | Independent frontend decisions and frozen mail execution/reconciliation                                           |
| `plugins/notifications`, `scheduler` | Inbox/channel receipts and durable scheduled handlers                                                             |
| `plugins/channels`, `qq`             | Explicit peer bindings, original-channel replies, official QQ gateway, direct networking and per-segment receipts |
| `plugins/assets`, `backup`           | Optional image catalog/previews and verified snapshot/empty-target restore                                        |
| `apps/server`                        | Composition, authenticated loopback RPC/SSE, media streaming and MCP facade                                       |
| `apps/workbench`                     | Default-light React management UI, chat, calendar and Markdown reader                                             |
| `apps/desktop`                       | Thin Tauri tray, on-demand management WebView and core launcher                                                   |
| `native`                             | Windows capture/source proof/occlusion and native Win32 avatar                        |
| `tests`, `scripts`                   | Isolated regressions, real-host protocol tests, resource measurements and ordered packaging                       |

The original implementation is not copied as a set of private services. Schedule text entry follows a date-by-project workflow. Library bodies use SQLite with immutable objects; native assets and UI-based approvals are independent of message channels. See the verification and feature coverage documents for what is implemented and which provider/hardware paths still need testing.
