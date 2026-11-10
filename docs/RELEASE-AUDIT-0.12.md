# 0.12 implementation audit

The 0.12.0 completion report was too broad. The main features were present, but
the audit found integration gaps. These are corrected in 0.12.1.

| Agreed behavior | Implementation and verification |
| --- | --- |
| Consistent saved-credential fields | Model services, MinerU, QQ and mail use `CredentialInput` and the secret resolver's availability result. Blank input preserves the existing reference. |
| Clear plugin names | File Management, Retrieval Enhancement, Embedding Models and Ongoing Concerns are separate product concepts, localized in the workbench. |
| Local query construction for memory | Default for new characters: segmentation, stopword filtering, current/recent-turn weighting, bounded terms. An existing model-assisted policy is preserved. |
| Bounded conversation input | Current text and recent natural dialogue form a compact query. The audit fixed `slice(-0)` incorrectly including all history when the window was set to zero. |
| Correct memory dependencies | Persona Memory depends on Persona and File Management. Query construction and BM25 work with document parsing, Knowledge and embeddings disabled. |
| Role-level recall choices | Model-assisted queries, query model, reasoning, prompt and bounds belong to the character. Portable policies survive character-package round trips; local model bindings do not export. |
| Independent retrieval enhancements | Explicit query optimization, shared semantic indexing and opt-in reranking can be configured independently. Disabling the encoder does not disable query optimization or reranking. |
| Capability-based model categories | `core.inference.kinds@1` contributes language/vision, embedding and reranker categories. Existing services are filtered by the models actually registered on them. |
| Dedicated reranker option | Language-model reranking and dedicated `/rerank` models have separate routes. The latter supports compatible online or existing local endpoints. Invalid/foreign candidate indexes are rejected. |
| Application-owned clock | Clock is built in. The audit removed a calendar schema default that could silently recreate a private time zone and added rescheduling when Clock changes. Explicit task overrides remain. |
| Controlled data relocation | Offline copy, hashes, SQLite checks, original data retention and startup fallback are implemented. The audit added model-path coverage, target lock ownership and cancellation before restart. |
| Extensible migration ownership | `storagePaths` in plugin manifests declares exact JSON pointers, including inactive plugins. Local plugins can declare only their own collections. Migration does not guess paths inside free text. |
| Backup integration | Backup uses the core SQLite snapshot/integrity primitive and retains its existing export policy. Local whole-directory relocation includes credentials; portable backups do not. |
| Single-file plugin packages | `.echo-plugin` inspection and installation do not run plugin code. Staged updates now validate cycles against other staged versions, and rollback is exposed in the plugin UI. |
| Consolidated role settings | Avatar configuration is in the role editor; only show/hide remains on the main conversation. Channel binding was missing from the editor after its old tab was removed; it now uses the existing binding APIs under Channels and Expression. |

## Regression evidence

`tests/release-audit.test.ts` exercises zero history, actual new-character defaults
under a legacy model policy, Clock/calendar interaction, declared migration paths,
model references, target locking, cancellation, and staged dependency cycles.

The existing retrieval, package, lifecycle and resource-authorization tests remain
in the full suite. Product and character UI smoke tests check the real generated
frontends with synthetic local providers. `storage-startup-smoke.ts` starts the
real server twice through a temporary relocation and bootstrap locator.

## Deliberate limits

- Local query construction is a deterministic lexical heuristic, not an LLM's
  semantic understanding or a TextRank implementation. Ambiguous references and
  multi-topic dialogue may benefit from the optional model path.
- Disabling model-assisted query construction does not disable an independently
  selected semantic encoder. It eliminates the query-construction LLM call only.
- The dedicated rerank interface is implemented and tested with a synthetic
  compatible endpoint. It does not automatically supply an account, download
  weights or establish compatibility with an unspecified real provider.
- Packaged extensions use the Node runtime in this format version. Directory
  extensions retain the existing process interface. Integrity hashes do not
  authenticate publishers or create an OS sandbox.
- Existing channels can be bound in the character editor after the character and
  its main conversation have been created. Binding uses an explicit Save Binding
  action; it is not a second copy of the character configuration.
