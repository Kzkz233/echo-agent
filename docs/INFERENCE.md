# Model services

[Documentation](README.md) / Architecture and interfaces

## Connections, models and task routes

Echo separates three records.

| Record | Owns |
| --- | --- |
| Connection | Adapter, endpoint or command, credential reference and service settings |
| Model | Connection reference, model name or artifacts, modalities, reasoning and output settings |
| Task route | The model selected for a registered application or companion task |

Configure reusable services in **Settings → Model Services**. Worker connections belong to their Codex or DeepSeek Harness extension. A service can expose several models while sharing credentials. Credentials remain protected references and are not copied into companion packages.

Connection classification comes from the registered adapter. Legacy API connections marked as external workers are displayed as API services; their endpoints and credential references remain unchanged.

Main conversations run through Pi. Selecting a language model changes its model binding. Codex and DSH are optional worker executors with separate native sessions and isolated application-owned homes. A local OpenAI-compatible endpoint uses an API adapter. An Echo-managed local runtime additionally owns model loading and process shutdown.

Companion tasks inherit the main model unless an explicit compatible model is selected. Shared tasks, including embedding and knowledge query services, use application settings. Eligibility is the intersection of task requirements, declared model capabilities and adapter support. Removing a provider makes its selections unavailable without redirecting work to another service.

[First connection](GETTING-STARTED.md#连接模型) · [Configuration ownership](PRODUCT-CONFIGURATION.md) · [Worker execution](BACKENDS.md)

## Output and reasoning

New models automatically use the output capacity declared by their model catalog. A custom endpoint without capacity metadata uses a 65,536-token fallback. Leave the output field blank for automatic selection; manual output limits and the input companion budget are available under **Advanced generation limits**. Existing saved limits remain unchanged.

The output limit applies to one model response, including replies and context summaries. It is not a cumulative task budget: an Agent can make multiple model calls and execute tools throughout a task. Conversation and task overrides take precedence over the model setting while still respecting declared model capacity and available context. There is no fixed 128K configuration ceiling. Summary prompts request concise text within the context budget; there is no separate fixed token allowance for summaries. Failed history compression stops preparation of the next run and preserves the original history.

The input companion budget and the model's total token capacity are separate settings. An unknown token capacity does not reduce the configured output allowance. Agent and auxiliary API requests use the same output parameter format. Explicit model capacity still constrains generation.

Generation settings can be saved while an existing run awaits reconciliation and apply to the next request. Changing the model identity or connection remains blocked until its outstanding execution is resolved.

Adapters declare mutable request options through `mutableModelOptions`. Built-in API adapters include context capacity and output parameter format. Extensions keep model identity and artifact options protected unless they explicitly declare an option mutable.

Automatic reasoning discovery reads explicit provider metadata or a documented adapter. A model listing that contains only IDs does not declare reasoning support. Explicit effort settings still use the selected protocol's native parameters; missing metadata does not silently disable them. Select a parameter format and supported levels from the provider's documentation for custom APIs. Companions and tasks can override the model's default effort. Draft forms and execution use the same declarations.

If a metadata refresh fails, the settings page retains previously retrieved capabilities for the same connection and reports the failure. An endpoint change invalidates that cache. Manual declarations remain available without a successful directory request.

Search expansion, language reranking and context summaries inherit the selected model's reasoning setting unless their task or conversation supplies an override. Delegated approval uses the main conversation's model and reasoning through the shared inference path; its existing authorization checks still apply.

Agent execution uses inactivity timers to detect missing progress. New delegated work, prompt automations and Review tasks have no total execution deadline by default. An explicit task deadline is enforced by the shared work-session lifecycle; backends do not impose another fixed ceiling. Set the duration to `0` for unlimited execution. Existing saved durations remain in effect, and a finite companion limit cannot be bypassed by requesting `0`. There is no fixed two-hour configuration maximum. Pending human decisions pause the inactivity timer. Individual API requests retain the model's request timeout.

Context summaries allow at least ten minutes for a quiet request, or the model's
configured timeout when longer. This applies to history preparation and compression
inside an active tool loop without changing saved model settings, output or reasoning.
During nested compression, the outer Pi idle timer defers to the summary's own timer.
Streaming progress resets that timer; ten minutes is not a total compression or task
deadline. Explicit cancellation and task deadlines still stop the work immediately.

Channel replies finish a Pi run at the completed-turn boundary, after every tool result in that turn has been recorded. All authorized targets must have a final reply, or the turn must explicitly choose silence. Progress replies and unfinished targets keep the normal tool loop active. Tool failures in the same batch remain available for handling before completion; submitting several final replies together does not require another model request.

## Extension contracts

| Contract | Responsibility |
| --- | --- |
| `core.inference.adapters@1` | Adapter descriptor, schemas, form fields and implemented modalities |
| `core.inference.prepare-model@1` | Artifact validation and identity preparation without loading weights |
| `core.inference.tasks@1` | Task ID, scope, operation and required modalities |
| `core.inference.generate@1` | Serialized generation request and text result |
| `embeddings.encode@1` | Typed text, image, audio or video inputs and one finite vector per input |

The descriptor ID matches the contributed provider ID. Registration checks namespace ownership, permissions, schema version and activation state. Unloading a plugin removes its contributions and disposes owned work. Stored configuration and existing indexes remain available.

Built-in streaming adapters retain streaming callbacks. A contributed stateless generation adapter returns a complete response. Native session management is a separate backend capability. Task scope determines where routes are stored and resolved.

| Task | Scope |
| --- | --- |
| `core.chat` | Companion |
| `observation.vision` | Companion |
| `memory.query` | Companion |
| `review.generate` | Companion |
| `semantic.query` | Application |
| `embeddings.encode` | Application |

The task list is extensible. Owning plugins contribute additional tasks and their configuration surfaces.

## Local models

Model Services supervises local runtimes and their residency budget. ONNX supports text embeddings. The GGUF adapter supports text and compatible image, audio and video embeddings, using a selected llama-server and any required projector. Audio transcription contributes its own model category and provider through the ASR plugin.

The installer includes BGE Small Chinese Q8 ONNX weights for offline text embeddings. Other model files and native runtimes are selected by the user. Quantization follows the actual artifacts. Downloads are opt-in, and opening settings does not load a model.

ONNX defaults to one CPU thread and GGUF to two. Optional GPU settings belong to the model. Idle workers are released according to residency settings. GGUF binds to loopback with a per-process token and an owner guardian. Unloading its provider aborts work and terminates owned processes.

[Local transcription](audio-transcription.md)

## Parsing and indexing

Document parsing is independent of generation. Knowledge owns one application-wide ingestion configuration for document parsing, audio/video transcription, optional image parsing, segmentation and embedding. Imports follow that configuration. A deliberate reparse can select a new plan for an existing entry.

Parser discovery uses `files.parsers@1` and the current source-reference execution contract is `files.extract@3`. MinerU credentials and ASR execution settings stay with their owning plugins. Existing bodies, transcripts and attachments can be reused when changing the indexing configuration.

The evidence graph relates text and native media to page, section or time-range parents. Indexing uses only modalities supported by the selected encoder. Retrieval returns evidence identities and their parent locations. Keyword search remains available without a semantic provider.

A vector-space identity includes model artifacts, dimensions and preprocessing. Device, thread count, residency and file location do not define the vector space. Runtime checks reject changed artifacts until their configuration is saved again. Incompatible vectors are never mixed. Migration creates and validates a separate generation before switching document bindings, retaining the old index for recovery.

[Parsing, evidence and migration](knowledge-parsing.md) · [Retrieval contracts](RETRIEVAL-AND-STORAGE.md)
