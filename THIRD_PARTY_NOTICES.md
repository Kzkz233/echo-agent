# Third-party notices

Original Echo source code: Apache-2.0. Upstream notices remain applicable.

## Sample animation

Cute Girl — Free Sprites, author pzUH. Source: https://opengameart.org/content/cute-girl-free-sprites and https://pzuh.itch.io/cute-girl-free-sprites.

The source page identifies the asset as CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/legalcode.

Approved archive: https://opengameart.org/sites/default/files/CuteGirlFiles.zip

SHA-256: `facd021364fba2cfb25c21172ce890aea1bedbebab437be51c4426ee0dc9257d`.

The included transparent PNG atlas contains resized Idle, Walk and Jump frames. `manifest.json` preserves individual original names/hashes and the atlas hash. Reproduce with `pnpm exec tsx scripts/fetch-assets.ts`.

## Application dependencies

Silero VAD 16 kHz ONNX weights: Silero Team, MIT. Pinned upstream revision `5cd7945676eb32225748052e2e6a0580e4686a08`, file `silero_vad_16k_op15.onnx`, SHA-256 `7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49`. Build metadata and license are in `resources/models/silero-vad`; the runtime retains them next to the model under `models/silero-vad`. Source: https://github.com/snakers4/silero-vad. Used offline on CPU only while parsing audio/video.

React and Vite: MIT. TypeScript: Apache-2.0. pi-agent-core/pi-ai: MIT. Tauri: MIT OR Apache-2.0. These are independent projects; their licenses are not replaced by Echo's license. Runtime JavaScript distributions retain their package LICENSE/NOTICE files under `node_modules`. The desktop distribution bundles the Node.js runtime with `NODE_LICENSE`, which also lists its included third-party notices.

The desktop runtime includes unmodified quantized ONNX BGE Small Chinese v1.5 weights (BAAI model, Xenova conversion), licensed under MIT. The revision, exact file hashes, upstream URLs and license text are retained in resources/models/bge-small-zh-v1.5 and runtime/models/Xenova/bge-small-zh-v1.5. Build-time download uses the pinned revision 75c43b069aac4d136ba6bc1122f995fedcfd2781. The installed default operates offline. Other model IDs do not promise hosted access or redistribution rights.

External DSH and Codex installations are user supplied, not bundled or relicensed by Echo. Echo uses their public SDK/App Server protocols and isolated data homes.

## Native image and inference libraries

The Windows sharp package includes dynamically loaded libvips libraries and other native components under their own LGPL and permissive terms. Echo's Apache-2.0 license does not replace those licenses or restrict compatible library replacement/debugging. The runtime distribution includes `licenses/native-libraries` with LGPL/GPL texts, component versions, upstream notices, source/build locations and replacement information. MPL-licensed Rust dependency sources are copied into `licenses/corresponding-source`.

The generated `runtime/licenses/inventory.json` records the packaged JavaScript and Windows Rust dependency versions and declared licenses; package notices are retained alongside it. ONNX Runtime's upstream license and third-party notices are included. Additional model weights remain user-selected external downloads.

## Hina and Miyu starter characters

Hina Codex Pet and Miyu Codex Pet by Ryu JaeHyun. Visual artwork licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); package metadata under MIT. [Original repository](https://github.com/springtiger07/codex-chibi-girl-pets), pinned commit `6e8ca988a6b3db007cc74e5f0ab62aca5a801131`.

Echo adaptations: lossless PNG conversion, named animation mapping, idle previews, cropped/resized portraits, and individual animation frames used as optional chat stickers. Original WebP files, upstream notices and licence texts accompany the assets. This does not imply author or OpenAI endorsement. Generic role prompts and example workflow configuration are original Echo material. Reproduce with `pnpm exec tsx scripts/fetch-default-characters.ts`.
