# Privacy and recovery

- No telemetry, automatic provider selection, bundled API account or secret sharing.
- Capture is off by default. No screenshot upload or model download without user configuration.
- Actual browser document URLs are verified through Windows accessibility. Other top-level windows and unauthorized iframe regions must be denied; unknown geometry is not permission to capture more.
- The capture helper draws authorized visible rectangles into a black buffer. Browser chrome is excluded. Layered window regions and invisible system input-pane hosts are treated separately so a transparent fullscreen helper is not mistaken for an opaque screen-covering window.
- Window/URL proofs are rechecked before/after capture. Changes discard the frame. This is a desktop capture implementation with OS/version limitations, not a security boundary against malicious software running as the same Windows user.
- Pausing increments the observation generation and aborts requests. A stale generation cannot publish text or start an interaction. No screenshot is retained for failed inference.
- UI endpoints require a random token, validate loopback Host and permitted Origin, and do not accept an API key in a URL query. There is no LAN listener.
- Windows credentials use current-user DPAPI. Non-Windows fallback uses an AES-GCM key file with restricted filesystem mode; it is not a hardware-backed vault.
- Explicit local extensions and external Harnesses are programs under the user's account, with their own permissions. Do not load untrusted code merely because it runs in another process.

## Durable operations

Accepted input has a durable submission record. Request IDs prevent repeat execution; conflicting reuse is an error. Each logical conversation has one active binding epoch. Startup changes interrupted running operations to unknown and does not blindly repeat them. Queued input that has not begun can resume; an unknown run blocks later generation until reconciled or explicitly resolved.

Native result inspection can settle a Codex run. Backends without a supported query API require human confirmation. An accepted prompt is not a completed reply. Bubble delivery is separately claimed and acknowledged only after rendering; a claimed but unacknowledged result is not automatically replayed to another window.

Review stores its frozen material collection, packet receipts, accumulated notes and source references. It does not advance processed watermarks on partial reading. Core memory changes require explicit approval and are not available through ordinary MCP memory writes. Review uses a distinct task route and does not compress or rewrite the user's main conversation as maintenance.

The repository and desktop distribution contain no production profile or real conversation. Test fixtures use synthetic text, a local fake model and isolated external-Harness homes. Publishing a user's data directory is outside the release workflow.

`pnpm desktop:build` remaps the builder's home and checkout paths in Rust compiler output, including dependency panic locations. Release packaging rejects executables that still contain the builder's home path, as UTF-8 or UTF-16, before creating release directories. Debug-symbol stripping alone does not remove those diagnostic strings.

Libraries store Markdown, properties and revisions in their own SQLite containers. Immutable media/originals are separate hash-addressed objects. Export defaults to ordinary knowledge and removes source-machine paths unless requested; a full private backup has a broader scope. Media is streamed through one-object, expiring access tickets that are revoked on Files unload. Imported external images are not fetched automatically by the Markdown reader.

Optional private acceptance data must live outside the checkout and all packaging inputs. It is not a default profile. A local user may provision their own credentials there without changing the public distribution. QQ uses a dedicated direct dispatcher rather than the system proxy. Its peer IDs, text and receipts are private Runtime data; no Observe reply is automatically sent to QQ.
