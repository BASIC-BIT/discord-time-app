# Auto-updater: silent check, restart to update

Status: approved by BASIC on 2026-11-04. Plan: [2026-11-04-auto-updater.md](../plans/2026-11-04-auto-updater.md). Issue: [#27](https://github.com/BASIC-BIT/discord-time-app/issues/27).

## Intent

HammerOverlay already has most of an updater: `tauri-plugin-updater` is registered, `tauri.conf.json` points at `https://github.com/BASIC-BIT/discord-time-app/releases/latest/download/latest.json`, and `release.yml` signs the MSI with the minisign key in the `TAURI_SIGNING_PRIVATE_KEY` secret and uploads `latest.json` plus `.msi.sig` (both present on v0.1.5 and v0.1.6). Nobody benefits because the only entry point is the tray item "Check for Updates", which opens a window with a button. Nothing checks on its own, nothing relaunches, the window says "Current version: 0.1.0", and it has never been exercised end to end on an installed MSI.

The goal is that a user who installed once keeps getting parser fixes without ever thinking about updates. Their only interaction is a restart.

## Goals, non-goals, anti-goals

Goals:
- The app finds, downloads and verifies a newer signed MSI on its own.
- The user sees one thing: a tray item "Restart to update X.Y.Z". If they never click it, the update installs on the next launch.
- An update never fights a locked sidecar file and never ends up reusing an old sidecar.
- The updater signing key's custody, rotation and the rollback path are written down.
- The whole path is proven once on a real installed MSI, as `AGENTS.md` requires for updater changes.
- The first hop from today's v0.1.5/v0.1.6 installs (old updater code, manual button, no pre-exit hook) is in scope (BASIC, 2026-11-04): the new build must not adopt the old sidecar, and the smoke test covers that hop.

Non-goals (later slices, listed in the issue): beta/stable channels, staged rollout, a real Authenticode identity, a per-user installer, downgrades.

Anti-goals:
- Interrupting a parse. A user mid-typing or waiting on a result must never lose it to an installer.
- Prompting. No dialog that asks "update now?". The tray item is the whole surface.
- A silently failed update. Failures are logged and visible in the update window; they never block the app.

## Constraints

- The branch must start from `main` at or after PR #26 (hosted key compiled in at release build time); this worktree currently sits one commit behind it.

- Windows MSI only, per-machine install. Each install raises one UAC prompt. BASIC accepted this over a per-user NSIS installer, which would force every existing user to reinstall by hand once.
- Hotkey readiness beats everything else (`AGENTS.md`). The first check waits until well after launch and the download runs on a background task.
- The hosted SLM key is compiled into the binary from `HOSTED_SLM_API_KEY` at release build time (main, PR #26), so an update built by `release.yml` carries it. Nothing in the app needs to change for that.
- No new runtime dependencies. The Rust side of the plugin already does check, download, verify and install; the JS updater and process plugins are not needed.
- Windows-specific change: PR and merge need smoke evidence from the exact installed MSI.

## Decisions

### User experience (BASIC's choice: silent, restart later)

1. Shortly after launch the app checks the manifest in the background, then again every few hours while it sits in the tray.
2. When a newer version exists, it downloads and verifies the signed MSI in the background and says nothing.
3. Launch-triggered check: once the download is verified, if the overlay window is hidden the update installs right away. The app exits, the installer runs in passive mode (progress bar, one UAC prompt), and the installer relaunches the app. This is the "installs on next launch" behaviour; autostart at login counts as a launch.
4. Otherwise (overlay visible at that moment, or the update was found by a later periodic check): the tray gains "Restart to update X.Y.Z". Clicking it installs the cached bytes. The overlay itself stays quiet.
5. "Check for Updates" in the tray stays. Its window shows the real installed version and the current updater state (checking, up to date, downloading, ready to restart, failed with the error). Its button becomes "Restart to update" once bytes are cached; otherwise it runs a check and download on demand.

Builder's call recorded: "overlay window hidden" is the busy test. The overlay holds its loading and verifying state in React and hides on close, so a hidden overlay means no parse the user is waiting on. No new frontend-to-Rust busy flag.
Amended 2026-11-04 after review: any visible app window (overlay, Settings, update window) counts as busy.

### Mechanism (Rust-owned)

- One managed `UpdaterState` in `src-tauri/src/lib.rs`: `Idle | Checking | UpToDate | Downloading { version } | Ready { version, bytes } | Failed { message }`, plus the `Update` handle needed for `install`.
- One background task spawned in setup: sleep the launch delay, run the check-and-download step, then loop on the periodic interval. The step is a pure decision function `next_action(trigger, state, overlay_visible)` returning what to do, so it can be unit-tested without Tauri.
- The updater is built with `app.updater_builder().on_before_exit(...)`. The hook stops the Node sidecar (`stop_time_parser_service`) synchronously before the plugin calls `process::exit`. `Drop` never runs on `process::exit`, which is why this hook exists. Builder's call: the local SLM Docker container is not stopped in the hook. It holds no file in the install directory, stopping it can take up to 60 seconds, and the new version reusing a running model server is harmless.
- Install failure after exit (builder's call, from the reviewer's question). Once the app hands off to `msiexec` and exits it cannot see the result: a declined UAC prompt, a standard user who cannot elevate, or a locked file leaves the app closed and the old version installed. To keep "never block the app" true, the app writes `update_install_attempted = { version, at }` to the Tauri store right before handing off. On the next launch, if the running version is still older than the attempted one, `next_action` never auto-installs that version again: it falls back to the tray item, and the update window shows "0.1.7 could not be installed last time; restart to try again". Each install attempt, manual or automatic, overwrites the marker; it is cleared at launch once the running version is at or above the attempted one. (Amended 2026-11-04 during implementation: a manual click no longer clears it, so a failed manual attempt also keeps auto-install blocked.) This is the only updater state on disk; the MSI bytes stay in memory.
- Sidecar adoption guard. `start_time_parser_service` returns early whenever something healthy answers on the parser port, so a new version would adopt a sidecar left behind by an old one (which happens on the first hop from v0.1.5/v0.1.6, whose updater has no pre-exit hook). The sidecar's `/health` response gains the sidecar's own version; at startup, a healthy sidecar reporting a different version than the app is killed and respawned. This also covers any future orphan.
- `restart_after_install` keeps its default (true): the MSI relaunches the app. The old process has already exited, so the single-instance guard does not fire.
- The tray menu gets a `restart_to_update` item, created hidden/disabled and updated through its handle when state reaches `Ready`.
- Cached bytes live in memory only. If the app quits without installing, the next launch re-checks and re-downloads (about 80 MB). ponytail: cache to disk only if users on metered links complain.
- Existing commands `check_for_updates` and `install_update` are reworked onto the shared state (`get_update_status`, `check_for_updates_now`, `install_update_now`). `UpdateChecker.tsx` reads version through `@tauri-apps/api/app` `getVersion()` (already permitted by `core:default`).
- `tauri.conf.json`: set `plugins.updater.windows.installMode` to `"passive"` explicitly and drop the v1 keys `active` and `dialog`.

### Release pipeline

- Manifest source stays GitHub Releases `latest.json`, written by `release.yml` as today. `local-slm-runtime-*` pre-releases must never be marked Latest; the doc says so.
- Side fix in the same PR: the `HOSTED_SLM_API_KEY` fail-fast guard runs only on `refs/tags/*`, so a `workflow_dispatch` release (how v0.1.6 was actually built) skips it. The guard runs on both paths.
- Version files on `main` lag the latest tag (0.1.5 vs 0.1.6) because CI rewrites them at build time. Not changed here; the running app reports its compiled version, which is correct.

### Key custody, rotation, rollback

Written to `docs/UPDATER.md`:

- The updater private key and its password live only in GitHub Actions secrets and must never be committed. Custody outside GitHub is unverified: before the next release BASIC checks his password manager and `~/.tauri` on his machine and records where the key lives. The key must be held by BASIC personally; no shared location.
- Rotation (also the recovery path if the offline copy is missing): generate a new keypair with `tauri signer generate`, store it, put the new public key in `tauri.conf.json`, ship one transition release still signed by CI with the old secret, then replace the secret. Clients that skipped the transition release cannot update past it and reinstall by hand; the doc says so.
- Rollback: tag the last good commit as a higher version and release it. The plugin refuses downgrades, and that is kept; a custom comparator that allows downgrades reopens the attack `require_signed_version` exists to block.
- `require_signed_version` stays off for now because older releases were signed without the version comment; turning it on means re-signing everything users can still update from. Noted as a later hardening step.

## Verification

- Rust unit tests for `next_action` and for the state transitions (launch with overlay hidden installs, launch with overlay visible defers, periodic never auto-installs, a previously attempted version never auto-installs again, failure never blocks).
- `cargo fmt`, `cargo clippy -D warnings`, `cargo test`, frontend build, as `build.yml` runs them.
- Installed-MSI smoke, run once by the builder on the Windows machine and recorded in the PR, modelled on `scripts/verify-installed-routing-smoke.ps1`:
  1. Generate a throwaway minisign keypair.
  2. Build two MSIs with a smoke config overlay (`src-tauri/tauri.updater-smoke.conf.json`: its own product name and identifier, the throwaway public key, an endpoint on `http://127.0.0.1:<port>/latest.json`) at versions 0.0.1 and 0.0.2, signed with the throwaway key.
  3. Serve `latest.json` for 0.0.2 from a local static server, install 0.0.1, launch it, and observe: check, download, install, relaunch as 0.0.2, sidecar from 0.0.2 (not an orphan), no leftover `node.exe` from 0.0.1.
  4. Repeat with the overlay open to show the tray item path.
  5. Old-client hop: build the 0.0.1 MSI from the commit before this change (the old updater code, no pre-exit hook, manual "Install Update" button) and update it to the new 0.0.2 build. Record whether the MSI completed in passive mode with the old sidecar still running, and that the new build killed and respawned the sidecar rather than adopting it. This leg stands in for real v0.1.5/v0.1.6 installs, which cannot be driven locally because their manifest must be signed with the CI-only key.
  The plugin only warns on an `http` endpoint, so no insecure-transport flag is needed. The script and config are committed so the next updater change can rerun it. The smoke build gets its own compiled parser port and instance ID the way the `routing-smoke` feature does.

## Left to the builder

- Launch delay and periodic interval values (suggested 90 seconds and 6 hours).
- Tray item wording and exact update-window layout within the existing settings styling.
- How the background task observes overlay visibility (window handle `is_visible`).
- Whether to keep the `updater/latest.json` placeholder in the repo; it is only the path CI overwrites.
- Replacing the stale claims in `docs/PRODUCTION_DEPLOYMENT.md` and `docs/PROGRESS.md` with a pointer to `docs/UPDATER.md`.
