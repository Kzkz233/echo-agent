# Application updates

Open **Settings → Maintenance → Version & updates** to see the desktop and backend versions, edition, build time and build identifier. The build identifier ties together the embedded frontend, desktop executable and backend. A mismatch is shown explicitly.

Public builds check stable releases in this project's GitHub repository when the user selects **Check for updates**. Update downloads must match the exact repository asset URL, size and SHA-256 digest returned by GitHub. Personal builds import local `.echo-update` packages. The package edition and data format must match the installed application. The Windows x64 desktop currently supports in-app installation.

The `.echo-update` format is a ZIP containing `update.json` and an `app/` directory. The manifest records build information and the size and SHA-256 of every payload file. Extraction rejects absolute paths, parent traversal, Windows device aliases, alternate data streams, duplicate names and links. Local packages contain executable application code and should come from a trusted build.

Preparation happens while Echo runs. Installation requires a packaged desktop that owns its backend. Active operations and inference must finish first. A separate helper waits for the desktop and backend to exit, snapshots the main SQLite database and swaps the application directories on the same volume. User data and external libraries remain outside that swap. The installed executable name and NSIS uninstaller are retained.

The new desktop is accepted after its frontend has loaded and the authenticated backend confirms that all three build identifiers match. Launch failure, a failed integrity check or a readiness timeout restores the previous application. If a trial process cannot be stopped, the helper retains both application trees instead of moving open files. The journal records the outcome. Normal tasks resume after startup. Automatic recovery preserves current user data rather than replacing it with an earlier snapshot.

One previous successful application remains available through **Prepare rollback**. Failed candidate files and the pre-update database snapshot stay in the installation's sibling update directory for inspection. A successful later update replaces the older rollback slot. Interrupted operating-system shutdown or hardware failure may require recovery from these retained files. Rollback across incompatible data-format versions is rejected.

Release builders set `ECHO_EDITION` explicitly and generate both the installer and update package from the same build. Public release preparation audits the portable payload, installer and source. Publishing rechecks the update archive, every file hash and the public privacy policy. Application data is never a release input.
