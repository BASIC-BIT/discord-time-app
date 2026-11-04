use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

#[cfg(not(feature = "updater-smoke"))]
pub const LAUNCH_DELAY: Duration = Duration::from_secs(90);
#[cfg(feature = "updater-smoke")]
pub const LAUNCH_DELAY: Duration = Duration::from_secs(5);
pub const PERIODIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Total bound on the manifest check.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// Applied to the check and the download: no connection within 30 s, or no bytes
/// for 120 s, fails the request. A slow but moving download never trips these.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Last-resort total bound on the download (80 MB needs about 11 KB/s), so a
/// connection that trickles a byte every couple of minutes cannot hold
/// `Downloading` forever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

const STORE_FILE: &str = "updater.json";
const ATTEMPT_KEY: &str = "install_attempted";

#[derive(Debug, Clone, Default)]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
    },
    Ready {
        version: String,
    },
    Installing {
        version: String,
    },
    Failed {
        message: String,
    },
}

/// What the tray shows for updates: nothing, the restart item, or a disabled
/// "Downloading" item while a newer version replaces a held one.
#[derive(Debug, Clone, Copy)]
pub enum TrayUpdateItem<'a> {
    None,
    Ready(&'a str),
    Downloading(&'a str),
}

pub struct ReadyUpdate {
    pub update: tauri_plugin_updater::Update,
    pub bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdaterState {
    pub phase: Mutex<Phase>,
    pub ready: Mutex<Option<ReadyUpdate>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub phase: String,
    pub available_version: Option<String>,
    pub message: Option<String>,
    pub previous_attempt_failed: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum Trigger {
    Launch,
    Periodic,
    Manual,
}

#[derive(Debug, Clone, Copy)]
pub enum ReadyAction {
    Install,
    OfferRestart,
}

/// Auto-install only on launch, with every app window hidden, and never for a
/// version whose install already failed once.
pub fn next_action(
    trigger: Trigger,
    app_window_visible: bool,
    attempted_version: Option<&str>,
    version: &str,
) -> ReadyAction {
    if matches!(trigger, Trigger::Launch)
        && !app_window_visible
        && attempted_version != Some(version)
    {
        ReadyAction::Install
    } else {
        ReadyAction::OfferRestart
    }
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

/// True once the running version has caught up with the attempted one.
pub fn attempt_is_stale(attempted_version: &str, current_version: &str) -> bool {
    match (
        parse_version(attempted_version),
        parse_version(current_version),
    ) {
        (Some(attempted), Some(current)) => current >= attempted,
        _ => false,
    }
}

pub fn status_from_phase(
    phase: &Phase,
    current_version: &str,
    previous_attempt_failed: bool,
) -> UpdateStatus {
    let (name, available_version) = match phase {
        Phase::Idle => ("idle", None),
        Phase::Checking => ("checking", None),
        Phase::UpToDate => ("upToDate", None),
        Phase::Downloading { version } => ("downloading", Some(version.clone())),
        Phase::Ready { version } => ("ready", Some(version.clone())),
        Phase::Installing { version } => ("installing", Some(version.clone())),
        Phase::Failed { .. } => ("failed", None),
    };
    let message = match phase {
        Phase::Failed { message } => Some(message.clone()),
        Phase::Ready { version } if previous_attempt_failed => Some(format!(
            "{version} could not be installed last time; restart to try again."
        )),
        _ => None,
    };
    UpdateStatus {
        current_version: current_version.to_string(),
        phase: name.to_string(),
        available_version,
        message,
        previous_attempt_failed,
    }
}

fn store(app: &AppHandle) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, String> {
    tauri_plugin_store::StoreBuilder::new(app, STORE_FILE)
        .build()
        .map_err(|e| {
            log::error!("Failed to build updater store: {e}");
            e.to_string()
        })
}

pub fn read_install_attempt(app: &AppHandle) -> Option<String> {
    store(app)
        .ok()?
        .get(ATTEMPT_KEY)?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

pub fn record_install_attempt(app: &AppHandle, version: &str) -> Result<(), String> {
    let store = store(app)?;
    store.set(
        ATTEMPT_KEY,
        serde_json::json!({ "version": version, "at": rfc3339_now() }),
    );
    store.save().map_err(|e| {
        log::error!("Failed to save updater store: {e}");
        e.to_string()
    })
}

pub fn clear_install_attempt(app: &AppHandle) {
    let Ok(store) = store(app) else { return };
    store.delete(ATTEMPT_KEY);
    if let Err(e) = store.save() {
        log::warn!("Failed to save updater store after clearing the install attempt: {e}");
    }
}

/// Recovers from a poisoned lock: the guarded data is plain state, never half-written.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn set_phase(app: &AppHandle, phase: Phase) {
    *lock(&app.state::<UpdaterState>().phase) = phase;
}

/// `tauri dev` must never download the released MSI and hand it to the real
/// installer. The `updater-smoke` feature keeps updates on for the smoke MSIs.
const UPDATES_DISABLED: bool = cfg!(debug_assertions) && !cfg!(feature = "updater-smoke");

pub fn spawn_update_loop(app: AppHandle) {
    if UPDATES_DISABLED {
        log::info!("Updater loop disabled in debug builds");
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(LAUNCH_DELAY);
        let current = app.package_info().version.to_string();
        if let Some(attempted) = read_install_attempt(&app) {
            if attempt_is_stale(&attempted, &current) {
                clear_install_attempt(&app);
            }
        }
        tauri::async_runtime::block_on(run_update_cycle(&app, Trigger::Launch));
        loop {
            std::thread::sleep(PERIODIC_INTERVAL);
            tauri::async_runtime::block_on(run_update_cycle(&app, Trigger::Periodic));
        }
    });
}

/// Only one cycle at a time; `Ready` still re-checks so a pulled or
/// superseded release stops being offered. The timeouts in `check_and_download`
/// are what bound `Checking` and `Downloading` (60 s check, 120 s idle, 2 h total
/// download): a half-open connection fails the cycle instead of skipping every
/// later one until restart.
fn should_skip_cycle(phase: &Phase) -> bool {
    matches!(
        phase,
        Phase::Checking | Phase::Downloading { .. } | Phase::Installing { .. }
    )
}

fn same_version_ready(held_version: Option<&str>, candidate: &str) -> bool {
    held_version == Some(candidate)
}

fn held_version(app: &AppHandle) -> Option<String> {
    lock(&app.state::<UpdaterState>().ready)
        .as_ref()
        .map(|r| r.update.version.clone())
}

enum Fetched {
    UpToDate,
    AlreadyReady(String),
    Downloaded(String),
}

pub async fn run_update_cycle(app: &AppHandle, trigger: Trigger) {
    {
        let state = app.state::<UpdaterState>();
        let mut phase = lock(&state.phase);
        if should_skip_cycle(&phase) {
            return;
        }
        *phase = Phase::Checking;
    }
    match check_and_download(app).await {
        Ok(Fetched::AlreadyReady(version)) => {
            log::debug!("Update {version} is already downloaded");
            set_phase(app, Phase::Ready { version });
        }
        Ok(Fetched::Downloaded(version)) => {
            let attempted = read_install_attempt(app);
            match next_action(
                trigger,
                app_window_visible(app),
                attempted.as_deref(),
                &version,
            ) {
                ReadyAction::Install => {
                    log::info!("Installing update {version} on launch");
                    if let Err(e) = install_ready_update(app) {
                        log::error!("Failed to install update {version}: {e}");
                        // The download is kept, so the tray item can retry.
                        show_restart_item(app, &version);
                    }
                }
                ReadyAction::OfferRestart => show_restart_item(app, &version),
            }
        }
        Ok(Fetched::UpToDate) => {
            log::info!("Up to date ({})", app.package_info().version);
            // A pulled release must not stay installable from the tray.
            *lock(&app.state::<UpdaterState>().ready) = None;
            set_tray_menu(app, TrayUpdateItem::None);
            set_phase(app, Phase::UpToDate);
        }
        Err(e) => {
            let message = e.to_string();
            log::error!("Update check failed: {message}");
            // A held download stays installable, so keep reporting it as ready and
            // restore its tray item (a failed newer download had disabled it).
            match held_version(app) {
                Some(version) => {
                    show_restart_item(app, &version);
                    set_phase(app, Phase::Ready { version });
                }
                None => set_phase(app, Phase::Failed { message }),
            }
        }
    }
}

/// Checks the endpoint and, when a new update exists, downloads it into `ReadyUpdate`.
async fn check_and_download(app: &AppHandle) -> tauri_plugin_updater::Result<Fetched> {
    let hook_app = app.clone();
    let builder = app
        .updater_builder()
        // The plugin sets no timeout of its own. `configure_client` is applied to
        // both the check and the download client (plugin 2.10.1).
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(IDLE_TIMEOUT)
        })
        .on_before_exit(move || {
            if let Err(e) = crate::stop_time_parser_service(&hook_app) {
                log::warn!("Failed to stop the time parser service before installing: {e}");
            }
            // An adopted sidecar (left over from a crashed or killed run) has no
            // supervised child, so the stop above leaves its node.exe locking the
            // install directory. Debug builds never kill, as at startup.
            if !cfg!(debug_assertions) && crate::time_parser_health_app_version().is_some() {
                log::info!("Killing the unsupervised time parser service before installing");
                crate::kill_time_parser_listener();
            }
            // Setting a hook replaces the plugin's default one, which only did this.
            hook_app.cleanup_before_exit();
        });
    let Some(mut update) = builder.build()?.check().await? else {
        return Ok(Fetched::UpToDate);
    };
    // The builder's timeout covers only the check (2.10.1 builds `Update` with
    // `timeout: None`); the download relies on the idle timeout plus this backstop.
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let version = update.version.clone();
    let held = held_version(app);
    if same_version_ready(held.as_deref(), &version) {
        return Ok(Fetched::AlreadyReady(version));
    }
    set_phase(
        app,
        Phase::Downloading {
            version: version.clone(),
        },
    );
    // A tray click would only be refused while the newer version downloads, so the
    // held version's restart item is disabled until the download ends.
    if held.is_some() {
        set_tray_menu(app, TrayUpdateItem::Downloading(&version));
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    *lock(&app.state::<UpdaterState>().ready) = Some(ReadyUpdate { update, bytes });
    set_phase(
        app,
        Phase::Ready {
            version: version.clone(),
        },
    );
    Ok(Fetched::Downloaded(version))
}

const STILL_DOWNLOADING: &str = "Update is still downloading";
const NOTHING_READY: &str = "No update is ready";
const ALREADY_INSTALLING: &str = "The update is already installing";

/// Why an install cannot start now, if it cannot. `UpdateChecker.tsx` maps these
/// strings to user copy, as `install_error_copy` does for the tray.
fn install_refusal(phase: &Phase, has_ready: bool) -> Option<&'static str> {
    if matches!(phase, Phase::Installing { .. }) {
        Some(ALREADY_INSTALLING)
    } else if matches!(phase, Phase::Downloading { .. }) {
        Some(STILL_DOWNLOADING)
    } else if !has_ready {
        Some(NOTHING_READY)
    } else {
        None
    }
}

/// User copy for an `install_ready_update` error; anything but a refusal is shown verbatim.
pub fn install_error_copy(error: &str) -> &str {
    match error {
        STILL_DOWNLOADING => "The update is still downloading.",
        NOTHING_READY => "No update is ready yet.",
        ALREADY_INSTALLING => "The update is already installing.",
        other => other,
    }
}

/// Hands the downloaded update to the installer. On Windows a successful
/// install exits the process, so `Ok` is only seen on other platforms.
pub fn install_ready_update(app: &AppHandle) -> Result<(), String> {
    if UPDATES_DISABLED {
        return Err("Updates are disabled in debug builds".to_string());
    }
    let state = app.state::<UpdaterState>();
    // The update is taken out and both locks released before the hand-off (which
    // runs the pre-exit hook), so a concurrent click is refused as `Installing`
    // instead of blocking on the lock. Lock order: ready, then phase.
    let (ready, previous_phase) = {
        let mut ready = lock(&state.ready);
        let mut phase = lock(&state.phase);
        if let Some(refusal) = install_refusal(&phase, ready.is_some()) {
            return Err(refusal.to_string());
        }
        let ready = ready.take().expect("install_refusal checked has_ready");
        let installing = Phase::Installing {
            version: ready.update.version.clone(),
        };
        (ready, std::mem::replace(&mut *phase, installing))
    };
    let version = ready.update.version.clone();
    // Put back on any failure, so the tray item can retry.
    let restore = |ready: ReadyUpdate, phase: Phase| {
        *lock(&state.ready) = Some(ready);
        set_phase(app, phase);
    };
    // Every hand-off (launch, tray, update window) exits before the installer's
    // outcome is known, so each one gets the watchdog.
    let watchdog = spawn_relaunch_watchdog();
    if let Err(e) = record_install_attempt(app, &version) {
        stop_relaunch_watchdog(watchdog);
        restore(ready, previous_phase);
        return Err(e);
    }
    if let Err(e) = ready.update.install(&ready.bytes) {
        let message = e.to_string();
        log::error!("Failed to install update {version}: {message}");
        // The install never handed off and the app keeps running, so a user who
        // quits within 15 minutes must not be relaunched.
        stop_relaunch_watchdog(watchdog);
        restore(ready, phase_after_failed_install(&version));
        return Err(message);
    }
    Ok(())
}

fn stop_relaunch_watchdog(watchdog: Option<std::process::Child>) {
    if let Some(mut watchdog) = watchdog {
        match watchdog.kill() {
            Ok(()) => log::debug!("Stopped the relaunch watchdog"),
            Err(e) => log::debug!("Failed to stop the relaunch watchdog: {e}"),
        }
    }
}

/// Run by the relaunch watchdog, with the app's exe path and PID passed as the
/// environment variables `HAMMER_RELAUNCH_EXE` and `HAMMER_RELAUNCH_PID` (data, never
/// parsed as code). First it waits (2 s polls) for this app to exit, which happens
/// right after the plugin has asked the shell to start `msiexec`. Then it waits up
/// to 60 s (2 s polls) for an installer (`msiexec`) or a UAC prompt (`consent`) to
/// appear in a user session, so a slow start on a loaded machine is not mistaken
/// for a finished install; if none appears the hand-off never started. Once one
/// has appeared it keeps waiting, every 10 s, while one is running. Session 0 is
/// skipped: the Windows Installer service's own msiexec lingers there for minutes
/// after any install. All waits share one 15-minute cap from spawn. Then, unless
/// a process from `HAMMER_RELAUNCH_EXE` is already running (the installer
/// relaunched it), it starts the app the way autostart does. The final check is
/// on our own exe, never on other installers: an unrelated winget or Office
/// install spanning the cap must not leave HammerOverlay closed. If our own
/// install is still running past 15 minutes, this may start the previous version,
/// and Windows Installer's Restart Manager will close it. A redundant start is a
/// no-op through the single-instance guard.
const RELAUNCH_WATCHDOG_SCRIPT: &str = concat!(
    "$deadline = (Get-Date).AddMinutes(15); ",
    "while ((Get-Process -Id $env:HAMMER_RELAUNCH_PID -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }; ",
    "$appearBy = (Get-Date).AddSeconds(60); ",
    "while (-not (Get-Process -Name msiexec, consent -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 }) -and (Get-Date) -lt $appearBy -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }; ",
    "while ((Get-Process -Name msiexec, consent -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 }) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 10 }; ",
    "$appName = [IO.Path]::GetFileNameWithoutExtension($env:HAMMER_RELAUNCH_EXE); ",
    "if (-not (Get-Process -Name $appName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:HAMMER_RELAUNCH_EXE })) { Start-Process -FilePath $env:HAMMER_RELAUNCH_EXE -ArgumentList '--minimized' }",
);

/// Every install hand-off exits before the installer's outcome is known, so a
/// declined UAC prompt or a failed install would otherwise leave nothing running.
/// Spawned detached and hidden, never waited on; a failure never blocks the install.
/// Returns the child so a hand-off that never happened can stop it.
fn spawn_relaunch_watchdog() -> Option<std::process::Child> {
    #[cfg(not(windows))]
    return None;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(e) => {
                log::warn!("Not starting the relaunch watchdog: no current exe path: {e}");
                return None;
            }
        };
        let spawned = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
            ])
            .arg(RELAUNCH_WATCHDOG_SCRIPT)
            .env("HAMMER_RELAUNCH_EXE", &exe)
            .env("HAMMER_RELAUNCH_PID", std::process::id().to_string())
            // Never hold the install folder open.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::CREATE_NO_WINDOW)
            .spawn();
        match spawned {
            Ok(child) => {
                log::info!(
                    "Started relaunch watchdog (pid {}) for {}",
                    child.id(),
                    exe.display()
                );
                Some(child)
            }
            Err(e) => {
                log::warn!("Failed to start the relaunch watchdog: {e}");
                None
            }
        }
    }
}

/// The bytes are still held and the attempt marker is recorded, so `Ready`
/// offers the restart with "could not be installed last time" instead of a
/// raw error.
fn phase_after_failed_install(version: &str) -> Phase {
    Phase::Ready {
        version: version.to_string(),
    }
}

/// The busy test: any visible window (overlay, Settings, update window) means
/// the user may be mid-task, so exiting into the installer would interrupt them.
fn app_window_visible(app: &AppHandle) -> bool {
    #[cfg(feature = "updater-smoke")]
    if std::env::var("HAMMER_SMOKE_OVERLAY_VISIBLE").as_deref() == Ok("1") {
        return true;
    }
    app.webview_windows()
        .values()
        .any(|w| w.is_visible().unwrap_or(false))
}

pub fn show_restart_item(app: &AppHandle, version: &str) {
    set_tray_menu(app, TrayUpdateItem::Ready(version));
    log::info!("Update {version} ready; restart to update");
}

fn set_tray_menu(app: &AppHandle, item: TrayUpdateItem) {
    match crate::create_system_tray_menu(app, item) {
        Ok(menu) => {
            if let Some(Err(e)) = app.tray_by_id("main").map(|t| t.set_menu(Some(menu))) {
                log::error!("Failed to set the tray menu: {e}");
            }
        }
        Err(e) => log::error!("Failed to build the tray menu: {e}"),
    }
}

#[tauri::command]
pub async fn get_update_status(app: AppHandle) -> UpdateStatus {
    let phase = lock(&app.state::<UpdaterState>().phase).clone();
    let attempted = read_install_attempt(&app);
    let previous_attempt_failed = matches!(
        &phase,
        Phase::Ready { version } if attempted.as_deref() == Some(version.as_str())
    );
    status_from_phase(
        &phase,
        &app.package_info().version.to_string(),
        previous_attempt_failed,
    )
}

#[tauri::command]
pub async fn check_for_updates_now(app: AppHandle) -> UpdateStatus {
    run_update_cycle(&app, Trigger::Manual).await;
    get_update_status(app).await
}

#[tauri::command]
pub async fn install_update_now(app: AppHandle) -> Result<(), String> {
    let has_ready = lock(&app.state::<UpdaterState>().ready).is_some();
    if !has_ready {
        run_update_cycle(&app, Trigger::Manual).await;
    }
    install_ready_update(&app)
}

/// Current UTC time as RFC 3339, without pulling in a date crate.
fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant), valid for dates after 1970.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_in_flight_phases_skip_a_cycle() {
        let v = || "0.1.7".to_string();
        assert!(should_skip_cycle(&Phase::Checking));
        assert!(should_skip_cycle(&Phase::Downloading { version: v() }));
        assert!(should_skip_cycle(&Phase::Installing { version: v() }));
        assert!(!should_skip_cycle(&Phase::Ready { version: v() }));
        assert!(!should_skip_cycle(&Phase::Idle));
        assert!(!should_skip_cycle(&Phase::UpToDate));
        assert!(!should_skip_cycle(&Phase::Failed { message: v() }));
    }

    #[test]
    fn held_download_is_reused_only_for_the_same_version() {
        assert!(same_version_ready(Some("0.1.7"), "0.1.7"));
        assert!(!same_version_ready(Some("0.1.7"), "0.1.8"));
        assert!(!same_version_ready(None, "0.1.7"));
    }

    #[test]
    fn install_while_downloading_is_refused() {
        let downloading = Phase::Downloading {
            version: "0.1.7".into(),
        };
        assert_eq!(
            install_refusal(&downloading, false),
            Some("Update is still downloading")
        );
        assert_eq!(
            install_refusal(&downloading, true),
            Some("Update is still downloading")
        );
    }

    #[test]
    fn tray_install_errors_get_the_update_window_copy() {
        let downloading = Phase::Downloading {
            version: "0.1.7".into(),
        };
        let refusal = install_refusal(&downloading, true).unwrap();
        assert_eq!(
            install_error_copy(refusal),
            "The update is still downloading."
        );
        let refusal = install_refusal(&Phase::Idle, false).unwrap();
        assert_eq!(install_error_copy(refusal), "No update is ready yet.");
        assert_eq!(
            install_error_copy("Access is denied. (os error 5)"),
            "Access is denied. (os error 5)"
        );
    }

    #[test]
    fn second_install_while_installing_is_refused() {
        let installing = Phase::Installing {
            version: "0.1.7".into(),
        };
        // The update has been taken out of `ready` by then, and is refused either way.
        for has_ready in [false, true] {
            let refusal = install_refusal(&installing, has_ready);
            assert_eq!(refusal, Some("The update is already installing"));
            assert_eq!(
                install_error_copy(refusal.unwrap()),
                "The update is already installing."
            );
        }
    }

    #[test]
    fn install_with_nothing_ready_is_refused() {
        assert_eq!(
            install_refusal(&Phase::Idle, false),
            Some("No update is ready")
        );
    }

    #[test]
    fn install_with_ready_update_proceeds() {
        let ready = Phase::Ready {
            version: "0.1.7".into(),
        };
        assert_eq!(install_refusal(&ready, true), None);
        let failed = Phase::Failed {
            message: "boom".into(),
        };
        assert_eq!(install_refusal(&failed, true), None);
    }

    #[test]
    fn failed_install_returns_to_ready_with_prior_failure_copy() {
        let phase = phase_after_failed_install("0.1.7");
        assert!(matches!(&phase, Phase::Ready { version } if version == "0.1.7"));
        // Retrying is allowed, and the marker makes the window explain the failure.
        assert_eq!(install_refusal(&phase, true), None);
        let status = status_from_phase(&phase, "0.1.6", true);
        assert_eq!(
            status.message.as_deref(),
            Some("0.1.7 could not be installed last time; restart to try again.")
        );
    }

    #[test]
    fn relaunch_watchdog_waits_for_the_app_then_msiexec_then_starts_the_exe_unless_running() {
        let script = RELAUNCH_WATCHDOG_SCRIPT;
        let installer = "(Get-Process -Name msiexec, consent -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 })";
        let pid_wait = script
            .find("Get-Process -Id $env:HAMMER_RELAUNCH_PID")
            .expect("waits on the app PID");
        let appear_wait = script
            .find(&format!("while (-not {installer}"))
            .expect("waits for the installer or UAC prompt to appear");
        let running_wait = script
            .find(&format!("while ({installer}"))
            .expect("waits while the user-session msiexec or UAC prompt runs");
        assert!(pid_wait < appear_wait);
        assert!(appear_wait < running_wait);
        assert!(script.contains("AddSeconds(60)"));
        assert!(script.contains("AddMinutes(15)"));
        // The final guard checks only our own exe, so an unrelated installer
        // spanning the cap cannot leave the app closed.
        let final_guard = script
            .find("if (-not (Get-Process -Name $appName")
            .expect("final guard checks the app process");
        assert!(running_wait < final_guard);
        assert!(script.contains(
            "$appName = [IO.Path]::GetFileNameWithoutExtension($env:HAMMER_RELAUNCH_EXE)"
        ));
        assert!(script.ends_with(
            "; if (-not (Get-Process -Name $appName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:HAMMER_RELAUNCH_EXE })) { Start-Process -FilePath $env:HAMMER_RELAUNCH_EXE -ArgumentList '--minimized' }"
        ));
        assert!(!script[final_guard..].contains("msiexec"));
        assert!(!script.contains("hammer-overlay"));
        assert_eq!(script.matches("Start-Process").count(), 1);
        // The path is passed as data, never embedded in the script text.
        assert!(!script.contains(".exe"));
        assert!(!script.contains("{exe}"));
    }

    #[test]
    fn launch_with_all_windows_hidden_installs() {
        assert!(matches!(
            next_action(Trigger::Launch, false, None, "0.1.7"),
            ReadyAction::Install
        ));
    }

    #[test]
    fn launch_with_a_visible_window_defers() {
        assert!(matches!(
            next_action(Trigger::Launch, true, None, "0.1.7"),
            ReadyAction::OfferRestart
        ));
    }

    #[test]
    fn launch_after_failed_attempt_defers() {
        assert!(matches!(
            next_action(Trigger::Launch, false, Some("0.1.7"), "0.1.7"),
            ReadyAction::OfferRestart
        ));
    }

    #[test]
    fn launch_after_attempt_of_other_version_installs() {
        assert!(matches!(
            next_action(Trigger::Launch, false, Some("0.1.6"), "0.1.7"),
            ReadyAction::Install
        ));
    }

    #[test]
    fn periodic_and_manual_never_install() {
        assert!(matches!(
            next_action(Trigger::Periodic, false, None, "0.1.7"),
            ReadyAction::OfferRestart
        ));
        assert!(matches!(
            next_action(Trigger::Manual, false, None, "0.1.7"),
            ReadyAction::OfferRestart
        ));
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
        let status = status_from_phase(
            &Phase::Failed {
                message: "boom".into(),
            },
            "0.1.6",
            false,
        );
        assert_eq!(status.phase, "failed");
        assert_eq!(status.message.as_deref(), Some("boom"));
        assert_eq!(status.available_version, None);
    }

    #[test]
    fn ready_phase_reports_version_and_prior_failure() {
        let status = status_from_phase(
            &Phase::Ready {
                version: "0.1.7".into(),
            },
            "0.1.6",
            true,
        );
        assert_eq!(status.phase, "ready");
        assert_eq!(status.available_version.as_deref(), Some("0.1.7"));
        assert_eq!(
            status.message.as_deref(),
            Some("0.1.7 could not be installed last time; restart to try again.")
        );
    }
}
