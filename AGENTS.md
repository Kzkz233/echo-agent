# Echo development

- Standalone new application. Never import private Workspace configuration, data, credentials, prompts, or runtime code. Examples use invented identities.
- Apache-2.0 for original code. Keep upstream licenses and asset provenance. No automatic publishing, autostart installation, production harness configuration changes, or real model spending during tests.
- Canonical conversations belong to Echo. One active backend binding and one run per conversation. Unknown side effects require reconciliation, never blind replay. Control/observation events are not human speech.
- Plugins use the typed operation registry. Dependencies form a DAG. Core must work without feature plugins. Disable releases timers, listeners and workers. Native or third-party execution requires explicit user configuration.
- Capture is off by default. Authorization and occlusion masking happen locally before encoding or network calls. Unknown sources are denied. Pause revokes pending batches/results. Do not save screenshots by default.
- User data lives outside the checkout. Test in temporary directories and use fake local inference endpoints. Keep expensive model loading and image processing off the main event loop.
- `pnpm verify` is the baseline check. Native desktop changes additionally require Rust tests/build. Record verification limits honestly; mock tests do not prove real provider compatibility.
