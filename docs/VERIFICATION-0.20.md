# Echo 0.20 visual system verification

> Historical record. Current guidance is in the [documentation index](README.md). [Browse historical records](history/README.md).

The 0.20.1 follow-up also checks the shared navigation/layout boundaries described
in [WORKBENCH-ARCHITECTURE.md](WORKBENCH-ARCHITECTURE.md): explicit scope and companion
identity, editor presentation, registered plugin containers, and parent-preserving
navigation. The baseline now contains 474 application tests. Browser checks cover
sequential companion tab changes, fixed busy/action slots, task category restoration,
editor return, frameless iframe bounds, and preference saves during navigation.

- Baseline: `pnpm verify` (473 application tests), desktop Rust tests (4),
  and native Rust tests (21; two explicit capture probes remain ignored).
- `scripts/appearance-ui-smoke.ts` exercises eleven views in light and dark
  appearance, four narrow widths, system appearance changes, live sandbox styling,
  retention of local frame state, and rejected cross-frame authority.
- Default shell geometry is checked at the preview reference width: 190 px sidebar,
  65 px header, and aligned tab/header edges. Fonts use one shared hierarchy;
  interface and chat scaling are separate persisted preferences.
- Reference captures use the same invented conversation and 1048 px viewport as
  the approved preview. Body line height, 59 px companion cards, 630 px conversation
  reading width, and 646 px composer are calibrated together. Registered view
  tabs share the header instead of adding another strip above page content.
- Color checks cover primary text, secondary text, custom accent extremes, outgoing
  bubbles, primary actions, and status surfaces in both modes.
- Independent HTML extension read/write, stale mounts, strict parent CSP, and sandbox
  isolation are checked by `scripts/extension-browser-smoke.ts`.
- Production user content is excluded from all development and inference fixtures.
  Release preparation and publication audit committed source, installer payload,
  update archive contents, and hashes using the external local privacy policy.
