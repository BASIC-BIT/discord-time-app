# Auto-updater runbook

HammerOverlay updates itself from GitHub Releases with the Tauri 2 updater plugin. This page is for the owner (BASIC) and for agents changing the updater or cutting a release. Code: `src-tauri/src/updater.rs`, the tray menu and sidecar startup in `src-tauri/src/lib.rs`, config in `src-tauri/tauri.conf.json` under `plugins.updater`, pipeline in `.github/workflows/release.yml`. Design record: `docs/superpowers/specs/2026-11-04-auto-updater-design.md`.

## 1. How it works

The updater is silent and never interrupts the user mid-task.

- 90 seconds after launch (`LAUNCH_DELAY`; 5 seconds in builds with the `updater-smoke` feature) the app checks the manifest, then checks again every 6 hours (`PERIODIC_INTERVAL`) while it runs in the tray.
- When a newer version exists it downloads the MSI and verifies its signature against `plugins.updater.pubkey`, without telling the user. The manifest check times out after 60 seconds. The download fails only if it cannot connect within 30 seconds, receives nothing for 120 seconds, or runs past 2 hours (about 11 KB/s for 80 MB); a failed download starts again from zero on the next check.
- Launch check only: if the app is not busy (busy means any visible app window, or a Local SLM download or install in progress) and no earlier install attempt of that version is recorded, it installs right away. The app exits, the MSI runs in passive mode (progress bar, one UAC prompt), and the installer relaunches the app. Autostart at login counts as a launch.
- Before every hand-off to the installer (the launch-path auto-install, the tray item, and the update window's button) the app starts a hidden PowerShell watchdog. It first waits for the app to exit, then up to 60 seconds for the installer (`msiexec` in the user's session) or the UAC prompt to appear (a slow start on a loaded machine is not taken for a finished install; if neither appears, the hand-off never started), then for them to finish (at most 15 minutes in all), then starts the installed exe with `--minimized` unless a process from that exe path is already running. That last check looks only at HammerOverlay, never at other installers, so an unrelated winget or Office install spanning the cap cannot leave the app closed; if our own install is still running past 15 minutes, the relaunch may start the previous version and Windows Installer's Restart Manager will close it. The single-instance guard makes a redundant start a no-op. If the install never hands off (the app keeps running), the app stops the watchdog. So if the user declines the UAC prompt or the installer fails, the watchdog relaunches the previous version within about 15 minutes; until then HammerOverlay is not running. The attempt marker below prevents a repeat auto-install of that version.
- Otherwise (the app is busy, or the update was found by a periodic check or by "Check for Updates") the tray gains "Restart to update X.Y.Z". Periodic and manual checks never install on their own. If clicking the tray item cannot start the install, a Windows notification gives the reason; a second click while the hand-off is under way is refused with "The update is already installing."
- The "Check for Updates" window shows the installed version and the updater state (checking, up to date, downloading, ready, failed with the error). It refreshes every 10 seconds while open (every 2 while checking or downloading). Its button reads "Restart to update" once an update is downloaded; otherwise it checks and downloads on demand.
- Right before handing off to the installer the app writes `install_attempted` = `{version, at}` to the Tauri store file `updater.json`. The app cannot see the installer's result, so if the next launch is still on the older version (UAC declined, no admin rights, locked file), it will not auto-install that version again: it offers the tray item, and the update window says `X.Y.Z could not be installed last time; restart to try again.` The marker is cleared once the running version reaches the attempted one. If the marker cannot be written, the launch path does not install (the marker is its loop guard), while a click on the tray item or the update window installs anyway with a logged warning. If the store fails to open, `updater.json` is moved aside to `updater.json.corrupt` and a fresh one is created.
- Debug builds (`tauri dev`) never update: the background loop does not start and installing is refused, unless built with the `updater-smoke` feature. "Check for Updates" still checks and downloads, so the window can be exercised. To test updating, use the smoke script (section 7).
- Downloaded MSI bytes stay in memory only. Quitting without installing means the next launch downloads the update again (about 80 MB).
- A pre-exit hook stops the Node parser sidecar before the installer runs; in release builds it also kills an adopted sidecar (one this app found running at startup), which has no supervised child. As a backstop, at startup a release build kills and respawns a healthy sidecar whose `/health` reports a missing or different `appVersion` (this covers the first hop from v0.1.5/v0.1.6, which have no hook). Debug builds adopt it with a warning instead, so `tauri dev` never kills an installed release's sidecar. Only that startup check may kill: a later on-demand start (a parse request, the parser config query, a parser restart) adopts a mismatched sidecar with a warning, so a user's request never waits on the kill.
- In release builds, a process on the parser port that answers `/health` as healthy without an `appVersion` (for example a developer's hand-run `api` dev server) is killed and respawned at startup.
- v0.1.5 and v0.1.6 have no background check: an install on either must open "Check for Updates" and press "Install Update" once. Every later version updates itself.
- Checks keep running while an update is downloaded and waiting. If the manifest still offers the same version, the held download is kept; a newer version replaces it (while it downloads, the tray item reads "Downloading X.Y.Z…" and is disabled); no update at all drops the held download and the tray item; a failed check or download keeps both. So a client that already downloaded a pulled release stops offering it at its next check: within 6 hours, or about 90 seconds after a restart (held downloads live in memory, so a restart drops them anyway). In the Ready phase the update window's button is "Restart to update", so it cannot trigger an extra check. Known limitation from PR #29's review: during a background manifest check the window temporarily shows a disabled check button even when the cached update is still held. The tray restart remains available, and the check is bounded at 60 seconds. This is deferred for follow-up with the #30 hardening work.

## 2. Manifest

Every client reads `https://github.com/BASIC-BIT/discord-time-app/releases/latest/download/latest.json`, which GitHub resolves to the release marked Latest.

`release.yml` builds the MSI with the updater signing key, re-signs it for the updater after Windows code signing (when a certificate is configured), writes `updater/latest.json` (version, notes, date, and the `windows-x86_64` signature and MSI download URL), and runs `gh release create ... --draft` uploading the MSI, the `.msi.sig` and `latest.json`. Nobody edits `latest.json` by hand; the copy in the repo is a placeholder CI overwrites.

Open the draft URL from the workflow summary. With an authenticated GitHub CLI, download its signed MSI with `gh release download <tag> --pattern "*.msi"`. Install and launch that exact MSI on a separate Windows test machine or VM before publishing, checking the app and its parser. The isolated updater harness uses its own MSIs; test the real public update separately after publication. Once the installed smoke passes, publish the draft and mark it Latest with `gh release edit <tag> --draft=false --latest`. Verify that the public manifest serves the new version and an older installed client can update. If smoke fails, keep the release private. Inspect and remove only the rejected draft before re-running the build. If the tag already points to a different commit, use a new version.

The release workflow fails fast if the `HOSTED_SLM_API_KEY` secret is empty, for tag pushes and `workflow_dispatch` runs alike.

`local-slm-runtime-*` pre-releases must never be marked Latest. They carry no `latest.json`, so while one is Latest every installed client's update check fails.

## 3. Key custody

The updater private key and its password live only in the GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. They are never committed to the repo. The public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.

GitHub secrets cannot be read back, so an offline copy is needed for recovery. BASIC holds it personally (password manager, or `~/.tauri` on his machine); no shared location. Before the next release, BASIC checks where it is and records the date here:

- [ ] Custody outside GitHub verified on: ____

## 4. Rotation

Use this to replace the key, and as the recovery path when the offline copy is missing (CI can still sign with the secret even though nobody can read it).

1. Generate a new keypair: `npm run tauri signer generate -- -w <path>`. Store the new private key and password offline as in section 3.
2. Put the contents of the new `.pub` file in `src-tauri/tauri.conf.json` `plugins.updater.pubkey` and merge.
3. Ship one transition release with that change, still signed by CI with the old secrets. Existing installs verify it with the old key and come out trusting the new one.
4. Only then replace both `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the new values. Every later release is signed with the new key.

Installs that skipped the transition release cannot verify anything signed with the new key; they must download and install the MSI by hand. If both the GitHub secret and the offline copy are lost, there is no transition release possible and every install must reinstall by hand.

## 5. Rollback

Tag the last good commit with a version higher than the bad one and release it (bad 0.1.8 means tag the good commit `v0.1.9`). The plugin refuses downgrades by design, so re-marking an older release as Latest does nothing for clients already on the bad version. Do not add a custom version comparator that allows downgrades: it reopens the replay attack `require_signed_version` exists to block.

## 6. Later hardening

`require_signed_version` is off because older releases were signed without the version comment. Turn it on once every release users can still update from has been re-signed.

## 7. Smoke test

`scripts/verify-installed-updater-smoke.ps1` exercises real installed MSIs, signed with a throwaway key under the separate product name `HammerOverlay Updater Smoke`, parser port 8858 and its own instance ID. It serves the update manifest on loopback. `-Leg all` runs four unattended legs: `auto` (launch install and relaunch, including an unreachable endpoint), `tray` (visible-window deferral, followed by install on the next plain launch), `oldhop` (upgrade from the pre-updater code with an orphaned sidecar), and `kill` (replace an installed sidecar reporting the wrong version). The separate `click` leg requires clicking the real tray menu's "Restart to update 0.0.2" item within 180 seconds of its prompt. A log line saying the item is ready does not prove the click works.

Run from a normal PowerShell window opened independently of an agent host. Keep it open through cleanup. Builds run unelevated; the script requests one UAC approval for the per-machine installs. The app inherits that elevated token, so `appRanElevated` and the measured app/sidecar integrity must be disclosed. This does not exercise the app installer's own UAC prompt or declining it.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-installed-updater-smoke.ps1 -Leg all
```

`AGENTS.md` requires installed-MSI smoke evidence for updater, installer and runtime changes and for every Windows release; for the updater, this script's output is that evidence. Record it in the PR.

For a frozen application build with a newer runner, copy the retained artifacts into a fresh `WorkDir`, choose a fresh `Output`, and use `-SkipBuild -KeepArtifacts -ApplicationCommit <exact-application-commit>`. The runner checks the artifact stamp and application paths separately from runner provenance. Do not use `-AllowStaleArtifacts` to qualify the gate. Existing exit-1618 retries are part of the run; the first failed leg stops the sequence. Preserve that attempt before investigating or starting another.

Check the finalized JSON's `status`, `incomplete`, `stage`, errors and real-app isolation, not only its individual checks. Before/after-final-check and before-cleanup snapshots survive an interrupted cleanup. Profile log candidates stay separate from actual process-open `.log` paths. Native x64 Windows metadata capture records errors/UNKNOWN explicitly; inspect capture completeness separately from the smoke status. A regular-file stderr destination can be snapshotted; absent, pipe and console destinations are reported without consuming them. Initial-launch stderr redirection is instrumentation and can affect inherited handles, so a pass does not establish why an earlier uninstrumented run failed.

Current acceptance and review dispositions for PR #29 are in [the November 13 evidence record](handoffs/2026-11-13-updater-acceptance.md).
