# Third-party notices

Original Echo source code: Apache-2.0. Upstream notices remain applicable.

## Windows Snap Layout integration

The narrow native maximize hit target in `apps/desktop/src/window_chrome.rs` adapts the MIT-licensed child-window pattern from Hyph-M/tauri-plugin-snap-layout, pinned revision `890a38662a5508e1c04bdf8b1c5726adc9ef893b`. Copyright 2026 Hyph-M; 2024 clarifei; 2024 Siddharth. The complete upstream license is in `resources/window-chrome/LICENSE` and the installed `runtime/licenses/window-chrome/LICENSE`. Source: https://github.com/Hyph-M/tauri-plugin-snap-layout/tree/890a38662a5508e1c04bdf8b1c5726adc9ef893b .

## Echo wordmark

The outlined Echo wordmark uses Inter by the Inter Project Authors, SIL Open Font License 1.1. Source: https://github.com/rsms/inter. The license accompanies the SVG under `apps/workbench/public/brand/Inter-OFL.txt` and remains in the installed web assets. No font binary is required. The separate Echo symbol is original project artwork.

## Application dependencies

Silero VAD 16 kHz ONNX weights: Silero Team, MIT. Pinned upstream revision `5cd7945676eb32225748052e2e6a0580e4686a08`, file `silero_vad_16k_op15.onnx`, SHA-256 `7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49`. Build metadata and license are in `resources/models/silero-vad`; the runtime retains them next to the model under `models/silero-vad`. Source: https://github.com/snakers4/silero-vad. Used offline on CPU only while parsing audio/video.

React and Vite: MIT. TypeScript: Apache-2.0. pi-agent-core/pi-ai: MIT. Tauri: MIT OR Apache-2.0. These are independent projects; their licenses are not replaced by Echo's license. Runtime JavaScript distributions retain their package LICENSE/NOTICE files under `node_modules`. The desktop distribution bundles the Node.js runtime with `NODE_LICENSE`, which also lists its included third-party notices.

The desktop runtime includes unmodified quantized ONNX BGE Small Chinese v1.5 weights (BAAI model, Xenova conversion), licensed under MIT. The revision, exact file hashes, upstream URLs and license text are retained in resources/models/bge-small-zh-v1.5 and runtime/models/Xenova/bge-small-zh-v1.5. Build-time download uses the pinned revision 75c43b069aac4d136ba6bc1122f995fedcfd2781. The installed default operates offline. Other model IDs do not promise hosted access or redistribution rights.

External DSH and Codex installations are user supplied, not bundled or relicensed by Echo. Echo uses their public SDK/App Server protocols and isolated data homes.

## Native image and inference libraries

The Windows sharp package includes dynamically loaded libvips libraries and other native components under their own LGPL and permissive terms. Echo's Apache-2.0 license does not replace those licenses or restrict compatible library replacement/debugging. The runtime distribution includes `licenses/native-libraries` with LGPL/GPL texts, component versions, upstream notices, source/build locations and replacement information. MPL-licensed Rust dependency sources are copied into `licenses/corresponding-source`.

The generated `runtime/licenses/inventory.json` records the packaged JavaScript and Windows Rust dependency versions and declared licenses; package notices are retained alongside it. ONNX Runtime's upstream license and third-party notices are included. Additional model weights remain user-selected external downloads.
