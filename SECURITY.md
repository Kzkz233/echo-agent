# Security boundaries

Echo listens on loopback and requires a per-launch bearer token. Host/origin checks and a restrictive content policy protect the workbench. Do not expose the port publicly or share `connection.json`.

Local extensions are trusted executable code, not an operating-system sandbox. They require explicit trust and own their processes. MCP permissions limit exposed application operations; they cannot restrict arbitrary code a user has chosen to launch. External Harnesses retain their own permissions and authentication rules.

Capture authorization is checked locally before encoding. Unknown sources, changing geometry and inaccessible committed URLs are denied. Only selected visible regions are encoded; screenshots are not persisted by default. GPU-protected or exclusive-fullscreen content can be unavailable. Avoid treating visual summaries as verified facts.

Do not post keys, private logs or desktop captures in a public issue. A minimal reproduction with invented data is preferred. The optional `ECHO_WEBVIEW_DEBUG_PORT` diagnostic setting exposes a local WebView debugging interface and must be used only with isolated test data; ordinary launches do not enable it.
