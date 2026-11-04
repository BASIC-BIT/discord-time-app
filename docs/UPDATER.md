# Auto-updater runbook

HammerOverlay updates itself from GitHub Releases with the Tauri 2 updater plugin. This page is for the owner (BASIC) and for agents changing the updater or cutting a release. Code: `src-tauri/src/updater.rs`, the tray menu and sidecar startup in `src-tauri/src/lib.rs`, config in `src-tauri/tauri.conf.json` under `plugins.updater`, pipeline in `.github/workflows/release.yml`. Design record: `docs/superpowers/specs/2026-11-04-auto-updater-design.md`.

## 1. How it works

The updater is silent and never interrupts the user mid-task.

- 90 seconds after launch (`LAUNCH_DELAY`; 5 seconds in builds with the `updater-smoke` feature) the app checks the manifest, then checks again every 6 hours (`PERIODIC_INTERVAL`) while it runs in the tray.
- When a newer version exists it downloads the MSI and verifies its signature against `plugins.updater.pubkey`, without telling the user. The manifest check times out after 60 seconds. The download fails only if it cannot connect within 30 seconds, receives nothing for 120 seconds, or runs past 2 hours (about 11 KB/s for 80 MB); a failed download starts again from zero on the next check.
- Launch check only: if every app window (overlay, Settings, update window) is hidden and no earlier install attempt of that version is recorded, it installs right away. The app exits, the MSI runs in passive mode (progress bar, one UAC prompt), and the installer relaunches the app. Autostart at login counts as a launch.
- Otherwise (any app window visible, or the update was found by a periodic check or by "Check for Updates") the tray gains "Restart to update X.Y.Z". Periodic and manual checks never install on their own.
- The "Check for Updates" window shows the installed version and the updater state (checking, up to date, downloading, ready, failed with the error). It refreshes every 10 seconds while open (every 2 while checking or downloading). Its button reads "Restart to update" once an update is downloaded; otherwise it checks and downloads on demand.
- Right before handing off to the installer the app writes `install_attempted` = `{version, at}` to the Tauri store file `updater.json`. The app cannot see the installer's result, so if the next launch is still on the older version (UAC declined, no admin rights, locked file), it will not auto-install that version again: it offers the tray item, and the update window says `X.Y.Z could not be installed last time; restart to try again.` The marker is cleared once the running version reaches the attempted one.
- Downloaded MSI bytes stay in memory only. Quitting without installing means the next launch downloads the update again (about 80 MB).
- A pre-exit hook stops the Node parser sidecar before the installer runs; in release builds it also kills an adopted sidecar (one this app found running at startup), which has no supervised child. As a backstop, at startup a release build kills and respawns a healthy sidecar whose `/health` reports a missing or different `appVersion` (this covers the first hop from v0.1.5/v0.1.6, which have no hook). Debug builds adopt it with a warning instead, so `tauri dev` never kills an installed release's sidecar.
- In release builds, a process on the parser port that answers `/health` as healthy without an `appVersion` (for example a developer's hand-run `api` dev server) is killed and respawned at startup.
- v0.1.5 and v0.1.6 have no background check: an install on either must open "Check for Updates" and press "Install Update" once. Every later version updates itself.
- Checks keep running while an update is downloaded and waiting. If the manifest still offers the same version, the held download is kept; a newer version replaces it; no update at all drops the held download and the tray item; a failed check or download keeps both. So a client that already downloaded a pulled release stops offering it at its next check: within 6 hours, or about 90 seconds after a restart (held downloads live in memory, so a restart drops them anyway). While an update is ready the update window's button is "Restart to update", so it cannot trigger an extra check.

## 2. Manifest

Every client reads `https://github.com/BASIC-BIT/discord-time-app/releases/latest/download/latest.json`, which GitHub resolves to the release marked Latest.

`release.yml` builds the MSI with the updater signing key, re-signs it for the updater after Windows code signing (when a certificate is configured), writes `updater/latest.json` (version, notes, date, and the `windows-x86_64` signature and MSI download URL), and runs `gh release create ... --latest` uploading the MSI, the `.msi.sig` and `latest.json`. Nobody edits `latest.json` by hand; the copy in the repo is a placeholder CI overwrites.

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

`scripts/verify-installed-updater-smoke.ps1` proves the updater on real installed MSIs. It builds two smoke MSIs (0.0.1 and 0.0.2) with a throwaway signing key and its own product name, serves `latest.json` from `127.0.0.1`, and runs three legs: `auto` (launch with the overlay hidden installs and relaunches as 0.0.2 with a fresh sidecar), `tray` (overlay open, the tray item path), and `oldhop` (a 0.0.1 built from the pre-updater code updates to the new build, and the new build replaces the old sidecar instead of adopting it). A fourth leg, `click`, needs an operator to click "Restart to update 0.0.2" in the tray within 180 seconds; `-Leg all` never includes it, so run it as `-Leg click`. Run the script from a normal (non-elevated) PowerShell: it builds the MSIs unelevated, then relaunches itself elevated for the installs with exactly one UAC prompt. It refuses an elevated shell unless `-SkipBuild` is given. Because the app inherits that elevated token, the reports record `appRanElevated`: the UAC prompt a user sees on the app's own installer is not exercised.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-installed-updater-smoke.ps1 -Leg all
```

`AGENTS.md` requires installed-MSI smoke evidence for updater, installer and runtime changes and for every Windows release; for the updater, this script's output is that evidence. Record it in the PR.
