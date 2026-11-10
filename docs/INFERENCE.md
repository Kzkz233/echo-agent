# Inference connections, models and routes

Echo owns its conversations. An inference connection, a model configuration and a business task route are separate records.

- **Connection:** adapter ID, user-facing name, deployment location and adapter-validated configuration (endpoint, protected credential reference or Harness command). Several models can share one connection.
- **Model configuration:** connection ID, model name/path, declared generation and embedding input modalities, optional vector dimensions, reasoning/budgets and adapter-specific model options. Generation and embeddings are independent capabilities; modalities are text, image, audio and video, rather than mutually exclusive model classes.
- **Task route:** a plugin-owned registered task selects one compatible model. The effective capability is the intersection of the task requirement, model declaration and adapter implementation. A checkbox is a declaration, not a quality benchmark.

The workbench groups connection setup into API, Harness and Local Deployment. A local API server still uses an API adapter. An Echo-owned local runtime uses a local-runtime adapter. A Harness may itself use local or remote models; Echo does not infer the underlying computation location from the Harness process address. Loopback HTTP is supported; remote API endpoints require HTTPS.

## Versioned extension contracts

The existing generic capability registry supplies typed, owner-scoped extension points; there is no new unscoped global plugin table.

| Point                            | Contract                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.inference.adapters@1`      | Adapter descriptor, connection/model JSON schemas, generated form fields, implemented modalities and provider IDs                                                   |
| `core.inference.prepare-model@1` | Optional adapter-owned validation and content hashing of model artifacts, without loading weights                                                                   |
| `core.inference.tasks@1`         | Business task ID, localized label, operation and required input modalities                                                                                          |
| `core.inference.generate@1`      | Serialized generation request and text result for contributed stateless adapters; preserves ordered messages, reference IDs and optional `context: 'turn'` metadata |
| `embeddings.encode@1`            | Selected model, input records of typed text/image/audio/video parts, document/query purpose; one finite vector per input                                            |

The built-in streaming adapters retain their in-process streaming callbacks. Contributed generation adapters use the serialized contract and may return a complete text response. Stateful Harness session management remains an explicit backend capability; a generic text provider is not presented as owning native sessions.

An adapter/task descriptor ID must equal its contributed provider ID. The registry checks namespace ownership, declared permissions, schema version, activation readiness and result lifetime. Removing a contribution removes its UI options and eligibility. Configuration and existing indices remain on disk. Saved routes never silently switch to a different local, remote or paid model.

Core contributes character-scoped `core.chat`. Observation contributes character-scoped `observation.vision`; Memory contributes character-scoped `memory.query`; Semantic Search contributes the shared `semantic.query`; Review contributes character-scoped `review.generate`. Embedding Models contributes the shared `embeddings.encode`. Task selection is generated from the active list, rather than a hard-coded frontend enum.

Character generation tasks are selected in character configuration. Knowledge search strategy, memory retrieval policy, query planning and embedding selection are application-level module settings; characters cannot choose a retrieval model. Memory recall remains limited to the character's own memory records and uses the shared `embeddings.encode` route when Semantic Search is enabled. Shared inference routes appear in their owning plugin settings, not in a separate public-purpose page. Model capability validation prevents selecting a chat-only model as an encoder. Removing Semantic Search leaves keyword memory recall available.

Task scope controls route ownership: character-scoped tasks read routes from the selected character, while shared tasks read only the application route table. A legacy character route cannot override a shared query or embedding model. This scope is independent of plugin lifetime: plugins still activate once for the application and may contribute tasks in either scope.

Document parsing connections are shared resources, configured separately from inference routes. The connection screen stores protected MinerU credentials and local command settings; the Knowledge screen owns the default parser and each import can select a provider from `files.extract@1`. Viewing connection readiness only reads configuration; it does not upload documents or submit remote work.

## Optional vector and local runtime modules

`@echo/embeddings` owns the vector contract and validation. `@echo/semantic` depends on Knowledge and Embeddings and owns retrieval/indexing, not model workers. `@echo/local-models` depends on Embeddings and contributes optional GGUF and ONNX encoders. Memory still works through keyword retrieval without Semantic Search.

The first-party API adapter implements text generation, image input and text embeddings. The first-party ONNX adapter implements text embeddings. The GGUF adapter implements text, PNG/JPEG image, WAV/MP3/FLAC audio and FFmpeg-decoded video embeddings using an explicitly selected llama-server executable, model and optional projector. Media capabilities require that projector at save time. The GGUF adapter uses native `input_audio` and `input_video` content parts; video decoding requires FFmpeg in the runtime PATH. API/ONNX adapters still expose only the embedding modalities they implement. New knowledge/memory indexing consumes text. Imported structural indices can preserve and retrieve text and image vectors. Automatic image/audio/video library segmentation and indexing are not implemented; these encoding capabilities are available to explicit embedding requests.

API connections may point to an already running local OpenAI-compatible server such as Ollama. Echo does not start, stop or install that external server. Its own ONNX workers are started only for an explicit encoding request, use one CPU thread per inference session, and default to one resident model with release after two idle minutes. Model retention and ONNX download permission belong to model configuration. Select the actual GGUF model/projector or ONNX weights filename; quantization is a property of those files, not an independent dropdown. Downloads default off. GGUF runs in a supervised child with loopback-only binding and a per-process API token. Its IPC guardian kills the model process on abrupt core exit. Unloading the local runtime aborts requests, retracts providers and terminates workers/owned processes; viewing settings does not load weights.

Vector-space signatures include adapter, endpoint, model identity, output dimensions and input-format options. GGUF preparation hashes the model/projector bytes. Its identity excludes device, threads, residency and paths; unchanged files can move without invalidating vectors. Runtime checks reject changed artifacts until saved again. Switching these creates a different index identity. Existing vectors and original knowledge are retained; vectors from incompatible configurations are not mixed. Invalid counts, dimensions or non-finite values are rejected before indexing. Changing the route/configuration pauses an affected active index task with its completed work retained.

Codex authentication and its native process pool belong to the connection. Multiple model configurations share that connection account, while native conversation/session identities remain separate. DSH/Codex use only Echo-owned isolated homes. No desktop Harness profile or unrelated session is modified.

## Document processing

Document conversion is a separate typed `files.extract@1` contract, not a text-generation model. The Inference workbench has a Document Processing tab for its registered providers. Code extraction, a configured MinerU cloud token and an installed MinerU local CLI are separate choices. Queued jobs freeze the selected provider; MinerU stores its configuration and reserved batch ID before upload/polling. Restart resumes that batch, while an uncertain submission is fenced instead of automatically duplicated. Captured originals remain local regardless of parser availability. Parsed images become content-addressed library attachments; Markdown references use scoped asset URIs.

The cloud connector follows the [official precise V4 API](https://mineru.net/apiManage/docs). The local connector targets the [MinerU 4.1 stateless CLI](https://github.com/opendatalab/MinerU/blob/master/docs/en/usage/cli_tools.md), explicitly requesting all pages and ZIP export. Echo does not bundle MinerU runtime code or model weights. Code extraction needs no Python environment; choosing the external CLI requires its own installation.

## Local model templates and media cost

Adapter-owned model templates are registered with the same descriptor and disappear when that plugin is unloaded. The local runtime offers BGE Small Chinese (512-dimensional text embeddings) and EmbeddingGemma 2 (768-dimensional multimodal embeddings). Templates fill configuration; users still choose the real GGUF/projector files or ONNX weights. BGE Small Chinese Q8 weights are bundled in the desktop runtime and work offline. Other models remain user-supplied and downloads are opt-in. Existing shared embedding routes are preserved.

Enabling another declared input modality does not change the weight space or invalidate text/image vectors. Portable indices may map an updated logical signature to its original physical space after verifying model and preprocessing identity; vectors, structural nodes and body hashes are unchanged. Device, residency and video sampling settings do not rewrite existing text/image vectors. Any future cached video representation must record its sampling policy in its own input revision.

Video defaults to 1 fps instead of the runtime default of 4 fps. Real CPU-only checks with two threads returned 768-dimensional audio and video vectors. A one-second synthetic WAV took about 0.18 seconds; a two-second synthetic MP4 took about 19 seconds at 1 fps (about 73 seconds at 4 fps). This verifies encoding and illustrates its cost, not retrieval quality. No audio/video encoding occurs merely from opening settings, and realtime desktop observation continues using its separate four-image pathway.

Sources: [EmbeddingGemma 2 model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2), [llama.cpp embedding protocol](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1embeddings-openai-compatible-embeddings-api).
