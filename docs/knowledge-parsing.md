# Knowledge parsing and portability

Each registered library keeps its own ownership and write policy. Parsing does not
merge personal knowledge, memory, observations or extension-owned libraries.
The container remains `echo-library-v1`: `library.sqlite` and content-addressed
binary objects. Markdown is the readable body; structured media segments are
optional data belonging to a published parse generation.

## Provider contracts

The Files component owns these ordinary versioned extension points:

- `files.parsers@1`: provider ID, label, implementation version, execution
  contract, supported extensions and maximum input bytes.
- `files.prepare-parse@1`: freezes provider-owned options once per job. Return
  `{options, provenance}`. Options may contain credential references, never raw
  credentials. Provenance is a portable summary: omit secrets and machine paths.
- `files.extract@3`: scoped original identity and the frozen plan. Returns text,
  optional assets and optional `{start, end, text, language}` segments in seconds.
- `files.extraction-progress@1`: optional progress for the same request ID.

The provider descriptor and execution provider must have the same ID. Preparation
belongs to the contributing plugin. Provider removal revokes execution; the job
can resume after that provider is enabled again. A changed implementation version
requires a new reparse job. Existing `files.extract@1` and `@2` extensions remain
explicitly selectable under their old contracts; undeclared legacy formats are
not selected automatically.

The UI obtains its options from `knowledge.parsers`, the same catalog used by the
backend. Protocol version does not determine whether a provider is a document or
media parser. Source-reference parsers may support either. No paid parser is
selected just because it happens to be installed alongside another provider.

An authorized extension can resolve a received original reference using the typed
`files.source-object` operation (`files.read`). This verifies the file/hash
association and returns the archived local object, including an older captured
version. It is not a model-facing MCP tool and grants no arbitrary filesystem path
lookup. Process-based and module-based parsers need not import Knowledge internals.

## Task and publication lifecycle

1. Stream and hash the original into the selected library. Capture its file ID
   and immutable object hash, independently of the current external source path.
2. Choose a compatible parser and freeze its plan before execution. Identical
   active requests for the same original coalesce; incompatible concurrent
   requests are refused before expensive work. Each request ID remains idempotent.
3. Parse with the captured source version. Checkpoints are operational application
   data. Resume uses the captured content settings, not subsequently changed defaults.
4. Materialize derived assets with deterministic identities. Content bytes are
   deduplicated; repeated parsing does not append duplicate file records.
5. In one library transaction, publish the body revision, current asset references,
   source snapshot, safe provenance and structured segments. Check the expected
   entry revision both before parsing and at publication. User edits are preserved.
6. Publish the existing knowledge update event and an import-completed event.
   Keyword indexing uses the new body; optional automatic indexing is queued through
   the same generation manager used for migration. Installation never rebuilds existing vectors.

An interrupted operational receipt is reconciled from `parse_generations.job_id`,
so a library commit is not replayed. Failure/cancellation never replaces the
current body. Automatically discovered attachments are replaced with the new
body's links; user attachments remain. Revision snapshots retain historical
source and asset references. No historical object is physically removed by reparse.

## User operations

- **Resume** continues the same request and plan.
- **Reparse archived original** creates a new plan and revision using the archived
  bytes. It does not require the original external file.
- **Update from source** imports the external file again and parses its new bytes.
- **Rebind source** verifies the same original at a different external location.

## Unified ingestion and evidence

Knowledge owns one application-wide `echo-ingestion-v1` default: document parser,
media transcription parser, optional image parser, embedding model and segmentation.
Native text does not need a paid parser. Parser credentials remain in their owning
plugins. Imports follow the default; explicit per-entry reparsing is an advanced operation.

Each published body can have a derived evidence graph. It retains the Markdown,
known page coordinates, ASR segment ranges and original asset hashes. Text, images,
audio fragments and video fragments reference section/page/time parents. Page data
is used only when supplied by the parser; old entries do not receive invented pages.
Segment ranges are not word alignment or speaker diarization.

The Files extension points `files.media-processors@1`, `files.prepare-media@1`,
`files.media-inspect@1` and `files.media-encode@1` prepare bounded native inputs.
Files supplies image normalization. ASR optionally supplies FFmpeg probing and media
fragments without loading the transcription model. Extensions can replace these
providers. Provider identity/version and operational options are frozen per migration.
The target embedding model must declare the modality; unsupported modalities are
listed in the preview, not passed to a text-only model.

Native media uses sequential fragments, at most 60 seconds, rather than loading an
entire recording into a request. FFmpeg uses two threads; video fragments are resized
and sampled at one frame per second. Encoded fragments are limited to 12 MB and temporary
files are removed after each operation. ASR loads only when transcription is needed.

Search hits carry their evidence node and parent, with page/time coordinates when
available. `knowledge.read` opens the matching passage. `knowledge.evidence@1` lets
optional indexes resolve existing structural evidence without rechunking old vectors.

## Pipeline migration

The Knowledge System settings contain **Ingestion pipeline → Update existing content**.
Choose libraries and preview before applying. Default migration reuses saved bodies,
transcripts and attachments; the optional parsing update checks captured provenance.
Unknown historical provenance is reused. Changes that would overwrite manual content
or plugin-owned source material are blocked for explicit review.

Migration stages a separate physical index with immutable content/model/processor
identity. Saved vectors are reused on resume. Only a fully validated generation
switches the selected documents' bindings; unselected libraries and documents retain
their indexes. Queries use the active generation's model even when a different default
has been saved. Concurrent content changes fail validation and retain the previous
binding; preview a new migration instead of replaying stale writes.

Restoring a previous index changes bindings only, never rewinds user edits or parsing.
An index whose body hash no longer matches is excluded from search. Old vector spaces
remain available for rollback. New graph/parse tables are additive within `echo-library-v1`.

## Storage, migration and resources

Auxiliary tables add source versions, revision source/asset/parse references and
parse generations. Existing rows and base table layouts are retained. Upgrade
does not infer unknown historical provenance or change existing bodies, entry IDs
or indexes. Moving application data rebases explicitly registered machine paths;
external model files and external libraries remain referenced in place. Providers
declare path-bearing plan fields with the existing `storagePaths` manifest contract.

Library bundle export includes current text, attachments, original bytes and the
current provenance/segments, using streaming ZIP64. By default it omits external
source paths, historical revisions and derived graph caches. A mounted exported library can reparse its
archived original after a compatible parser has been configured on the new device.
Markdown export preserves audio/video extensions and timestamp fragments.

Application backup includes library databases/objects and the existing semantic
index. It does not embed model weights, credentials or installed extension binaries.
Those are distinct from an application-data move and an application upgrade.

The shared local-model pool coordinates ONNX/GGUF embeddings and ASR using the
Model Services residency budget. Busy models cannot be evicted. ASR releases its
model after a file; direct provider calls use the shared idle policy. Connection
checks validate adapter-owned prerequisites without claiming inference was tested.

`tests/parsing-pipeline.test.ts` covers publication, archived reparsing, idempotency,
old source versions, migration, portable export, schema preservation, format matching
and resource leases with synthetic inference. `tests/asr.test.ts` covers chunk resume
and immutable ASR settings. Real local transcription and large ZIP64 acceptance use
explicit isolated paths; no personal library or paid model API is used by tests.
# Speech detection and publication

Audio/video parsing uses the ASR plugin's `asr.detectors@1` catalog and typed
`asr.detect-speech@1` operation before transcription. The bundled default is the
pinned Silero 16 kHz ONNX detector. It runs in a CPU worker only while a parse job
holds it; completion, failure, pause and plugin disposal terminate the worker.
Another plugin may provide a detector under these contracts without changing
the knowledge system. The selected detector, version, artifact hash and options
are frozen in each parse plan and continuation identity.

No speech is a successful empty transcription (`assessment.state=empty`), not a
retryable error. Videos without audio also succeed without loading ASR. Speech
intervals retain original timestamps; silent intervals remain available to native
audio/video indexing. ASR is invoked only on detected intervals. The generic
parsed-content contract carries optional publication assessments on the document
and its segments. Unaccepted segments must publish empty `text`; candidate words
remain only in the operational job receipt, outside library text and retrieval.
If detected speech yields empty or obviously degenerate/conflicting text, the
result is `needs_review`, not a fabricated transcript. This does not guarantee
transcription accuracy: music, singing and noise can still fool speech detection.

Assessment and segment changes participate in entry identity and survive library
export, original-preserving reparse, revision restoration and data relocation.
Only accepted words create text nodes. Native media nodes use the original source
and never encode transcript text as audio/video input. UI status messages are not
part of the searchable Markdown. A new generation becomes active only after its
index finishes; older parsing revisions and index generations remain available
for recovery. No global reparse is required to repair an individual entry.
