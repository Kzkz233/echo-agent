# Backends

See [Execution workspace](EXECUTION.md) for structured native activity, active steering,
attachments, scoped DSH child approvals and optional Pi terminal commands. The Pi terminal
opt-in extends the basic project file tools; it is off by default and approval-gated.

The editor separates **Connections**, **Models** and **Task routes**. Connection setup offers API, Harness and Local Deployment. A local API server remains an API transport; Echo’s optional GGUF and ONNX runtimes are local-runtime adapters. Model configurations independently declare text generation, embeddings and supported input modalities. Multiple models share a connection and its credentials. Active feature plugins contribute task choices; routes show compatible models only. See [Inference architecture](INFERENCE.md) for registration and lifecycle contracts.

## Direct API and local servers

The `api` backend accepts an OpenAI-compatible `/chat/completions` endpoint and an independent `/embeddings` route. Specify a Base URL including `/v1` when required. It accepts streamed SSE or a complete JSON reply. Missing stream completion is an unknown outcome and is not retried automatically.

Examples of possible user-supplied local endpoints include Ollama or llama.cpp with an OpenAI-compatible server. Echo does not install or launch a model server implicitly. Hosted provider model IDs, prices, image support and reasoning options are user selected; no free hosted access is bundled or promised.

Choose the reasoning payload format explicitly: none, `reasoning_effort`, or `enable_thinking`. `inherit` leaves the provider default; observation/query tasks request off using the selected payload format. A backend that lacks an off mode must not be described as proven to disable reasoning.

## Embedded Pi

Echo embeds `@earendil-works/pi-agent-core` and `pi-ai`, not the coding CLI or its home scanning/configuration. It uses the same user-supplied API/model and Echo's canonical recent context. Read tools come from the operation registry and are permission-filtered. Tool iterations and output are bounded; tools requiring ungranted write capabilities are unavailable.

Pi Agent Core is the main conversation runtime. Both API and Embedded Pi model
resources execute main conversations through it. Auxiliary generation calls disable
tools. The optional `@echo/worker-codex` and `@echo/worker-dsh` plugins register
Worker-only adapters: they cannot become a role's main model, observation or recall
route. They can execute a configured delegation or an explicitly selected Review
Worker. Review defaults to Pi, including when its model uses an API connection.
Each external Review packet uses an isolated host session with supplied frozen
materials, no main-conversation binding and no inherited Echo tool principal.
Disabling a Worker plugin revokes its adapter and cancels its in-flight host calls.
Credentials and histories stay isolated from the user's existing external harnesses.

Within an explicitly selected project, Pi exposes its native `read`, `grep`, `find`
and `ls` tools. `edit`, `write` and the platform shell require write opt-in and an
exact per-call workbench approval. File paths are canonicalized and checked against
the project boundary; a shell is powerful and is never described as a filesystem
sandbox. The conversation inspector lists the actual permission-filtered tools.

## Codex App Server

Reasoning options come from the host's `model/list` catalog rather than a fixed model-name table. An observation request for `off` uses `none` when supported, otherwise the lowest advertised effort; the actual model/requested/selected effort is recorded in the run's execution metadata. An inherited ordinary turn explicitly restores the model's default effort, avoiding a previous observation turn's setting leaking into later chat. Unsupported explicit effort choices fail before submitting a turn. Provider failure details are retained and credential-like fragments are redacted; failed turns are not replayed automatically. See the official [model catalog contract](https://learn.chatgpt.com/docs/app-server#models).

Use the official `codex` executable with the single argument `app-server`. On Windows select an actual `.exe`, not an unquoted shell command. Echo launches it without a shell and identifies itself with `initialize`.

The connection editor supplies the default App Server command. Add a model from the connection's `model/list` catalog, or enter an ID under the advanced settings. The optional Codex context limit is passed on start/resume of Echo's native session. Echo's own prompt budget is a separate model setting. Custom launch arguments are edited one per line under Advanced launch settings.

Each connection uses `harnesses/codex/<connection-id>` under Echo's data directory as both `CODEX_HOME` and `CODEX_SQLITE_HOME`. Inherited Codex overrides are removed from this child environment. Existing user configuration and sessions are not copied automatically. The backend UI can read login status, open an official ChatGPT login URL, or cancel that login. Echo does not extract desktop credentials. A user may separately provision their own isolated official login cache using the provider's documented headless setup; never include it in a project or release.

The adapter uses public thread start/resume/read/archive APIs, native history insertion, turn start/completion, interruption, and native result inspection. Imported assistant records stay assistant records. Application-triggered turns use standalone application tool output rather than pretending to be human speech. Repeated persona/recall context is fenced by persisted context IDs.

Manual conversation turns default to a read-only sandbox and deny requests for additional approval. For role-managed chats, configure the backend and optional project folder/permissions in Edit Character → Runtime → Workspace and permissions. Worker templates own their settings; group members inherit the role. Independent core chats retain Conversation Settings. Tool and approval requests are scoped to their originating turn and still appear in the workbench. The workbench supports one-time command, file and permission decisions and native structured questions. It does not issue durable access grants. Background turns do not wait for workbench input.

An idle Codex host is released after two minutes and reopened lazily; its managed native session remains resumable. Active requests are reference-counted and cannot be closed by the idle timer. The official interactive login gets a longer grace period. This avoids keeping a full external inference host resident beside the native avatar between interactions.

Echo's binding stores an adapter-owned logical session ID. History seeds are durable before the first native turn; the actual Codex thread is created lazily. A newly created, still-loaded thread is used directly rather than resumed from a rollout file that does not yet exist. An unadmitted seed can be rebuilt after restart; once a turn may have been admitted, loss of its native state is an inspection problem and never an automatic new-thread replay.

Official protocol reference: https://learn.chatgpt.com/docs/app-server

## DSH SDK

Use the official DSH CLI with the full `sdk` profile for project work. If the installation provides only a Windows `.cmd` wrapper, select Node's executable and pass the official installed `@deepseek-ai/dsh/lib/bin.js` path, `--profile`, and `sdk` as separate arguments. The frontend stores arguments as an array. The older `sdk-minimal` profile has an unrestricted native shell; its underlying access cannot be reduced by denying interactive requests in Echo.

For a desktop-only installation with the CLI inside `app.asar`, select the installed DeepSeek Harness executable and pass `--expose-internals`, the installed `app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` path, `--profile`, and `sdk`. Echo scopes Electron's Node mode to that SDK child. The full DSH profile controls file and shell sandboxing; Echo chooses whether to surface its approval requests in the workbench. The SDK can also send structured questions and plan-review choices.

Echo uses `harnesses/dsh/<connection-id>/<session-id>` as `DSH_HOME`. Every active turn starts an isolated SDK runtime, initializes its selected provider/model/reasoning, resumes the same persisted session when present, waits for native completion, and shuts the runtime down. This enables per-run reasoning without mutating another conversation or keeping an idle DSH process alive.

For a custom API, Provider ID is a user-chosen route name: `custom`, `custom-relay` and `openai` are all valid. The API protocol, Base URL, credential and model determine the connection. Echo registers that name in its own isolated SDK profile; users do not need to register it in their desktop DSH configuration. Select Chat Completions, Responses or Messages to match the upstream endpoint.

Custom routes use the official `@deepseek-ai/dsh-llm-pi-ai` plugin, installed through DSH's plugin manager at the running CLI's exact product version. Dependency build scripts for Google GenAI and protobufjs are explicitly disabled. An invocation patch loads Echo's adapter instance even when the selected SDK template omits it, and disables an optional bundled instance to avoid duplicate provider registration. This touches only Echo's isolated profile; it does not patch the installed DSH application or the user's DSH profile. An updated DSH CLI selects its matching adapter version on the next setup. Future upstream protocol changes may still require adaptation.

`deepseek-official` selects the bundled official provider. It uses its Messages API base URL (`https://api.deepseek.com/anthropic`), not the OpenAI-compatible `/v1` path. Echo normalizes the known official host when an old `/v1` value is present and leaves custom endpoints untouched. Keys are supplied only to the SDK child environment. The SDK profile can have different native API wire formats from the direct OpenAI-compatible backend; Echo communicates with DSH through its SDK protocol. `xhigh` maps to DSH's supported `high`; it is not forwarded as an unsupported effort ID.

The SDK accepts prompts and does not expose arbitrary native assistant-history insertion. Echo supplies an attributed history/context capsule while keeping the canonical role/source record in Echo. Native sessions remain in the isolated home when detached. Unknown writes and model failures are not represented as delivered replies.

Official protocol source: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/protocol

## Capability boundaries

Echo intersects application-level tool limits with per-character grants before exposing tools to a managed conversation. DSH receives a short-lived, conversation-bound MCP credential. Codex receives the same authorized operations through its app-server `dynamicTools` contract, bound to the thread at creation and dispatched back through the trusted conversation identity. A changed tool grant archives the prior Codex thread and starts a replacement with Echo's saved history. Pi applies the same permission intersection directly to its in-process tool list; read mode exposes only read operations and ask mode requests approval before writes.

The per-conversation project folder is separate from Echo's MCP scopes. Codex and DSH use their own native tools for project work. Embedded Pi can list and read files within that folder. Opting in to edits adds exact text replacements and file creation, each requiring confirmation and using revision checks. A separate terminal opt-in adds the official Pi coding tool, requires interactive approval for each command, and runs with the local user's authority; its working folder is not an OS sandbox.

External Harnesses must be installed and authenticated by their supported mechanisms. The main application, generic model APIs and optional embedded agent are independently usable. Echo does not turn one subscription into an undocumented universal API.

The installer does not configure existing Harnesses, add hooks to normal chats, or import existing histories. Managed Echo conversations use dedicated native sessions. Model-side token caches, compaction and tools retain backend-specific behavior; Echo's own record is the portable source.
