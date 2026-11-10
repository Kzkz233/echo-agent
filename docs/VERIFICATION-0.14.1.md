# 0.14.1 follow-up audit

This release preserves saved profiles, routes, characters, portraits, conversations,
tasks and imported agenda data. Unavailable model selections stay visible but
disabled; no fallback model is silently saved.

| Recent requirement | Follow-up |
| --- | --- |
| Query expansion and language reranking use auxiliary inference | Model candidates now use backend eligibility; external workers are excluded. |
| Main conversation, recall, observation, Review and delegation choose appropriate models | A shared selector consumes task/context eligibility from `inference.options` or bootstrap. Review and delegation retain worker choices. |
| New plugins contribute model fields | Fields can declare `inferenceTask`; the generic renderer uses the same selector. Unknown or unavailable tasks fail closed. |
| Inherited role defaults are usable | The selector checks the effective model and adapter modalities. Enabled observation/Review tasks validate inherited choices before starting. |
| Paused Review can change its worker | Resume uses the same registered task policy, with stale selections disabled. |
| Calendar supports dragging | Tauri/WebView2 file-drop interception is disabled for workbench windows. Tests hold real task text and move the pointer. |
| Subtask dragging preserves task identity | Drag-start propagation stops at the dragged task. Independently dated children appear in the destination cell. |
| Portrait updates reach all workbench windows | Public persona saves publish a refresh event. |
| Earlier completed history is visible | Imported records remain unchanged; completed parent entries show children without listing them twice. |
| Personal knowledge, managed character libraries and fixed components | Existing 0.14 UI acceptance is repeated against the installed package. |

Automated checks use synthetic identities and local inference endpoints. Native
desktop acceptance uses a separate data directory and runs only after the live
desktop has fully exited. Private preservation records stay outside this repository.

Verified: 286 automated tests, the Rust desktop test, model-selector and role-editor UI scenarios, and native Windows pointer acceptance. The legacy native build failed calendar moves; the fixed build passed the native pointer check. Installed-package checks confirmed eligibility matches the visible options and existing data/configuration remain intact.
