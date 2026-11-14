# Avatar renderers

Each enabled character can display its own native avatar at the same time. The plugin owns
a fleet of role-scoped instances: assets, animation state, bubbles, reply targets, recovery
and stop/start are independent. Disabling one role does not replace another avatar. Initial
home positions are offset; roaming and dragging retain the full work area. Frame renderers may coexist. The application shell remains a single instance per OS user.
The tray's Show/Hide controls affect the whole fleet without overwriting role activity or
individual display settings. Showing again restores only configured, active characters.

The bundled Hina and Miyu animations exclude transparent padding cells at the end of atlas
rows. Idle uses seven frames, waving four; the original artwork is unchanged. Updating the
examples imports the corrected manifest under a new asset identity.

`@echo/avatar` is the basic desktop plugin. It owns the native transparent window, frame animation, durable bubble claim/show receipts, conversation selection and native reply editor. Right-click or double-click the character, or click its bubble, to compose. The popup uses DPI-scaled rounded white cards and native text controls, without buttons or a browser renderer. Enter sends; Shift+Enter inserts a newline. Escape or clicking outside cancels and discards an unsent draft. IME composition Enter is left to candidate confirmation. The target conversation is pinned while a draft exists. A queued acknowledgement clears the draft; a send failure keeps it. Cancelling editing does not undo an already accepted input.

Closing the manager destroys its WebView. Keeping the basic avatar does not create a second WebView, run a JavaScript animation loop, load embeddings or invoke a model. PNG frames are decoded once under a 64 MB decoded-frame budget, then presented at the clip FPS. Assets are user selected; the bundled CC0 sprite is only a demonstration.

The desktop shell has one instance per operating-system user. Starting Echo again opens the existing manager, including after its WebView was closed, without replacing its core, avatar or conversation. `ECHO_DATA_DIR` selects the runtime at the first launch; quit Echo before choosing another runtime. Standalone headless cores may still use independent data directories.

## Frames

The Avatar workspace can import a PNG/JPEG/WebP image, a naturally ordered PNG frame directory, or a ZIP/directory containing `atlas.png` and `manifest.json`. Imports validate archive paths, coordinates, frame count and decoded size in an on-demand worker, then normalize the result into the native frame-atlas format under the user runtime. A thumbnail and animation speed are shown before choosing **Use this asset**. Importing does not change the active character automatically. Bundled and personal assets remain separate; imported assets are not release inputs.

Frame assets use `avatar.assets/import/select`; their records explicitly declare `kind: "frames"` and `format: "frame-atlas-v1"`. Imported manifests must declare the frame format.

Select `Frame animation` in Avatar. An optional directory contains `atlas.png` and `manifest.json`:

```json
{
  "format": "frame-atlas-v1",
  "clips": { "idle": { "fps": 10, "frames": [{ "x": 0, "y": 0, "w": 238, "h": 260 }] } }
}
```

Each clip has 1–120 frames and at most 30 FPS. Assign named clips for idle, working and speaking in the character's Avatar settings. Working follows Echo's conversation run events across inference backends. Speaking follows the native bubble lifetime and takes priority. An absent clip falls back to idle. The atlas and the total decoded frame budget are checked before the window loads the animation.

Both renderers share native window movement. With roaming enabled, an idle character walks along the work area using the `walk` clip when supplied. Generation, a visible bubble and the reply composer interrupt idle roaming. Observation moves the character to the bottom-right and holds it there. Dragging tracks the pointer; an enhanced avatar plays `picked`, `fall`, and `land` when those clips are present. After a drop, a docked avatar returns to its corner.

### Ground alignment

The shared host aligns the resting foot baseline with the primary Windows work-area
bottom (normally the taskbar's top edge), rather than aligning the transparent canvas.
Horizontal and top-edge margins remain unchanged; there is no extra vertical gap.
Dragging and body animations use the same fixed baseline, so an animation does not
reposition its window on every frame. Work-area changes are checked every three seconds.

A frame-atlas manifest may declare `groundY`: the baseline measured from the top of
the first idle frame, in unscaled frame pixels (`0 < groundY <= frame height`). Import,
character packaging and scaling preserve this metadata. Without it, the host uses
the lowest visible pixel across idle frames; wholly transparent materials fall back
to the canvas bottom. Calibration occurs only when loading a material.

ABI v1 native renderers may return `groundY` in their `describe` metadata, in **scaled
canvas pixels**. Existing renderers remain compatible: the host calibrates their
initial idle frame when the field is absent. Invalid declared anchors reject the new
material without replacing the running one. `avatar.status` exposes `ground.anchorY`,
`source`, `screenY` and `floorY` for diagnostics. No capture or inference is used.

## Native renderer extensions

`avatar.renderers@2` registers a material directory and an absolute native library
path with `abi: 1`. The base `echo-avatar.exe` loads that library inside its existing
process. The extension never creates its own bubble, input editor or avatar window.
One host owns movement, work-area bounds, window ordering, conversation pinning,
reply events and display receipts for both built-in frames and extension rendering.

The small C ABI is defined in `native/avatar-sdk`: create, request, pixels and destroy.
JSON carries bounded configuration/metadata and frame parameters; borrowed
premultiplied BGRA buffers avoid allocation or image encoding on every frame.
Renderers receive facing direction and can apply direction-sensitive depth ordering.
An optional motion callback can supply bounded position/activity overrides for
special body actions. Ordinary drag input, walking and inward idle facing remain
owned by the base host. No second process or additional animation timer is needed.

Disabling a provider removes its contribution and reloads ordinary frames without
changing the saved renderer or material selection. Reloading/replacing a renderer
destroys its instance before unloading its library. ABI versions are explicit;
legacy `avatar.renderers@1` executable providers remain supported for existing
extensions, but new extensions should use the shared-host contract.

Conversation names are routing metadata, not bubble or composer headers. A message
may still contain its own topic or report title as ordinary message content.
