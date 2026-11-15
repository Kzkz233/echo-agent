# Workbench navigation and layout

The application window, navigation scope, functional page, and page-local views
have different owners. A child page does not rebuild its parent's navigation.

| Layer | Owns | Examples |
| --- | --- | --- |
| Window shell | Sidebar, window mode, connection, opening other windows | Main window, separate settings, extension popout |
| Navigation location | Scope, section, page ID, role identity | Role tasks and application automation have distinct scope |
| Scope header | Identity, sibling page tabs, stable action and status slots | Chat / working conversation / role information / tasks |
| Functional page | Title, page actions, content, local scrolling and loading | Knowledge browser, task workspace, model settings |
| Page-local view or detail | Category, filters, selected entity, editor return | Automation / subtasks; selected task; role configuration |

`navigation.ts` resolves a single `WorkbenchLocation`. Core pages and registered
frontend pages use the same resolver. Plugin `placement` determines scope;
`section` determines the sibling navigation group. Role identity belongs to the
role route. Application pages do not inherit it simply because a role was
previously selected. Existing string navigation calls are adapted by the host.
Presentation is separate from scope: a role editor still belongs to the role
domain, while chat uses a conversation surface and a frameless plugin uses an
embedded content surface. These modes do not introduce another navigation level.

`PageHeader` and `PageTabs` render parent chrome outside the content outlet.
Selected labels reserve their heavier text width; unread markers and busy states
do not shift sibling tabs. The role action area has stable status/configuration
slots across all role pages. Page-local task tabs reuse the same tab component.

The outlet stays mounted when the selected child changes. Child rendering and
loading happen inside it. Chat and working conversations use their own message
scrollers; management pages use the normal content scroller. A repeated role
breadcrumb must not be inserted between the parent header and selected page.

Page-local state stays with its page, rather than becoming application settings.
The task workspace retains category, filters and a selected entity reference in
window session storage. It resolves current entity data from the backend; it does
not cache task content or permissions there. Role editors remember their entry
location so closing or saving an existing role returns to the originating page.

## Extension boundaries

Extensions register pages, operations, and optional page sections using the
existing frontend contracts. A contribution supplies its own form or webview
content; the host supplies its parent navigation and container. Sandboxed page
navigation passes through the common host navigation and unsaved-change guards.
An extension does not need to implement another application sidebar or role
header. Its internal subviews and entity details remain inside its content area.
For ordinary forms/webviews the host supplies the page title and content inset.
A webview that declares `frameless` owns its page content title, padding, and inner
scrolling. The host fixes its viewport beneath the scope header from registration
metadata, including during loading. CSS fills that viewport; the plugin must not
recalculate height from the outer application window.

Appearance and geometry use the shared system described in
[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md). These presentation changes do not migrate
canonical conversations, roles, capabilities, permissions, task configuration,
knowledge content, or indexes.

## Verification

The browser audit switches role pages without reloading, compares every tab's
position and width, and checks the content origin. It also checks role/application
deep links, editor return, page-local task category restoration, queued preference
saves during navigation, narrow windows, and live sandbox appearance. Route unit
tests cover core and registered page scope, role identity, and plugin removal
fallback context. All fixtures are isolated and use invented content.
