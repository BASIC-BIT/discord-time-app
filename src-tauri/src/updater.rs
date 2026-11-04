// ponytail: Task 3 wires these into the background loop and commands; drop this allow then.
#![allow(dead_code)]

use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

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
