use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

#[cfg(not(feature = "updater-smoke"))]
pub const LAUNCH_DELAY: Duration = Duration::from_secs(90);
#[cfg(feature = "updater-smoke")]
pub const LAUNCH_DELAY: Duration = Duration::from_secs(5);
pub const PERIODIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

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

fn store<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<std::sync::Arc<tauri_plugin_store::Store<R>>, String> {
    tauri_plugin_store::StoreBuilder::new(app, STORE_FILE)
        .build()
        .map_err(|e| {
            log::error!("Failed to build updater store: {e}");
            e.to_string()
        })
}

pub fn read_install_attempt<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    store(app)
        .ok()?
        .get(ATTEMPT_KEY)?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

pub fn record_install_attempt<R: Runtime>(app: &AppHandle<R>, version: &str) -> Result<(), String> {
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

pub fn clear_install_attempt<R: Runtime>(app: &AppHandle<R>) {
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

fn set_phase<R: Runtime>(app: &AppHandle<R>, phase: Phase) {
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

pub async fn run_update_cycle<R: Runtime>(app: &AppHandle<R>, trigger: Trigger) {
    {
        let state = app.state::<UpdaterState>();
        let mut phase = lock(&state.phase);
        if matches!(
            *phase,
            Phase::Downloading { .. } | Phase::Installing { .. } | Phase::Ready { .. }
        ) {
            return;
        }
        *phase = Phase::Checking;
    }
    match check_and_download(app).await {
        Ok(Some(version)) => {
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
        Ok(None) => {
            log::info!("Up to date ({})", app.package_info().version);
            set_phase(app, Phase::UpToDate);
        }
        Err(e) => {
            let message = e.to_string();
            log::error!("Update check failed: {message}");
            set_phase(app, Phase::Failed { message });
        }
    }
}

/// Checks the endpoint and, when an update exists, downloads it into `ReadyUpdate`.
async fn check_and_download<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri_plugin_updater::Result<Option<String>> {
    let hook_app = app.clone();
    let builder = app.updater_builder().on_before_exit(move || {
        if let Err(e) = crate::stop_time_parser_service(&hook_app) {
            log::warn!("Failed to stop the time parser service before installing: {e}");
        }
        // Setting a hook replaces the plugin's default one, which only did this.
        hook_app.cleanup_before_exit();
    });
    #[cfg(test)]
    let builder = match std::env::var("HAMMER_TEST_UPDATER_ENDPOINT") {
        Ok(endpoint) => builder.endpoints(vec![endpoint
            .parse()
            .expect("HAMMER_TEST_UPDATER_ENDPOINT is a URL")])?,
        Err(_) => builder,
    };
    let Some(update) = builder.build()?.check().await? else {
        return Ok(None);
    };
    let version = update.version.clone();
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
    Ok(Some(version))
}

/// Hands the downloaded update to the installer. On Windows a successful
/// install exits the process, so `Ok` is only seen on other platforms.
pub fn install_ready_update<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    if matches!(*lock(&state.phase), Phase::Downloading { .. }) {
        return Err("Update is still downloading".to_string());
    }
    let ready = lock(&state.ready);
    let Some(ready) = ready.as_ref() else {
        return Err("No update is ready".to_string());
    };
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

fn overlay_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    #[cfg(feature = "updater-smoke")]
    if std::env::var("HAMMER_SMOKE_OVERLAY_VISIBLE").as_deref() == Ok("1") {
        return true;
    }
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

pub fn show_restart_item<R: Runtime>(app: &AppHandle<R>, version: &str) {
    match crate::create_system_tray_menu(app, Some(version)) {
        Ok(menu) => {
            if let Some(Err(e)) = app.tray_by_id("main").map(|t| t.set_menu(Some(menu))) {
                log::error!("Failed to set the tray menu: {e}");
            }
        }
        Err(e) => log::error!("Failed to build the tray menu: {e}"),
    }
    log::info!("Update {version} ready; restart to update");
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
    fn install_while_downloading_is_refused() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(UpdaterState::default());
        *handle.state::<UpdaterState>().phase.lock().unwrap() = Phase::Downloading {
            version: "0.1.7".into(),
        };
        assert_eq!(
            install_ready_update(&handle),
            Err("Update is still downloading".to_string())
        );
        assert!(matches!(
            *handle.state::<UpdaterState>().phase.lock().unwrap(),
            Phase::Downloading { .. }
        ));
    }

    #[test]
    fn install_with_nothing_ready_is_refused() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(UpdaterState::default());
        assert_eq!(
            install_ready_update(&handle),
            Err("No update is ready".to_string())
        );
    }

    #[test]
    fn unreachable_endpoint_leaves_failed_phase() {
        // mock_app() has no plugin config, so register the updater plugin with a minimal one.
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), serde_json::json!({ "pubkey": "test" }));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let handle = app.handle().clone();
        handle.manage(UpdaterState::default());
        std::env::set_var(
            "HAMMER_TEST_UPDATER_ENDPOINT",
            "http://127.0.0.1:9/latest.json",
        );
        tauri::async_runtime::block_on(run_update_cycle(&handle, Trigger::Periodic));
        assert!(matches!(
            *handle.state::<UpdaterState>().phase.lock().unwrap(),
            Phase::Failed { .. }
        ));
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
