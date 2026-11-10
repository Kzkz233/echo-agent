# 0.14 implementation checklist

Approved scope: consolidate application components and knowledge workflows, retain optional domain plugins, repair model capability discovery, and complete calendar migration and interaction.

- [x] Required/optional dependency terminology and DAG/lifecycle validation; stop exposing `enhances` as a separate relation.
- [x] Fixed components: Storage, Clock, Model Services, Characters, Tasks, Knowledge. Internal implementation adapters are not separately toggled features.
- [x] Knowledge owns document libraries, parsing workflow, versions and common previews; raw objects use Storage. Default user library is Personal Knowledge.
- [x] Character-scoped library presentation combines profile, memory, concerns and archives with separate write policies. Hide system libraries from the default personal-library picker.
- [x] Consolidate image asset management into common attachments; retain ChatStick semantics in character configuration.
- [x] Semantic Search owns optional query/semantic/hybrid/reranking enhancements and embedding/reranking model categories. Consumers do not hard-depend on it.
- [x] Model resources expose category-specific fields; per-call thinking belongs to role/task configuration. Discover DeepSeek effort metadata and support MiniCPM chat-template thinking; show unknown/error distinctly.
- [x] Calendar field and action contributions.
- [x] Shared idempotent rescheduling with revision checks, dates/durations/reminders and child handling.
- [x] Calendar rescheduling and completed history.
- [x] Import the complete authorized PW agenda through service-exported data, deduplicate source IDs, preserve newer Echo edits and original completion/subtask/project data. No historical notification replay.
- [x] Package build, backup, deployment and live preservation audit.
- [x] Regression: 280 full tests; 52 targeted tests; product UI and calendar drag/history checks.
- [x] Role portrait import, preview, removal and portable role package; preserved persona text.

No private data or machine-specific configuration belongs in this checkout. Migration exports and deployment evidence remain in the private application area. Existing character text and task instructions must remain intact.

Private migration rehearsal passed: 195 missing records inserted, 12 existing records unchanged, 48 child relationships intact, no historical reminder replay. Live import and installed-UI verification passed. The completed-history view displays 143 parent entries (142 source completions plus the newer Echo completion).

Deployed 0.14.0: 357 messages, persona text, conversations, bindings and task instructions preserved. Two explicit model protocol corrections were audited separately. Native tests: 20 passed. Packaged Pi smoke used only a local synthetic endpoint. Installed workbench has zero page errors, six fixed component entries and a configurable character portrait.
