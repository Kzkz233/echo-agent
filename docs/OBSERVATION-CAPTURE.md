# Observation window exclusions

Observation tasks own an editable list of excluded overlay windows. Rules match an executable
name or exact path, optionally narrowed by window title. No process has an unconditional bypass.
The same list applies to frame selection and final image capture.

An excluded window is neither an observation source nor an occluder. Exclusion takes precedence
if it also matches a source rule. Other windows still occlude content normally. Browser document
authorization and embedded-document masks remain in effect.

Desktop capture is sufficient when excluded overlays do not overlap admitted content. When they
do, Windows Graphics Capture reads the admitted source windows themselves. Each window contributes
only its own admitted rectangles to a black output image; the global union must never be used
to copy one window's pixels. This recovers the underlying application instead of copying the
overlay or blacking out its footprint. Geometry and source authorization are rechecked after
capture. Unsupported capture or an ambiguous resize discards the frame without falling back to
desktop capture containing the excluded overlay.

Window capture uses bounded, short-lived sessions which close after each sample, including on
errors. It does not start a background recording stream, increase the local sampling frequency,
or save screenshots. Windows may display its capture indicator around the target window.
Window exclusions do not grant access to applications, browser pages, or regions outside the
original source whitelist.

`captureBackend: "wgc"` appears in task diagnostics for the window capture path. Synthetic native
acceptance covers opaque and translucent overlays, retained authorization masks, editable rules,
and failure without unsafe desktop fallback. Run the interactive test explicitly on Windows:

```powershell
cargo test --release --manifest-path native/Cargo.toml --lib excluded_overlay_is_removed_without_revealing_masked_pixels -- --ignored --nocapture
```

The test creates only its own colored windows. It does not persist or upload captured images.
