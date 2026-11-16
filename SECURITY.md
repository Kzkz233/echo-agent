# Security

## Reporting

Do not include credentials, private conversations or desktop captures in public issues. For an ordinary bug, submit a minimal reproduction with invented data and the affected version.

For a suspected vulnerability, request a private reporting channel from the maintainer before publishing exploit details. Describe the affected component and potential impact without exposing secrets or live user data.

## Local service

Echo listens on loopback and requires a random bearer token. Host and Origin checks and a restrictive content policy protect the workbench. Keep `connection.json` private and do not expose the port publicly.

The optional `ECHO_WEBVIEW_DEBUG_PORT` setting exposes a local WebView debugging interface. Use it only with isolated test data. Ordinary launches leave it disabled.

## Extensions and tools

Local extensions are trusted executable code. They own processes running under the user's account. Application permissions restrict operations exposed through the registry and MCP bridge. They do not sandbox arbitrary code that the user chooses to launch.

External workers retain their own authentication and permission rules. Review their effective grants when connecting an executor or MCP server.

## Screen capture

Capture authorization is checked locally before encoding. Unknown sources, changing geometry and inaccessible committed URLs are denied. Only selected visible regions are encoded, and screenshots are not persisted by default.

GPU-protected or exclusive-fullscreen content can be unavailable. Capture checks do not protect against malicious software running as the same Windows user. Visual summaries remain model-generated interpretations.

[Privacy and data handling](docs/PRIVACY.md) · [Capture design](docs/OBSERVATION-CAPTURE.md)
