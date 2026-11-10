# Library storage

Each registered root is a portable library, separate from Echo's runtime configuration and conversations. It contains `library.sqlite` and a managed `objects/` directory. Runtime SQLite WAL/SHM sidecars can exist while a library is open: copying the main database alone during writes is not a safe backup.

## Authoritative content

`entries` stores stable ID, title, Markdown body, kind, logical export path, source identity/hash, revision, content version, updated time and plugin metadata. Common fields are columns. Plugin-specific structured metadata is JSON; it does not require adding a core column for every extension. A logical path is a category/export hint, not an editable backing Markdown file.

`files` describes managed originals. `objects` describes immutable content-addressed bytes. `entry_attachments` binds an entry to a particular object hash, name and role. Reimporting an original updates its current file identity and one current knowledge package; it does not create a package per chunk. Old object versions remain available for recorded provenance. The current version is also retained in `entry_revisions`; no background garbage collection deletes original content.

Bodies and properties are committed in one library transaction. Registry operations validate inputs; explicit revision checks reject stale edits. Changing files manually can still damage a library: object hashes, missing-file checks and verified backups help detect this; a database is not protection against deleting the entire directory.

Markdown refers to a registered attachment as `echo-asset:<SHA-256>`. The workbench resolves it through a scoped, expiring media grant. Image/audio/video bytes are streamed from local managed objects, including byte ranges; they are not converted into a large base64 RPC response. HTML is not executed. External Markdown images are not automatically fetched.

## Moving or exporting

`knowledge.export` has `bundle` and `markdown` modes, a selected `vaultId`, explicit destination `.zip`, selected kinds and optional source locations. Default kinds are `["knowledge"]`; source locations default off. It runs in an on-demand Worker.

- Bundle: a consistent current-entry SQLite snapshot plus only its referenced managed objects and a SHA-256 manifest. Extract it into a directory and register that directory through Files. Past body revisions are omitted; full history belongs to Backup. It contains no application credentials, conversations, model caches or Harness configuration.
- Markdown: normal `.md` files with front matter plus relative attachment links, source metadata and a checksum manifest. It can be read outside Echo; it is not a full application restore.
- Backup: an application snapshot, all registered library snapshots/objects and raw observation text. Restore requires a new empty runtime and disables automatic effects. Credentials are deliberately excluded.

Exports create a new file and do not overwrite an existing destination. Exporting additional kinds can include private character content. Full private preview data lives outside the checkout and is never part of the release builder's source/runtime inputs.

Keyword recall works without an embedding provider. Semantic vectors and model caches are derived enhancements, not the only copy of the knowledge or memory text. They are not required to mount a library or read its Markdown.

Files owns the shared entry store and keyword index. Knowledge adds editing, library search and source processing. Import can save just the original or start a recoverable parse job with the selected provider. Persona, Memory and observation archives can write their own managed entries without the Knowledge or Documents plugins. Semantic search adds a provider without changing the entry identity or keyword index.

## Libraries and search

The library picker selects a storage/ownership boundary. Each library has its own collapsible logical folder tree. Library choices show their registering plugin, or manual registration, in parentheses. Switching it clears the current entry, folder and search results. Content kind is a separate optional filter under Advanced Search; it is not a second library selector. Ordinary knowledge uses a user-editable library. Persona, Memory, Observation, and Memory Review use their own plugin-owned libraries.

Ownership is recorded both in the application registration and the portable library metadata. Generic text edits, imports, source repairs and bulk operations reject writes to a managed library, even when its owner is disabled or the library is copied and registered again. Use the owning feature to change its records. Third-party extensions may call `files.declare {name}` with the declared `files.declare` permission; the host derives the owner from the calling plugin identity. They can call `knowledge.save` with `knowledge.write` to update their own library; submitting an owner/writer field cannot impersonate another plugin.

Advanced Search offers keyword, semantic or hybrid ranking, weighted query fusion, exact-folder scope, directory boost, explicit query expansion and optional model reranking. Expansion/reranking use the configured query inference route and never run just from opening the page. Keyword candidates use a local SQLite FTS5 index with Chinese bigrams and title weighting, then bounded chunk ranking. The derived index is rebuilt when a library is first searched or written, maintained transactionally, and omitted from portable filtered exports.

Vector Index shows indexed/missing chunks for the selected scope. Building it is explicit and checkpointed; pausing or shutting down preserves completed vectors, and starting again computes only missing versions. Knowledge search does not silently vectorize the entire library. Pure semantic search reports a missing index; hybrid search can use keyword results while semantic indexing is unavailable. Local GGUF, ONNX and embedding APIs are supported. Structural vector imports preserve original nodes, float32 bytes, media modality, parent references and entry-body hashes. Matching imported documents skip new chunk indexing. Changed bodies invalidate their imported coverage. Local models load on first use; by default the worker releases after two idle minutes. `keepLoaded` retains the loaded model until plugin disable or application exit, reducing repeat-query latency at the cost of resident memory. ONNX inference uses one worker thread; GGUF defaults to two CPU threads in a supervised subprocess. Search over imported vectors runs in an on-demand worker and streams rows, without a resident full-matrix cache. Application backups include a consistent structural-index snapshot; model weights remain external. No model download occurs without configuration.

## Plugin boundaries

Files owns library/container mechanics, immutable original objects and attachment access. Knowledge owns text entries, logical folders, revisions, source binding, keyword retrieval and parser/retrieval extension points. Documents and Semantic Search independently enhance Knowledge. Neither document parsing nor keyword search requires vectors.

Archive status is entry metadata and excludes that entry from ordinary search. Permanent entry deletion is allowed only after archiving and requires explicit UI confirmation; its original objects remain. Revision restoration creates a new revision rather than overwriting history. Source rebinding verifies the same original hash and does not silently attach a different file.

Import jobs capture immutable source bytes before parsing. Only one ordinary parser job runs at once; shutdown pauses unfinished work and explicit resume uses captured bytes. No parser worker remains resident while idle.
