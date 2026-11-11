# Independent extensions

Echo separates the installed application from user-owned data. Installers and core updates replace application files only. Conversations, role grants, task configuration, encrypted credentials, external MCP registrations and installed extensions live in the data directory. Uninstalling an extension removes its registration and interfaces, retaining its data. Core uninstallation also retains the data directory.

## One lifecycle

An independent `.echo-plugin` package uses the same plugin manager, dependency DAG, operation permissions, capability registry and cancellation scopes as bundled features. Its pages contribute to the existing frontend catalog. The workbench does not import package-specific pages. Missing dependencies leave consumers pending; disabling a required provider releases its consumers first. Optional providers can disappear without disabling their consumers.

Bundled features are still shipped with the application and can be disabled. They are not independently installable packages. The extension screen distinguishes bundled features from locally installed extensions; only independently installed extensions have an uninstall action. Core components remain mandatory. Shipping code in a core artifact does not grant it a separate installation lifecycle.

## Runtime choices

The default `node` runtime starts an isolated JSON-RPC process when enabled. It uses the documented operation and capability bridge. HTML pages run in a sandboxed frame, without connection credentials or direct network access. Page calls retain the contributing extension's permission and lifecycle scope.

The optional `module` runtime is for explicitly trusted Node extensions needing shared, versioned dependency APIs or packaged native helpers. It runs with the user's local process privileges; it is not a security sandbox. Inspection and installation never import its entry point. Disabled modules remain metadata only. Enabling a module validates its installed inventory, imports its entry, and calls `createPlugin(host)`. Native helpers and workers belong to the package and must be released by its disposer.

Module packages use `echo-plugin-v1`, `runtime: "module"`, and `hostApi: 1` in `echo-package.json`. The entry exports `createPlugin(host)`, returning a normal plugin whose manifest exactly matches `echo-plugin.json`. Module APIs cannot declare themselves core components. Ordinary integrations should prefer registered operations and capabilities.

```ts
export function createPlugin(host) {
  return {
    manifest,
    activate(context) {
      // Register owned operations, providers, and cleanup with context.
    },
  };
}
```

`host` exposes `apiVersion`, the package `directory`, `dataDirectory`, shared storage and events. `host.dependency(id, version)` accesses a dependency's explicit `Plugin.api` export. The dependency must be declared in the manifest, active, and expose the requested API version. An incompatible API fails that extension's activation, not application startup. Extensions can export their own versioned APIs through the same mechanism; application assembly has no extension-specific lookup table.

## Packaging and updates

```sh
pnpm exec tsx scripts/package-plugin.ts ./my-extension ./my-extension.echo-plugin entry.mjs LICENSE view.html
# Trusted module variant:
pnpm exec tsx scripts/package-plugin.ts --module ./my-extension ./my-extension.echo-plugin entry.mjs LICENSE view.html
```

The packer includes only explicitly listed files and adds a SHA-256 inventory. Keep credentials, models, user material and runtime databases outside extension packages. Installation copies files beneath `extensions/<id>/<version-directory>` in the data directory. Updating a package records its previous registration for rollback and takes effect on restart. New installations start disabled; stale intent never silently authorizes new code.

Core updates do not replace that directory. Update rollback changes program files without reverting current user history. Public release audits continue to inspect source, installer and core update contents independently of the local extensions installed on a developer's device.

## Optional desktop renderers

Renderer extensions contribute `avatar.renderers@1`; the result can provide a native protocol-compatible executable, animation names and state-to-animation defaults. `avatar.materials@1` contributes material import/preview operations and format metadata. The base desktop plugin owns windows, conversation bindings and delivery receipts. Disabling a renderer retracts its registrations and falls back to the base renderer without rewriting the saved selection.
