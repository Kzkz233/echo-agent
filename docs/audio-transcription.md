# Local audio transcription

Audio Transcription (`@echo/asr`) is an optional application plugin. It contributes a speech model category, a typed inference provider and a knowledge parser. Disabling it removes these contributions without disabling knowledge, memory or semantic retrieval. No model loads at application startup.

## Configure

1. Enable **Audio Transcription** in Extensions.
2. In **Model Services → Speech recognition models**, add a local llama.cpp service and select a compatible `llama-server` executable.
3. Add the ASR GGUF model and its matching audio encoder. Select CPU or GPU and the CPU thread count. Quantization is determined by the selected files.
4. In the plugin settings, select this model for **Library audio and video transcription**. Choose the FFmpeg executable; FFprobe must be installed beside it or available on PATH. Optional language and vocabulary settings apply to subsequent jobs.
5. Import an audio or video file into a personal library. The matching parser is selected automatically when it is the only active media parser. An explicit parser selection takes precedence. Documents retain their separate parser.

The recommended Qwen3-ASR 1.7B Q8 pair is pinned in `resources/models/qwen3-asr-1.7b/manifest.json`. The language model and encoder together require 2,520,744,288 bytes of disk space; runtime memory also includes computation buffers. Model files and native runtimes are not embedded in the application installer.

## Processing and resource use

Originals are archived using streamed hashing. The source-based `files.extract@2` contract carries a library ID, file ID and expected source hash rather than an arbitrary file path or the entire file as Base64. Legacy parsers retain `files.extract@1` and its size limit.

The parser uses FFmpeg to extract short 16 kHz mono PCM segments. It keeps one segment on disk at a time. The ASR model is loaded on demand, reused during the file and released when processing finishes, fails or is cancelled. A guardian owns the local server and stops it if the parent application exits.

Completed segments are checkpointed. Import progress, pause and resume appear in the library import history. Only a complete transcript replaces the knowledge entry, through the common publication transaction. A job freezes its transcription settings and model artifacts; changing defaults affects new jobs. Resume keeps the old plan. Explicitly reparsing the archived original creates a new generation with new defaults; incompatible transcripts are never combined. A restarted application leaves interrupted imports paused until the user resumes them. CPU threads and executable locations are execution bindings and can be repaired without discarding completed segments when artifact identities match. See [Knowledge parsing](knowledge-parsing.md).

The default segment length is 30 seconds, configurable between 10 and 60 seconds. Files may be up to 8 GiB and 24 hours. Only file and pipe media protocols are allowed, so importing a file cannot cause FFmpeg to fetch remote media. Transcripts are untrusted source material, not agent instructions.

Time ranges identify audio segments, not word-level alignment. Click a time range to load the archived original at that position using the common protected attachment renderer. Playback depends on the desktop browser supporting the original format. This version does not claim speaker identification or precise word timestamps. These can be contributed as additional capabilities later.

## Verification

`tests/asr.test.ts` covers model eligibility, plugin lifecycle, streamed imports, checkpoint resume, cancellation and protocol normalization using synthetic inference. `scripts/asr-smoke.ts` accepts explicit local paths and tests the actual installed model in an isolated library without paid inference or personal data. It is a functional compatibility check, not an ASR quality benchmark.
