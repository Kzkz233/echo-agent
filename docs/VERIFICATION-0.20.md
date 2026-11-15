# Echo 0.20 visual system verification

- Baseline: `pnpm verify` (473 application tests), desktop Rust tests (4),
  and native Rust tests (21; two explicit capture probes remain ignored).
- `scripts/appearance-ui-smoke.ts` exercises eleven views in light and dark
  appearance, four narrow widths, system appearance changes, live sandbox styling,
  retention of local frame state, and rejected cross-frame authority.
- Default shell geometry is checked at the preview reference width: 190 px sidebar,
  65 px header, and aligned tab/header edges. Fonts use one shared hierarchy;
  interface and chat scaling are separate persisted preferences.
- Color checks cover primary text, secondary text, custom accent extremes, outgoing
  bubbles, primary actions, and status surfaces in both modes.
- Independent HTML extension read/write, stale mounts, strict parent CSP, and sandbox
  isolation are checked by `scripts/extension-browser-smoke.ts`.
- Production user content is excluded from all development and inference fixtures.
  Release preparation and publication audit committed source, installer payload,
  update archive contents, and hashes using the external local privacy policy.
