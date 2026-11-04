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
/// Per request (manifest check, MSI download); generous for 80 MB on a slow link.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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

/// Auto-install only on launch, with the overlay hidden, and never for a
/// version whose install already failed once.
pub fn next_action(
    trigger: Trigger,
    overlay_visible: bool,
    attempted_version: Option<&str>,
    version: &str,
) -> ReadyAction {
    if matches!(trigger, Trigger::Launch) && !overlay_visible && attempted_version != Some(version)
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

pub fn spawn_update_loop(app: AppHandle) {
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
/// superseded release stops being offered. `REQUEST_TIMEOUT` on the check and
/// download is what bounds `Checking` and `Downloading`: a half-open connection
/// fails the cycle instead of skipping every later one until restart.
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
                overlay_visible(app),
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
            set_tray_menu(app, None);
            set_phase(app, Phase::UpToDate);
        }
        Err(e) => {
            let message = e.to_string();
            log::error!("Update check failed: {message}");
            // A held download stays installable, so keep reporting it as ready.
            match held_version(app) {
                Some(version) => set_phase(app, Phase::Ready { version }),
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
        // The plugin sets no timeout of its own.
        .timeout(REQUEST_TIMEOUT)
        .on_before_exit(move || {
            if let Err(e) = crate::stop_time_parser_service(&hook_app) {
                log::warn!("Failed to stop the time parser service before installing: {e}");
            }
            // Setting a hook replaces the plugin's default one, which only did this.
            hook_app.cleanup_before_exit();
        });
    let Some(mut update) = builder.build()?.check().await? else {
        return Ok(Fetched::UpToDate);
    };
    // The builder's timeout covers only the check (2.10.1 builds `Update` with
    // `timeout: None`), so the download needs its own; it spans the whole body.
    update.timeout = Some(REQUEST_TIMEOUT);
    let version = update.version.clone();
    if same_version_ready(held_version(app).as_deref(), &version) {
        return Ok(Fetched::AlreadyReady(version));
    }
    set_phase(
        app,
        Phase::Downloading {
            version: version.clone(),
        },
    );
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

/// Why an install cannot start now, if it cannot.
fn install_refusal(phase: &Phase, has_ready: bool) -> Option<&'static str> {
    if matches!(phase, Phase::Downloading { .. }) {
        Some("Update is still downloading")
    } else if !has_ready {
        Some("No update is ready")
    } else {
        None
    }
}

/// Hands the downloaded update to the installer. On Windows a successful
/// install exits the process, so `Ok` is only seen on other platforms.
pub fn install_ready_update(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let ready = lock(&state.ready);
    let phase = lock(&state.phase).clone();
    if let Some(refusal) = install_refusal(&phase, ready.is_some()) {
        return Err(refusal.to_string());
    }
    let ready = ready.as_ref().expect("install_refusal checked has_ready");
    let version = ready.update.version.clone();
    record_install_attempt(app, &version)?;
    set_phase(app, Phase::Installing { version });
    ready.update.install(&ready.bytes).map_err(|e| {
        let message = e.to_string();
        log::error!("Failed to install update: {message}");
        set_phase(
            app,
            Phase::Failed {
                message: message.clone(),
            },
        );
        message
    })
}

fn overlay_visible(app: &AppHandle) -> bool {
    #[cfg(feature = "updater-smoke")]
    if std::env::var("HAMMER_SMOKE_OVERLAY_VISIBLE").as_deref() == Ok("1") {
        return true;
    }
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

pub fn show_restart_item(app: &AppHandle, version: &str) {
    set_tray_menu(app, Some(version));
    log::info!("Update {version} ready; restart to update");
}

fn set_tray_menu(app: &AppHandle, restart_version: Option<&str>) {
    match crate::create_system_tray_menu(app, restart_version) {
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
    fn launch_with_hidden_overlay_installs() {
        assert!(matches!(
            next_action(Trigger::Launch, false, None, "0.1.7"),
            ReadyAction::Install
        ));
    }

    #[test]
    fn launch_with_visible_overlay_defers() {
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
