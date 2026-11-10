# Contributing

Echo uses TypeScript for its core, plugins and React workbench, with Rust only for native desktop integration and capture. Node.js 24+, pnpm and a Windows Rust/MSVC toolchain are sufficient for the complete build. The server/workbench can be developed without the native shell.

Run `pnpm run verify`. Native changes require `cargo test --manifest-path native/Cargo.toml` and a desktop build. Browser acceptance is `pnpm exec tsx scripts/e2e.ts`; native Windows acceptance scripts use isolated test data and synthetic inference, never the developer's existing Harness configuration.

Keep plugin dependencies acyclic. Every timer, listener, process and worker needs a disposer. Feature plugins must not read another plugin's private files or create their own internal HTTP services. Extend typed operations/context/material ports instead. Unknown model or tool outcomes require reconciliation; do not add automatic replay.

Do not commit credentials, personal prompts, histories, screenshots of real desktops, model weights or runtime databases. Keep examples invented. Add upstream notices and asset provenance when adding dependencies. Contributions to the original project code use Apache-2.0.
