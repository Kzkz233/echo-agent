# Echo Agent configuration

Echo Agent owns canonical conversations, context assembly, authorization, execution receipts,
and task scheduling. Pi is the built-in conversation execution engine, not a user-selectable
model provider. The application remains extensible through its existing operation and capability
registries, lifecycle scopes, and plugin dependency graph.

## Model services and executors

The workbench presents a service card with credentials, model discovery, and its enabled model
profiles. Internal connection/profile IDs remain stable; credentials are referenced rather than
copied into characters or tasks. Online APIs and existing local API services share this editor.

Main conversations and built-in workers run through the built-in agent. Observation and search
query generation use stateless inference transports. Review uses the agent or an explicitly
selected worker executor. Existing `core.pi` profiles remain readable; the UI does not expose an
Embedded Pi choice. New common services use `core.api`.

Worker adapters are contributed by their owning plugins. Their service editors appear in those
plugins' settings, and their execution profiles appear in executor pickers. They cannot bind a
main role. A worker template without a profile inherits the role's current main model at admission;
the admitted task stores the resolved profile. Workspace and tool permissions remain scoped.

The service editor displays stored configuration references. Deletion is refused while a model
is referenced by a conversation, character setting, shared default, or standard task configuration.
Changing an embedding model does not silently rebuild or replace an existing index.

## Configuration ownership

- Application settings own reusable model services, credentials, and shared infrastructure.
- Plugin settings own document parsers, embedding providers, managed local models, and worker connections.
- Character settings own personality, capabilities, grants, and explicit default model choices.
- Task instances own sources, prompts, schedules, and optional model/executor overrides.
- Shared libraries retain their own parsing and indexing policy; role permissions grant access.

An explicit task model wins over its character default. Character inference defaults omitted from
`routes` follow the current main model; they are not materialized into a hidden fixed route when
the character is saved. Shared inference tasks continue to use application defaults. Existing
explicit routes are preserved. Selected models never silently fall back to another provider.

## Registered frontend contributions

Plugin manifests can provide a character settings placement without changing the workbench:

```json
{
  "category": "Files and knowledge",
  "characterSettings": {
    "section": "research",
    "title": "Research",
    "order": 40
  }
}
```

The existing `core.characters.features@1` descriptor carries this presentation alongside its
schema-backed fields and task types. Unknown section IDs create additional categories. Creation
uses a four-step guide; subsequent editing uses categories. Both render and save the same draft
contract and feature providers. Native asset editors supplement the common form renderer.

The existing `core.ui.pages@1` contract also accepts `placement: "plugin-settings"`. Such pages
appear inside their owner's extension details and do not add sidebar entries. Form and WebView
pages retain the same operation grants, owner checks, cancellation, and unload behavior as other
extension pages. Extensions may still register workspace pages and character pages.

Inference task ownership comes from the registered provider, not a guessed ID prefix. Plugin
management provides functional categories and a dependency-order view. Runtime dependency order,
frontend placement, and context block ordering are distinct contracts.

## Retained state

Disabling a character capability suspends its tasks while retaining their parameters and prior
enabled intent. Re-enabling restores that intent. Explicitly removing a task remains a separate
operation. Editing other character fields while a plugin is absent retains its role association,
task IDs, and inactive settings. Native application paths, role IDs, and persisted messages are
independent of the Echo Agent display name.

## Verification

`agent-product.test.ts` covers conversation versus stateless execution, default inheritance,
task suspension/restoration, model references, and contribution ownership.
`frontend-extensions.test.ts` covers embedded plugin settings and lifecycle revocation.
`product-ui-smoke.ts` exercises the model-service workflow and role/task/worker settings with
synthetic local endpoints. Character and execution UI smoke tests cover the existing workflow.
These tests do not claim real upstream provider compatibility.
