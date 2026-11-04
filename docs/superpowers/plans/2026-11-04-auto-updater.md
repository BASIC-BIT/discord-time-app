# Auto-updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HammerOverlay checks GitHub Releases on its own, downloads and verifies the signed MSI in the background, and installs it on the next launch or when the user clicks "Restart to update" in the tray.

**Architecture:** A new Rust module `src-tauri/src/updater.rs` owns the updater state machine, the background check loop, the install hand-off and the three Tauri commands; `lib.rs` only wires it in (managed state, tray item, commands, setup). The sidecar gets a version echo on `/health` so a new app version never adopts an orphaned old sidecar. A committed PowerShell smoke script proves the path on real installed MSIs with a throwaway signing key.

**Tech Stack:** Tauri 2 (Rust), `tauri-plugin-updater` 2 (Rust API only; no JS updater or process plugin), `tauri-plugin-store` for one marker, React/TypeScript update window, Fastify sidecar, PowerShell smoke script, GitHub Actions release workflow.

**Spec:** `docs/superpowers/specs/2026-11-04-auto-updater-design.md`

## Global Constraints

- Windows MSI, per-machine install, `plugins.updater.windows.installMode` = `"passive"`; `restart_after_install` stays at its default `true`.
- Launch delay before the first check: 90 seconds. Periodic interval: 6 hours. Under the `updater-smoke` Cargo feature the launch delay is 5 seconds.
- Only the launch-triggered check may auto-install, and only when the overlay window is hidden and no prior install attempt for that version is recorded. Periodic and manual checks only offer "Restart to update".
- The pre-exit hook stops the Node sidecar only, never the local SLM container.
- The only updater state on disk is the store `updater.json` key `install_attempted` = `{ "version": "X.Y.Z", "at": "<RFC 3339>" }`. MSI bytes stay in memory.
- No new runtime dependencies (no `tokio` direct dep, no `@tauri-apps/plugin-updater`, no `@tauri-apps/plugin-process`). Background work uses a `std::thread` plus `tauri::async_runtime::block_on`.
- Tray copy: `Restart to update X.Y.Z`. Update window copy for a failed prior attempt: `X.Y.Z could not be installed last time; restart to try again.`
- `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test` and `npm run build` must pass, as `build.yml` runs them (from `src-tauri/` for the cargo commands).
- Commit messages carry no Claude Code signature; end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Smoke builds use `--features routing-smoke,updater-smoke` on new code and `--features routing-smoke` on old code, so they run on parser port 8858 and instance id `hammer-overlay-routing-smoke`, never colliding with the real install on 8857.

## Review Focus

1. No network at launch: the check fails, the phase becomes `Failed`, the app keeps working, and the next periodic tick retries. Test in Task 3 (`run_update_cycle` with an unreachable endpoint leaves `Failed` and does not panic).
2. The manifest advertises the current or an older version: the plugin returns `None`, phase `UpToDate`, nothing downloaded. Covered by the plugin; the status mapping is tested in Task 2.
3. A tampered MSI: `download` verifies the minisign signature and fails; phase `Failed { message }` and no install. Covered by the plugin; the error path mapping is tested in Task 2 (`status_from_phase`).
4. "Restart to update" clicked while a download is still running: `install_update_now` returns `Err("Update is still downloading")` and the phase is unchanged. Test in Task 3.
5. The attempt marker outlives a successful install (the app now runs the attempted version or newer): the marker is cleared at launch so a future version can auto-install. Test in Task 2 (`attempt_is_stale`).

---

### Task 1: Sidecar version echo and adoption guard

**Files:**
- Modify: `api/src/index.ts` (the `server.get('/health', ...)` handler)
- Modify: `src-tauri/src/lib.rs` (`start_time_parser_service`, `time_parser_health_check`, the sidecar `Command` env block)
- Test: `src-tauri/src/lib.rs` (new `#[cfg(test)] mod sidecar_adoption_tests`)

**Interfaces:**
- Produces: `pub(crate) fn stop_time_parser_service(app: &AppHandle) -> Result<(), String>` (existing, visibility widened for Task 3); `enum SidecarAction { Spawn, Adopt, KillThenSpawn }`; `fn sidecar_action(health_app_version: Option<&str>, app_version: &str) -> SidecarAction`; `fn time_parser_health_app_version() -> Option<String>` (None when unhealthy, `Some("")` when healthy but no version, `Some(v)` otherwise); `fn kill_time_parser_listener()`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod sidecar_adoption_tests {
    use super::*;

    #[test]
    fn unhealthy_port_spawns() {
        assert!(matches!(sidecar_action(None, "0.1.7"), SidecarAction::Spawn));
    }

    #[test]
    fn same_version_is_adopted() {
        assert!(matches!(sidecar_action(Some("0.1.7"), "0.1.7"), SidecarAction::Adopt));
    }

    #[test]
    fn old_sidecar_without_version_is_killed() {
        assert!(matches!(sidecar_action(Some(""), "0.1.7"), SidecarAction::KillThenSpawn));
    }

    #[test]
    fn different_version_is_killed() {
        assert!(matches!(sidecar_action(Some("0.1.6"), "0.1.7"), SidecarAction::KillThenSpawn));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri/`): `cargo test sidecar_adoption_tests`
Expected: compile error, `sidecar_action` not found.

- [ ] **Step 3: Implement the Rust side**

In `lib.rs`:
- Add `enum SidecarAction` and `fn sidecar_action(...)` as pure logic.
- Add `fn time_parser_health_app_version() -> Option<String>`: same TCP request as `time_parser_health_check` but read the whole response until EOF, require a 200 status line, parse the body after the blank line as JSON and return `appVersion` as a string (`""` when absent or not a string).
- Add `fn kill_time_parser_listener()`: on Windows, run `powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection -LocalPort <TIME_PARSER_PORT> -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"` with `CREATE_NO_WINDOW`, then poll `time_parser_health_check()` until false for up to 5 seconds. On non-Windows, a no-op with a warn log.
- In `start_time_parser_service`, replace the `if time_parser_health_check() { ...; return; }` early return with a match on `sidecar_action(time_parser_health_app_version().as_deref(), env!("CARGO_PKG_VERSION"))`: `Adopt` logs and returns, `KillThenSpawn` logs the mismatch, calls `kill_time_parser_listener()` and falls through, `Spawn` falls through.
- In the sidecar `Command` env block, add `.env("HAMMER_APP_VERSION", env!("CARGO_PKG_VERSION"))`.
- Change `fn stop_time_parser_service` to `pub(crate) fn`.

- [ ] **Step 4: Implement the sidecar side**

In `api/src/index.ts` `/health` handler, add `appVersion: process.env.HAMMER_APP_VERSION ?? null` to the reply object.

- [ ] **Step 5: Run the tests and the API build**

Run (from `src-tauri/`): `cargo test sidecar_adoption_tests` — Expected: 4 passed.
Run (from repo root): `npm --prefix api run build` — Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add api/src/index.ts src-tauri/src/lib.rs
git commit -m "Refuse to adopt a sidecar from another app version"
```

---

### Task 2: Updater state module with pure decision logic

**Files:**
- Create: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod updater;` and `.manage(updater::UpdaterState::default())`)
- Test: `src-tauri/src/updater.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces:
  - `pub enum Phase { Idle, Checking, UpToDate, Downloading { version: String }, Ready { version: String }, Installing { version: String }, Failed { message: String } }`
  - `pub struct ReadyUpdate { pub update: tauri_plugin_updater::Update, pub bytes: Vec<u8> }`
  - `#[derive(Default)] pub struct UpdaterState { pub phase: Mutex<Phase>, pub ready: Mutex<Option<ReadyUpdate>> }` (`Phase::default()` is `Idle`)
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct UpdateStatus { pub current_version: String, pub phase: String, pub available_version: Option<String>, pub message: Option<String>, pub previous_attempt_failed: bool }` where `phase` is one of `"idle" | "checking" | "upToDate" | "downloading" | "ready" | "installing" | "failed"`.
  - `pub enum Trigger { Launch, Periodic, Manual }`
  - `pub enum ReadyAction { Install, OfferRestart }`
  - `pub fn next_action(trigger: Trigger, overlay_visible: bool, attempted_version: Option<&str>, version: &str) -> ReadyAction`
  - `pub fn attempt_is_stale(attempted_version: &str, current_version: &str) -> bool` (true when current >= attempted by semver)
  - `pub fn status_from_phase(phase: &Phase, current_version: &str, previous_attempt_failed: bool) -> UpdateStatus` (`message` is the `Failed` message, or the Global Constraints copy when `previous_attempt_failed` and phase is not `Failed`)
  - `pub fn read_install_attempt(app: &AppHandle) -> Option<String>`, `pub fn record_install_attempt(app: &AppHandle, version: &str) -> Result<(), String>`, `pub fn clear_install_attempt(app: &AppHandle)` over store `updater.json`, key `install_attempted`, using the same `StoreBuilder::new(app, ...)` pattern as `save_app_settings`.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_with_hidden_overlay_installs() {
        assert!(matches!(next_action(Trigger::Launch, false, None, "0.1.7"), ReadyAction::Install));
    }

    #[test]
    fn launch_with_visible_overlay_defers() {
        assert!(matches!(next_action(Trigger::Launch, true, None, "0.1.7"), ReadyAction::OfferRestart));
    }

    #[test]
    fn launch_after_failed_attempt_defers() {
        assert!(matches!(next_action(Trigger::Launch, false, Some("0.1.7"), "0.1.7"), ReadyAction::OfferRestart));
    }

    #[test]
    fn launch_after_attempt_of_other_version_installs() {
        assert!(matches!(next_action(Trigger::Launch, false, Some("0.1.6"), "0.1.7"), ReadyAction::Install));
    }

    #[test]
    fn periodic_and_manual_never_install() {
        assert!(matches!(next_action(Trigger::Periodic, false, None, "0.1.7"), ReadyAction::OfferRestart));
        assert!(matches!(next_action(Trigger::Manual, false, None, "0.1.7"), ReadyAction::OfferRestart));
    }

    #[test]
    fn attempt_marker_is_stale_once_installed() {
        assert!(attempt_is_stale("0.1.7", "0.1.7"));
        assert!(attempt_is_stale("0.1.7", "0.1.8"));
        assert!(!attempt_is_stale("0.1.7", "0.1.6"));
        assert!(!attempt_is_stale("garbage", "0.1.6"));
    }

    #[test]
    fn failed_phase_reports_message() {
        let status = status_from_phase(&Phase::Failed { message: "boom".into() }, "0.1.6", false);
        assert_eq!(status.phase, "failed");
        assert_eq!(status.message.as_deref(), Some("boom"));
        assert_eq!(status.available_version, None);
    }

    #[ignore]
    #[test]
    fn ready_phase_reports_version_and_prior_failure() {
        let status = status_from_phase(&Phase::Ready { version: "0.1.7".into() }, "0.1.6", true);
        assert_eq!(status.phase, "ready");
        assert_eq!(status.available_version.as_deref(), Some("0.1.7"));
        assert_eq!(status.message.as_deref(), Some("0.1.7 could not be installed last time; restart to try again."));
    }
}
```

Remove the `#[ignore]` on the last test; it is listed only so the expected copy is visible.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri/`): `cargo test updater::tests`
Expected: compile error, module `updater` not found.

- [ ] **Step 3: Implement `updater.rs`**

Semver comparison: parse `"MAJOR.MINOR.PATCH"` with `str::split('.')` into `(u64, u64, u64)`; any parse failure makes `attempt_is_stale` return false. No semver crate.

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `src-tauri/`): `cargo test updater::tests` — Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/updater.rs src-tauri/src/lib.rs
git commit -m "Add the updater state machine and install-attempt marker"
```

---

### Task 3: Check loop, install hand-off, tray item and commands

**Files:**
- Modify: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/lib.rs` (`create_system_tray_menu`, `setup_system_tray`, the tray `on_menu_event` match, `invoke_handler`, `.setup`, remove `check_for_updates` and `install_update`)
- Modify: `src-tauri/tauri.conf.json` (`plugins.updater`)
- Modify: `src-tauri/Cargo.toml` (`[features] updater-smoke = []`)
- Test: `src-tauri/src/updater.rs`

**Interfaces:**
- Consumes: Task 1 `crate::stop_time_parser_service`; Task 2 everything.
- Produces:
  - `pub const LAUNCH_DELAY: Duration` (90 s; 5 s under `cfg(feature = "updater-smoke")`), `pub const PERIODIC_INTERVAL: Duration` (6 h).
  - `pub fn spawn_update_loop(app: AppHandle)`: `std::thread::spawn`; sleep `LAUNCH_DELAY`; on launch, if `read_install_attempt` is `Some(v)` and `attempt_is_stale(&v, current)` then `clear_install_attempt`; `block_on(run_update_cycle(&app, Trigger::Launch))`; then loop `{ sleep PERIODIC_INTERVAL; block_on(run_update_cycle(&app, Trigger::Periodic)) }`.
  - `pub async fn run_update_cycle(app: &AppHandle, trigger: Trigger)`: skip (return) when phase is `Downloading`, `Installing` or `Ready`; set `Checking`; build `app.updater_builder().on_before_exit(hook).build()`; `check().await` → `None` sets `UpToDate`; `Some(update)` sets `Downloading { version }`, `update.download(|_, _| {}, || {}).await` → bytes, store `ReadyUpdate`, set `Ready`; then `match next_action(trigger, overlay_visible(app), read_install_attempt(app).as_deref(), &version)`: `Install` → `install_ready_update(app)`, `OfferRestart` → `show_restart_item(app, &version)`. Any error sets `Failed { message }` with the error's `Display` text and logs it; nothing is retried inside the cycle.
  - `pub fn install_ready_update(app: &AppHandle) -> Result<(), String>`: `Err("No update is ready")` when no `ReadyUpdate`; `Err("Update is still downloading")` when phase is `Downloading`; otherwise `record_install_attempt`, set `Installing`, call `ready.update.install(&ready.bytes)`; on `Err(e)` set `Failed { message }` and keep the `ReadyUpdate` so a retry is possible.
  - The pre-exit hook closure: `let app = app.clone(); move || { if let Err(e) = crate::stop_time_parser_service(&app) { log::warn!(...) } }`; it must match the plugin's `on_before_exit` bound exactly as the installed `tauri-plugin-updater` version declares it.
  - `fn overlay_visible(app: &AppHandle) -> bool`: `app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false)`; under `cfg(feature = "updater-smoke")` also true when env `HAMMER_SMOKE_OVERLAY_VISIBLE` is `"1"`.
  - `pub fn show_restart_item(app: &AppHandle, version: &str)`: `crate::create_system_tray_menu(app, Some(version))` then `app.tray_by_id("main").map(|t| t.set_menu(Some(menu)))`; logs `Update {version} ready; restart to update` at info level (the smoke script greps this line).
  - Commands: `#[tauri::command] pub async fn get_update_status(app: AppHandle) -> UpdateStatus`; `pub async fn check_for_updates_now(app: AppHandle) -> UpdateStatus` (runs `run_update_cycle(&app, Trigger::Manual)` then returns the status); `pub async fn install_update_now(app: AppHandle) -> Result<(), String>` (if no `ReadyUpdate`, run a `Manual` cycle first, then `install_ready_update`).
  - `lib.rs`: `fn create_system_tray_menu(app: &AppHandle, restart_version: Option<&str>) -> Result<Menu<Wry>, tauri::Error>` inserts a `restart_to_update` item with text `Restart to update {version}` before `check_updates` when `Some`; `TrayIconBuilder::with_id("main")`; new match arm `"restart_to_update"` → `updater::install_ready_update(app)` logging any error; `.setup` calls `updater::spawn_update_loop(app.handle().clone())` after `start_time_parser_service`; `invoke_handler` registers the three new commands and drops the two old ones.
  - `tauri.conf.json` `plugins.updater`: remove `active` and `dialog`, add `"windows": { "installMode": "passive" }`.

- [ ] **Step 1: Write the failing tests**

Write these in `updater.rs` `mod tests`, using `tauri::test::mock_app()` (add `tauri = { ..., features = ["tray-icon", "test"] }` under `[dev-dependencies]` only if the `test` feature is not already reachable; otherwise reuse the main dependency):

```rust
#[test]
fn install_while_downloading_is_refused() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    handle.manage(UpdaterState::default());
    *handle.state::<UpdaterState>().phase.lock().unwrap() = Phase::Downloading { version: "0.1.7".into() };
    assert_eq!(install_ready_update(&handle), Err("Update is still downloading".to_string()));
    assert!(matches!(*handle.state::<UpdaterState>().phase.lock().unwrap(), Phase::Downloading { .. }));
}

#[test]
fn install_with_nothing_ready_is_refused() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    handle.manage(UpdaterState::default());
    assert_eq!(install_ready_update(&handle), Err("No update is ready".to_string()));
}

#[test]
fn unreachable_endpoint_leaves_failed_phase() {
    // Build the updater via updater_builder().endpoints(vec!["http://127.0.0.1:9/latest.json"])
    // inside run_update_cycle when cfg(test) env HAMMER_TEST_UPDATER_ENDPOINT is set.
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    handle.manage(UpdaterState::default());
    std::env::set_var("HAMMER_TEST_UPDATER_ENDPOINT", "http://127.0.0.1:9/latest.json");
    tauri::async_runtime::block_on(run_update_cycle(&handle, Trigger::Periodic));
    assert!(matches!(*handle.state::<UpdaterState>().phase.lock().unwrap(), Phase::Failed { .. }));
}
```

If `mock_app()` cannot register the updater plugin in tests, keep the first two tests (they need no plugin) and turn the third into a smoke-script assertion (Task 6 leg 1 with the manifest server stopped); note which in the commit message.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri/`): `cargo test updater::tests` — Expected: compile errors for the missing functions.

- [ ] **Step 3: Implement everything in the Interfaces block**

The `HAMMER_TEST_UPDATER_ENDPOINT` override is `#[cfg(test)]` only.

- [ ] **Step 4: Run the full Rust gate**

Run (from `src-tauri/`): `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test`
Expected: clippy clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "Check for updates in the background and offer Restart to update"
```

---

### Task 4: Update window on the new commands

**Files:**
- Modify: `src/components/UpdateChecker.tsx`
- Test: `npm run build` (no component test harness exists; keep it that way)

**Interfaces:**
- Consumes: Task 3 commands `get_update_status`, `check_for_updates_now`, `install_update_now` and the `UpdateStatus` shape (camelCase).

- [ ] **Step 1: Rewrite the component state**

- `const [status, setStatus] = useState<UpdateStatus | null>(null)` with `interface UpdateStatus { currentVersion: string; phase: 'idle' | 'checking' | 'upToDate' | 'downloading' | 'ready' | 'installing' | 'failed'; availableVersion: string | null; message: string | null; previousAttemptFailed: boolean }`.
- On mount: `invoke<UpdateStatus>('get_update_status')`; poll it every 2 seconds while `phase` is `checking` or `downloading`.
- Replace the hardcoded `0.1.0` with `status.currentVersion`, falling back to `getVersion()` from `@tauri-apps/api/app` before the first status arrives.
- Body text by phase: `idle`/`upToDate` → "You are running the latest version."; `checking` → "Checking…"; `downloading` → "Downloading {availableVersion}…"; `ready` → "{availableVersion} is ready. Restart to update."; `installing` → "Installing…"; `failed` → `message`. When `previousAttemptFailed` and phase is `ready`, show `message` instead of the ready line.
- Footer button: phase `ready` → "Restart to update" calling `install_update_now`; otherwise "Check for Updates" calling `check_for_updates_now` (disabled during `checking`/`downloading`/`installing`). Keep the Close button, the Escape handler and the `useLayoutEffect` resize block unchanged; the resize deps become `[status]`.
- Delete the `success` toast state; errors from `invoke` set `error` as today.

- [ ] **Step 2: Build**

Run: `npm run build` — Expected: exit 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/UpdateChecker.tsx
git commit -m "Show the real version and updater state in the update window"
```

---

### Task 5: Release guard, updater runbook, stale docs

**Files:**
- Modify: `.github/workflows/release.yml` (step "Require the hosted SLM key for tagged releases")
- Create: `docs/UPDATER.md`
- Modify: `docs/PRODUCTION_DEPLOYMENT.md` (section "3. Auto-Updater System" and the `updater/latest.json` lines), `docs/PROGRESS.md` (the two "Auto-Updater System" sections), `CLAUDE.md` ("Testing & Linting" and "Important Files")

- [ ] **Step 1: Fix the guard**

Delete the `if: startsWith(github.ref, 'refs/tags/')` line and rename the step to "Require the hosted SLM key for releases". The step then runs for tag pushes and `workflow_dispatch` alike.

- [ ] **Step 2: Write `docs/UPDATER.md`**

Sections, each a short paragraph or list, no more than 120 lines total:
1. How it works (the spec's "User experience" and "Mechanism" decisions, in present tense, with the 90 s / 6 h values and the store marker).
2. Manifest: `release.yml` writes `latest.json` and uploads it with the MSI and `.msi.sig`; the endpoint is `releases/latest/download/latest.json`; `local-slm-runtime-*` pre-releases must never be marked Latest.
3. Key custody: the private key and password live only in GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, never in the repo; BASIC holds the offline copy personally; a checkbox line "Custody outside GitHub verified on: ____" left blank for BASIC to fill.
4. Rotation (and recovery when the offline copy is missing): `npm run tauri signer generate -- -w <path>`; put the new `.pub` contents in `tauri.conf.json` `plugins.updater.pubkey`; ship one transition release still signed by CI with the old secret; then replace both secrets. Installs that skipped the transition release must reinstall by hand.
5. Rollback: tag the last good commit with a higher version and release it; downgrades are refused by design.
6. Later hardening: `require_signed_version` once every release users can still update from has been re-signed.
7. Smoke: how to run `scripts/verify-installed-updater-smoke.ps1` (from Task 6) and that `AGENTS.md` requires its evidence for updater changes and Windows releases.

- [ ] **Step 3: Fix the stale claims**

In `docs/PRODUCTION_DEPLOYMENT.md` and `docs/PROGRESS.md`, replace each auto-updater feature list with one line: "Auto-updater: see `docs/UPDATER.md`." Delete the "Update `updater/latest.json` with new version" release step (CI writes it). In `CLAUDE.md`, add under "Testing & Linting": "`scripts/verify-installed-updater-smoke.ps1` proves the auto-updater on real installed MSIs; run it for any updater, installer or sidecar lifecycle change." and add `docs/UPDATER.md` to "Important Files".

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml docs/UPDATER.md docs/PRODUCTION_DEPLOYMENT.md docs/PROGRESS.md CLAUDE.md
git commit -m "Document updater custody, rotation and rollback; guard every release build"
```

---

### Task 6: Installed-MSI smoke script and evidence

**Files:**
- Create: `src-tauri/tauri.updater-smoke.conf.json`
- Create: `scripts/verify-installed-updater-smoke.ps1`
- Create: `scripts/updater-smoke-manifest-server.ps1` (only if the listener cannot live as a background job inside the main script)
- Evidence: `api/reports/temporal-ml/updater-smoke-<leg>.json` (ignored directory; paste the summaries into the PR)

**Interfaces:**
- Consumes: Task 3 log line `Update {version} ready; restart to update`, env `HAMMER_SMOKE_OVERLAY_VISIBLE`, feature `updater-smoke`; Task 1 `/health` `appVersion`.

- [ ] **Step 1: Config overlay**

`src-tauri/tauri.updater-smoke.conf.json`:
```json
{
  "productName": "HammerOverlay Updater Smoke",
  "version": "0.0.0",
  "identifier": "com.hammer-overlay.updater-smoke",
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": { "updater": { "endpoints": ["http://127.0.0.1:8859/latest.json"], "pubkey": "REPLACED_BY_SMOKE_SCRIPT" } }
}
```
The script copies it to a temp file with the real version and pubkey filled in before each build.

- [ ] **Step 2: Script parameters and shared steps**

`scripts/verify-installed-updater-smoke.ps1` with `[CmdletBinding()] param([ValidateSet('auto','tray','oldhop','all')][string]$Leg = 'all', [int]$ManifestPort = 8859, [string]$OldCommit = 'main', [string]$Output = '')`, `$ErrorActionPreference = 'Stop'`, and the `Assert-True` / `Assert-Equal` / `Get-JsonResponse` helpers copied from `scripts/verify-installed-routing-smoke.ps1`. It must refuse to run when not elevated (MSI per-machine install) with a clear message.

Shared steps, each a function:
- `New-SmokeKey`: `npx tauri signer generate -w <temp>\smoke.key --ci` with env `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`; returns the key path and the `.pub` contents. Sets `TAURI_SIGNING_PRIVATE_KEY` to the key path for the builds.
- `Build-SmokeMsi -Version <v> -Features <list> -SourceRoot <path>`: writes the filled config to a temp file, runs `npm run build:desktop` then `npx tauri build --config <temp> --features <list>` in `<SourceRoot>`, returns the MSI and `.sig` paths. For `$OldCommit`, `git worktree add <temp>\old <OldCommit>` and build there with `--features routing-smoke`; remove the worktree at the end.
- `Start-ManifestServer -Msi <path> -Sig <path> -Version <v>`: writes `latest.json` (`version`, `pub_date`, `platforms.windows-x86_64.signature` = the `.sig` contents, `url` = `http://127.0.0.1:$ManifestPort/<msi file name>`) and starts a `System.Net.HttpListener` background job serving both files; `Stop-ManifestServer` stops it.
- `Install-SmokeMsi -Msi <path>`: `msiexec /i <msi> /qn`, assert exit code 0.
- `Start-SmokeApp -ExtraEnv @{}`: launches the installed exe (find it under `C:\Program Files\HammerOverlay Updater Smoke\`) with the env merged; `Stop-SmokeApp` stops any process from that path.
- `Get-InstalledVersion`: `(Get-Item <exe>).VersionInfo.ProductVersion`.
- `Get-SidecarHealth`: `Get-JsonResponse http://127.0.0.1:8858/health`.
- `Get-SmokeLog`: the newest file under `$env:LOCALAPPDATA\com.hammer-overlay.updater-smoke\logs\`.
- `Write-Report -Leg <name> -Fields <hashtable>`: JSON to `$Output` or `api/reports/temporal-ml/updater-smoke-<leg>.json`.
- `Remove-SmokeInstall`: `msiexec /x <product code> /qn` for the smoke product, if installed, at start and end.

- [ ] **Step 3: Leg `auto`**

Build 0.0.1 and 0.0.2 from the working tree with `routing-smoke,updater-smoke`; serve 0.0.2; install 0.0.1; start the app; wait up to 240 s for: the original process to exit, a process from the install path to be running again, and `Get-InstalledVersion` = `0.0.2`. Then assert `Get-SidecarHealth().Body.appVersion` = `0.0.2` and exactly one listener on port 8858 (`Get-NetTCPConnection -LocalPort 8858 -State Listen`). Record the elapsed seconds and whether a UAC prompt was needed (the operator answers it; note in the report).

- [ ] **Step 4: Leg `tray`**

Same builds; install 0.0.1; start the app with `HAMMER_SMOKE_OVERLAY_VISIBLE=1`; wait up to 120 s for the log line `Update 0.0.2 ready; restart to update`; assert the process is still running and `Get-InstalledVersion` = `0.0.1` (deferred). Stop the app, start it without the env var, and assert the same outcome as leg `auto` (install on next launch, no attempt marker yet). The tray click itself is a manual check: the operator clicks "Restart to update 0.0.2" once during the build phase and the PR carries a screenshot of the tray item.

- [ ] **Step 5: Leg `oldhop`**

Build 0.0.1 from `$OldCommit` with `routing-smoke` (old updater code) and 0.0.2 from the working tree with `routing-smoke,updater-smoke`; install 0.0.1; start it; wait for its sidecar on 8858 (`appVersion` absent). Then reproduce the old client's install: start `msiexec /i <0.0.2 msi> /passive` and immediately `Stop-SmokeApp` (force, so the old sidecar is orphaned exactly as the old code leaves it). Wait for msiexec to exit; record its exit code (0, or 3010 meaning reboot required; either is recorded, 3010 is reported as a finding). Start the new exe; assert `Get-SidecarHealth().Body.appVersion` = `0.0.2`, exactly one listener on 8858, and no `node.exe` whose `CommandLine` contains the install path other than the new sidecar's.

- [ ] **Step 6: Run all legs and keep the evidence**

Run from an elevated PowerShell: `powershell -ExecutionPolicy Bypass -File scripts\verify-installed-updater-smoke.ps1 -Leg all`
Expected: three reports written, every assertion passed. Fix anything that fails in the owning task's code, rerun, and keep the final reports for the PR body.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.updater-smoke.conf.json scripts/verify-installed-updater-smoke.ps1
git commit -m "Prove the auto-updater on installed MSIs with a throwaway key"
```

---

### Task 7: Final gate and pull request

- [ ] **Step 1: Run every check `build.yml` runs**

From repo root: `npm ci`, `npm --prefix api ci`, `npm --prefix api run build`, `npm --prefix api test`, `npm test`, `npm run build`, `npm run prepare:api-sidecar`. From `src-tauri/`: `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`.
Expected: all exit 0.

- [ ] **Step 2: Push and open the PR**

Title: `Auto-updater: silent check and download, restart to update`. Body: the spec's "User experience" list, the three smoke report summaries (leg, outcome, elapsed, msiexec exit code), the tray screenshot, `Closes #27`, a "Custody check still owed by BASIC before the next release" line, and the footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: Report the packet and wait**

Message the conductor: PR link, head SHA, the ask (merge is BASIC's), and the custody checkbox left for BASIC. Do not merge.
