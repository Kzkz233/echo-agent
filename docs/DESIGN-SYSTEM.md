# Workbench appearance

Echo uses neutral surfaces and graphite primary actions. Character artwork keeps
its original colors. Accent colors identify links and small interactive marks;
selected entries also use an underline, edge marker, check, or heavier text.
Statuses retain visible labels and icons alongside their semantic colors.

`packages/contracts/appearance.ts` owns the versioned appearance snapshot, color
roles, contrast adjustment, and extension base controls. Feature styles reference
semantic variables rather than defining a separate palette. `design-system.css`
owns shared product geometry; individual views retain their layouts.

Settings → Appearance & language provides system/light/dark appearance, accent,
interface and chat font sizes, stronger borders, and reduced motion. The default
scale is 14 px body/controls, 15 px chat, 12 px supporting text, and 22 px page
titles. Increasing interface size scales the shared hierarchy, including extension
pages, rather than enlarging only isolated labels. Older language/accent
preferences remain valid. Appearance changes do not migrate or rewrite roles,
conversations, tasks, permissions, library content, or indexes.

## Extension pages

Form contributions inherit the host controls. Sandboxed HTML contributions receive
the same base controls and tokens before their own markup. Extensions can use
`--background`, `--panel`, `--text`, `--muted`, `--line`, `--selected`, `--primary`,
`--primary-on`, `--accent-text`, `--success`, `--warning`, `--danger`, and the
corresponding soft surfaces. Shared radii are `--radius-control` and
`--radius-panel`. Optional classes are `echo-button`, `echo-primary`, `echo-panel`,
`echo-muted`, and `echo-selected`; they do not prescribe page layout.

`Echo.appearance` contains `{ version: 1, mode, reducedMotion, tokens }`.
Listen for `echo-theme-changed` to redraw custom canvases. The host synchronizes
appearance without remounting the page, so unsaved forms and local selections
survive a theme change. Only the authenticated parent bridge can update the
host-provided token set. This message carries no application data or authority.
Existing extension operations, sandbox restrictions, and lifecycle revocation
remain unchanged. Custom extension styles may override controls intentionally;
extensions should use the shared tokens when matching the application.
