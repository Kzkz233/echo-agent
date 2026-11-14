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
6. Publish the existing knowledge update event. Keyword indexing uses the new body;
   semantic candidates must match current chunk versions. Reindexing remains an
   explicit existing operation; installation does not rebuild existing vectors.

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

Audio/video import currently transcribes an audio track. Segment ranges are not
word alignment or speaker diarization. A visual analysis provider can register its
own descriptor and return the same public result shape; it is not silently run.
Search results include segment ranges when a matching text chunk overlaps them.

## Storage, migration and resources

Auxiliary tables add source versions, revision source/asset/parse references and
parse generations. Existing rows and base table layouts are retained. Upgrade
does not infer unknown historical provenance or change existing bodies, entry IDs
or indexes. Moving application data rebases explicitly registered machine paths;
external model files and external libraries remain referenced in place. Providers
declare path-bearing plan fields with the existing `storagePaths` manifest contract.

Library bundle export includes current text, attachments, original bytes and the
current provenance/segments, using streaming ZIP64. By default it omits external
source paths and historical revisions. A mounted exported library can reparse its
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
