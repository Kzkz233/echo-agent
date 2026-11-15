# Integrated Windows caption

The main workbench, settings and registered extension popouts share the same
window factory, `PageHeader` and `WindowControls`. Windows uses a single 65px
caption/navigation row. The common brand remains in the sidebar; a popout without
a sidebar adds it to the header. Child pages do not create their own titlebar.

Tauri deep drag regions exclude controls. Tao retains native edge/corner resizing,
maximize work-area handling and window styles used for Windows snapping. The
maximize hit target uses a transparent native child window with `HTMAXBUTTON`;
Windows owns its layout flyout. Physical bounds are reported by the browser,
right-anchored natively during resize and updated for DPI/zoom changes. A small
top strip remains available for native resizing. Cleanup is owner-checked and
window-local. The avatar and sandboxed extension content have no caption grants.

Close runs through the existing unsaved-change guard. Browser and non-Windows
access keep ordinary decorations. Narrow layouts use the shared icon sidebar;
long tabs can scroll without displacing window controls. Themes use the same
appearance tokens as ordinary pages.

## Checks

- `pnpm verify`: application baseline, translations, types and build.
- Desktop `cargo test`: includes physical caption-bound validation across six scales.
- `scripts/appearance-ui-smoke.ts`: eleven browser views, both themes, live
  extension styling, navigation stability and four narrow widths, including the
  collapsed brand/text checks.
- `scripts/window-chrome-smoke.ts`: real isolated packaged WebView2 windows;
  main/settings/example-extension geometry, keyboard maximize/restore, stale-owner
  cleanup, out-of-caption geometry rejection, stable tabs/status, compact action
  gap, unsaved-close cancellation and narrow/DPI layout probes. Device-metric
  emulation verifies CSS geometry; it does not simulate moving between monitors.
- Native pointer checks are supplementary. Double-click maximize/restore is
  observed on the real desktop. Automated input/capture cannot reliably verify
  every OS flyout or multi-monitor drag gesture; those are not inferred from CSS
  snapshots alone.

Fixtures contain invented data and make no model requests. Audit screenshots
stay outside published assets. The adapted native hit-target pattern retains its
upstream MIT notice, documented in `THIRD_PARTY_NOTICES.md`.
