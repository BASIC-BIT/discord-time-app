// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use single_instance::SingleInstance;
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_store::StoreBuilder;
use tauri_plugin_updater::UpdaterExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const TIME_PARSER_PORT: u16 = 8857;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize)]
pub struct FormatStats {
    pub d: u32,
    #[serde(rename = "D")]
    pub long_date: u32,
    pub t: u32,
    #[serde(rename = "T")]
    pub long_time: u32,
    pub f: u32,
    #[serde(rename = "F")]
    pub long_date_time: u32,
    #[serde(rename = "R")]
    pub relative_time: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeParserServiceConfig {
    pub base_url: String,
    pub api_key: String,
    pub available: bool,
    pub supervised: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTimeParserRequest {
    pub text: String,
    pub tz: String,
    pub now: Option<String>,
    pub features: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTimeParserResponse {
    pub ok: bool,
    pub status: u16,
    pub body: serde_json::Value,
}

pub struct TimeParserServiceState {
    child: Mutex<Option<Child>>,
    base_url: String,
}

impl TimeParserServiceState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            base_url: format!("http://127.0.0.1:{TIME_PARSER_PORT}"),
        }
    }
}

impl Drop for TimeParserServiceState {
    fn drop(&mut self) {
        if let Ok(mut child_slot) = self.child.lock() {
            if let Some(child) = child_slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub auto_start: bool,
    pub global_hotkey: String,
    pub auto_close_on_focus_loss: bool,
    pub auto_load_clipboard: bool,
    pub use_llm_parsing: bool,
    pub deterministic_preflight: bool,
    pub theme: String, // "dark", "light", "system"
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_start: false,
            global_hotkey: "ctrl+shift+h".to_string(),
            auto_close_on_focus_loss: false,
            auto_load_clipboard: true,
            use_llm_parsing: true,
            deterministic_preflight: false,
            theme: "dark".to_string(),
        }
    }
}

fn explicit_time_parser_api_key() -> Option<String> {
    std::env::var("HAMMEROVERLAY_API_KEY")
        .or_else(|_| std::env::var("STATIC_API_KEY"))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn dev_api_overrides_allowed() -> bool {
    cfg!(debug_assertions) || env_flag_enabled("HAMMEROVERLAY_ALLOW_DEV_API_OVERRIDES")
}

fn dev_api_override_var(name: &str) -> Option<String> {
    if !dev_api_overrides_allowed() {
        return None;
    }

    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn log_ignored_dev_api_overrides() {
    if dev_api_overrides_allowed() {
        return;
    }

    if [
        "HAMMEROVERLAY_API_ENV",
        "HAMMEROVERLAY_API_ENTRYPOINT",
        "HAMMEROVERLAY_NODE",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some())
    {
        log::warn!(
            "Development API overrides are set but ignored by this release build. Set HAMMEROVERLAY_ALLOW_DEV_API_OVERRIDES=1 to opt in."
        );
    }
}

fn time_parser_api_key(app: &AppHandle, allow_api_env: bool) -> Result<String, String> {
    if let Some(api_key) = explicit_time_parser_api_key() {
        return Ok(api_key);
    }

    if allow_api_env {
        if let Some(api_key) = read_static_api_key_from_api_env() {
            return Ok(api_key);
        }
    }

    get_or_create_install_api_key(app)
}

fn time_parser_api_key_candidates(app: &AppHandle) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();
    candidates.push(time_parser_api_key(app, false)?);
    if let Some(api_key) = read_static_api_key_from_api_env() {
        if !candidates.iter().any(|candidate| candidate == &api_key) {
            candidates.push(api_key);
        }
    }
    Ok(candidates)
}

fn get_or_create_install_api_key(app: &AppHandle) -> Result<String, String> {
    let key_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?
        .join("time-parser-api-key");

    if let Ok(existing_key) = fs::read_to_string(&key_path) {
        let existing_key = existing_key.trim();
        if !existing_key.is_empty() {
            return Ok(existing_key.to_string());
        }
    }

    if let Some(parent) = key_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parser key directory: {e}"))?;
    }

    let api_key = generate_time_parser_api_key()?;
    fs::write(&key_path, format!("{api_key}\n"))
        .map_err(|e| format!("Failed to persist parser API key: {e}"))?;
    Ok(api_key)
}

fn generate_time_parser_api_key() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Failed to generate parser API key: {e}"))?;
    Ok(format!("ho_{}", hex_encode(&bytes)))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn read_static_api_key_from_api_env() -> Option<String> {
    read_api_env_var("STATIC_API_KEY")
}

fn read_api_env_var(name: &str) -> Option<String> {
    let mut candidates = Vec::new();

    if let Some(env_path) = dev_api_override_var("HAMMEROVERLAY_API_ENV") {
        candidates.push(PathBuf::from(env_path));
    }

    if dev_api_overrides_allowed() {
        if let Ok(current_dir) = std::env::current_dir() {
            candidates.push(current_dir.join("api").join(".env"));
            candidates.push(current_dir.join("..").join("api").join(".env"));
            candidates.push(
                current_dir
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("api")
                    .join(".env"),
            );
        }
    }

    let prefix = format!("{name}=");
    candidates.into_iter().find_map(|path| {
        let contents = fs::read_to_string(path).ok()?;
        contents.lines().find_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                return None;
            }

            let value = trimmed.strip_prefix(&prefix)?.trim();
            let value = strip_inline_env_comment(value)
                .trim_matches('"')
                .trim_matches('\'')
                .trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
    })
}

fn apply_optional_api_env(command: &mut Command) {
    for name in [
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "OPENAI_REASONING_EFFORT",
        "LANGFUSE_ENABLED",
        "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_SECRET_KEY",
        "LANGFUSE_BASE_URL",
        "LANGFUSE_HOST",
        "TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT",
        "TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR",
        "TEMPORAL_FEATURE_PLAN_IR",
        "TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE",
        "TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL",
        "TEMPORAL_PLAN_IR_ENDPOINT_MODEL",
        "TEMPORAL_PLAN_IR_ENDPOINT_API_KEY",
        "TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET",
        "TEMPORAL_PLAN_IR_ENDPOINT_API",
        "TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT",
        "TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS",
        "TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS",
    ] {
        let parent_has_value = std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .is_some();
        if !parent_has_value {
            if let Some(value) = read_api_env_var(name) {
                command.env(name, value);
            }
        }
    }
}

fn time_parser_health_check() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], TIME_PARSER_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: localhost:{TIME_PARSER_PORT}\r\nConnection: close\r\n\r\n"
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut buffer = [0_u8; 256];
    match stream.read(&mut buffer) {
        Ok(bytes_read) if bytes_read > 0 => std::str::from_utf8(&buffer[..bytes_read])
            .map(|response| {
                response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn wait_for_time_parser_service(timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if time_parser_health_check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

async fn time_parser_health_check_blocking() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(time_parser_health_check)
        .await
        .map_err(|e| format!("Failed to join parser health check: {e}"))
}

async fn wait_for_time_parser_service_blocking(timeout: Duration) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || wait_for_time_parser_service(timeout))
        .await
        .map_err(|e| format!("Failed to join parser startup wait: {e}"))
}

async fn local_time_parser_request_blocking(
    method: String,
    path: String,
    api_key: String,
    body: Option<String>,
    timeout: Duration,
) -> Result<NativeTimeParserResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        local_time_parser_request(&method, &path, &api_key, body.as_deref(), timeout)
    })
    .await
    .map_err(|e| format!("Failed to join parser request: {e}"))?
}

fn local_time_parser_request(
    method: &str,
    path: &str,
    api_key: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<NativeTimeParserResponse, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], TIME_PARSER_PORT));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1000))
        .map_err(|e| format!("Failed to connect to local parser service: {e}"))?;

    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost:{TIME_PARSER_PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nx-api-key: {api_key}\r\nx-api-version: 1\r\nContent-Length: {}\r\n\r\n{body}",
        body.as_bytes().len()
    );

    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("Failed to write parser request: {e}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("Failed to read parser response: {e}"))?;

    parse_local_http_json_response(&response)
}

fn parse_local_http_json_response(response: &str) -> Result<NativeTimeParserResponse, String> {
    let (headers, body_text) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Parser response did not contain HTTP headers".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "Parser response did not contain an HTTP status".to_string())?;
    let body = serde_json::from_str(body_text).unwrap_or_else(|_| {
        serde_json::json!({
            "error": "invalid_parser_response",
            "message": body_text,
        })
    });
    Ok(NativeTimeParserResponse {
        ok: (200..300).contains(&status),
        status,
        body,
    })
}

fn strip_inline_env_comment(value: &str) -> &str {
    value
        .split_once(" #")
        .map(|(value, _comment)| value.trim_end())
        .unwrap_or(value)
}

fn supervised_time_parser_disabled() -> bool {
    env_flag_enabled("HAMMEROVERLAY_DISABLE_SUPERVISED_API")
}

fn find_time_parser_entrypoint(app: &AppHandle) -> Option<PathBuf> {
    if let Some(entrypoint) = dev_api_override_var("HAMMEROVERLAY_API_ENTRYPOINT") {
        let path = PathBuf::from(entrypoint);
        if path.is_file() {
            return Some(path);
        }
        log::warn!("HAMMEROVERLAY_API_ENTRYPOINT does not point to a file: {path:?}");
    }

    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("api").join("dist").join("index.js"));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("api").join("dist").join("index.js"));
            candidates.push(exe_dir.join("..").join("api").join("dist").join("index.js"));
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("sidecars")
                .join("hammer-overlay-api")
                .join("dist")
                .join("index.js"),
        );
        candidates.push(
            current_dir
                .join("sidecars")
                .join("hammer-overlay-api")
                .join("dist")
                .join("index.js"),
        );
        candidates.push(current_dir.join("api").join("dist").join("index.js"));
        candidates.push(
            current_dir
                .join("..")
                .join("api")
                .join("dist")
                .join("index.js"),
        );
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn find_time_parser_node(app: &AppHandle) -> PathBuf {
    if let Some(node_path) = dev_api_override_var("HAMMEROVERLAY_NODE") {
        return PathBuf::from(node_path);
    }

    let node_exe = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("api").join("bin").join(node_exe));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("api").join("bin").join(node_exe));
            candidates.push(exe_dir.join("..").join("api").join("bin").join(node_exe));
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("sidecars")
                .join("hammer-overlay-api")
                .join("bin")
                .join(node_exe),
        );
        candidates.push(
            current_dir
                .join("sidecars")
                .join("hammer-overlay-api")
                .join("bin")
                .join(node_exe),
        );
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

#[cfg(windows)]
fn child_process_path(path: &Path) -> PathBuf {
    let path_text = path.to_string_lossy();
    if let Some(stripped) = path_text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = path_text.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn child_process_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn api_root_for_entrypoint(entrypoint: &Path) -> PathBuf {
    let Some(parent) = entrypoint.parent() else {
        return PathBuf::from("api");
    };

    if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "dist")
    {
        parent
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| parent.to_path_buf())
    } else {
        parent.to_path_buf()
    }
}

fn time_parser_db_path(app: &AppHandle) -> Option<PathBuf> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    if let Err(e) = fs::create_dir_all(&app_data_dir) {
        log::warn!("Failed to create app data directory for parser DB: {e}");
        return None;
    }
    Some(app_data_dir.join("temporal-api-usage.db"))
}

fn time_parser_log_stdio(app: &AppHandle) -> (Stdio, Stdio) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return (Stdio::null(), Stdio::null());
    };

    if let Err(e) = fs::create_dir_all(&app_data_dir) {
        log::warn!("Failed to create parser log directory: {e}");
        return (Stdio::null(), Stdio::null());
    }

    let stdout = fs::File::create(app_data_dir.join("time-parser-api.out.log"))
        .map(Stdio::from)
        .unwrap_or_else(|e| {
            log::warn!("Failed to create parser stdout log: {e}");
            Stdio::null()
        });
    let stderr = fs::File::create(app_data_dir.join("time-parser-api.err.log"))
        .map(Stdio::from)
        .unwrap_or_else(|e| {
            log::warn!("Failed to create parser stderr log: {e}");
            Stdio::null()
        });

    (stdout, stderr)
}

fn start_time_parser_service(app: &AppHandle) {
    if supervised_time_parser_disabled() {
        log::info!("Supervised local time parser service is disabled for this session");
        return;
    }

    log_ignored_dev_api_overrides();

    if time_parser_health_check() {
        log::info!("Local time parser service is already healthy");
        return;
    }

    let Some(entrypoint) = find_time_parser_entrypoint(app) else {
        log::warn!("Local time parser API build was not found; run `npm --prefix api run build` to enable supervised startup");
        return;
    };

    let state = app.state::<TimeParserServiceState>();
    let mut child_slot = match state.child.lock() {
        Ok(child_slot) => child_slot,
        Err(e) => {
            log::error!("Failed to lock parser service state: {e}");
            return;
        }
    };

    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(None) => return,
            Ok(Some(status)) => log::warn!("Previous local time parser service exited: {status}"),
            Err(e) => log::warn!("Failed to inspect previous parser service process: {e}"),
        }
        *child_slot = None;
    }

    let api_root = api_root_for_entrypoint(&entrypoint);
    let api_key = match time_parser_api_key(app, false) {
        Ok(api_key) => api_key,
        Err(e) => {
            log::warn!("Failed to prepare local parser API key: {e}");
            return;
        }
    };
    let node_command = find_time_parser_node(app);
    let (stdout, stderr) = time_parser_log_stdio(app);
    let mut command = Command::new(child_process_path(&node_command));
    command
        .arg(child_process_path(&entrypoint))
        .current_dir(child_process_path(&api_root))
        .env("PORT", TIME_PARSER_PORT.to_string())
        .env("STATIC_API_KEY", &api_key)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);

    apply_optional_api_env(&mut command);

    if let Some(db_path) = time_parser_db_path(app) {
        command.env("DB_PATH", db_path);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    match command.spawn() {
        Ok(child) => {
            log::info!("Started local time parser service from {entrypoint:?} using {api_root:?}");
            *child_slot = Some(child);
            let app_handle = app.clone();
            std::thread::spawn(move || {
                for _ in 0..40 {
                    if time_parser_health_check() {
                        log::info!("Local time parser service became healthy");
                        let _ = app_handle.emit("time-parser-service-ready", ());
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                log::warn!("Local time parser service did not become healthy before timeout");
            });
        }
        Err(e) => {
            log::warn!("Failed to start local time parser service: {e}");
        }
    }
}

#[tauri::command]
async fn get_time_parser_config(app: AppHandle) -> Result<TimeParserServiceConfig, String> {
    let state = app.state::<TimeParserServiceState>();
    let mut supervised = parser_child_is_running(&state)?;
    let mut available = time_parser_health_check_blocking().await?;

    if !available && !supervised && !supervised_time_parser_disabled() {
        start_time_parser_service(&app);
        supervised = parser_child_is_running(&state)?;
        available = time_parser_health_check_blocking().await?;
    }

    let api_key = time_parser_api_key(&app, false)?;

    let message = if available {
        "Local time parser service is available.".to_string()
    } else if supervised {
        "The local time parser service is still starting. Try again in a moment.".to_string()
    } else {
        "HammerOverlay could not start the local time parser service. Local fallback parsing remains available.".to_string()
    };

    Ok(TimeParserServiceConfig {
        base_url: state.base_url.clone(),
        api_key,
        available,
        supervised,
        message,
    })
}

#[tauri::command]
async fn parse_time_with_local_service(
    app: AppHandle,
    request: NativeTimeParserRequest,
) -> Result<NativeTimeParserResponse, String> {
    if !time_parser_health_check_blocking().await? && !supervised_time_parser_disabled() {
        start_time_parser_service(&app);
        if !wait_for_time_parser_service_blocking(Duration::from_secs(8)).await? {
            return Err("The local time parser service is still starting.".to_string());
        }
    }

    let api_keys = time_parser_api_key_candidates(&app)?;
    let mut body = serde_json::Map::new();
    body.insert("text".to_string(), serde_json::Value::String(request.text));
    body.insert("tz".to_string(), serde_json::Value::String(request.tz));
    if let Some(now) = request.now {
        body.insert("now".to_string(), serde_json::Value::String(now));
    }
    if let Some(features) = request.features {
        body.insert("features".to_string(), features);
    }
    let body_text = serde_json::to_string(&body)
        .map_err(|e| format!("Failed to serialize parser request: {e}"))?;

    let mut last_response = None;
    for api_key in api_keys {
        let response = local_time_parser_request_blocking(
            "POST".to_string(),
            "/parse".to_string(),
            api_key,
            Some(body_text.clone()),
            Duration::from_secs(60),
        )
        .await?;
        if response.status != 401 {
            return Ok(response);
        }
        last_response = Some(response);
    }

    last_response.ok_or_else(|| "No parser API key candidates were available.".to_string())
}

fn parser_child_is_running(state: &TimeParserServiceState) -> Result<bool, String> {
    let mut child_slot = state
        .child
        .lock()
        .map_err(|e| format!("Failed to lock parser service state: {e}"))?;

    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(None) => Ok(true),
            Ok(Some(status)) => {
                log::warn!("Local time parser service exited: {status}");
                *child_slot = None;
                Ok(false)
            }
            Err(e) => {
                log::warn!("Failed to inspect parser service process: {e}");
                Ok(false)
            }
        }
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn init_stats_db(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn get_format_stats(_app: AppHandle) -> Result<FormatStats, String> {
    Ok(FormatStats {
        d: 0,
        long_date: 0,
        t: 0,
        long_time: 0,
        f: 0,
        long_date_time: 0,
        relative_time: 0,
    })
}

#[tauri::command]
async fn increment_format_usage(_app: AppHandle, format: String) -> Result<(), String> {
    println!("Incrementing usage for format: {format}");
    Ok(())
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    log::debug!("Loading app settings");

    // Create store with manager and path
    let store = tauri_plugin_store::StoreBuilder::new(&app, "settings.json")
        .build()
        .map_err(|e| {
            log::error!("Failed to build settings store: {e}");
            e.to_string()
        })?;

    // Try to reload the store from disk first
    store
        .reload()
        .map_err(|e| {
            log::warn!("Failed to reload store from disk (this is normal on first run): {e}");
            e.to_string()
        })
        .ok();

    let settings = if let Some(settings_value) = store.get("settings") {
        match serde_json::from_value(settings_value.clone()) {
            Ok(settings) => {
                log::debug!("Successfully loaded settings from store");
                settings
            }
            Err(e) => {
                log::warn!("Failed to parse settings, using defaults: {e}");
                AppSettings::default()
            }
        }
    } else {
        log::info!("No settings found, using defaults");
        AppSettings::default()
    };

    Ok(settings)
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    log::info!("Saving app settings");

    // Create store with manager and path
    let store = tauri_plugin_store::StoreBuilder::new(&app, "settings.json")
        .build()
        .map_err(|e| {
            log::error!("Failed to build settings store: {e}");
            e.to_string()
        })?;

    let settings_value = serde_json::to_value(&settings).map_err(|e| {
        log::error!("Failed to serialize settings: {e}");
        e.to_string()
    })?;

    // Use set method with proper error handling
    store.set("settings".to_string(), settings_value);

    // Explicitly save the store
    store.save().map_err(|e| {
        log::error!("Failed to save settings to disk: {e}");
        e.to_string()
    })?;

    log::info!("Settings saved successfully");
    Ok(())
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<bool, String> {
    log::info!("Checking for updates");

    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                log::info!("Update available: {}", update.version);
                Ok(true)
            }
            Ok(None) => {
                log::info!("No updates available");
                Ok(false)
            }
            Err(e) => {
                log::error!("Error checking for updates: {e}");
                Err(format!("Failed to check for updates: {e}"))
            }
        },
        Err(e) => {
            log::error!("Updater not available: {e}");
            Err(format!("Updater not available: {e}"))
        }
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                match update
                    .download_and_install(|_chunk_length, _content_length| {}, || {})
                    .await
                {
                    Ok(_) => {
                        log::info!("Update installed successfully");
                        Ok(())
                    }
                    Err(e) => {
                        log::error!("Error installing update: {e}");
                        Err(format!("Failed to install update: {e}"))
                    }
                }
            }
            Ok(None) => {
                log::info!("No update available to install");
                Err("No update available".to_string())
            }
            Err(e) => {
                log::error!("Error checking for update: {e}");
                Err(format!("Failed to check for update: {e}"))
            }
        },
        Err(e) => Err(format!("Updater not available: {e}")),
    }
}

#[tauri::command]
async fn toggle_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    let autostart_manager = app.autolaunch();

    if enable {
        log::info!("Enabling auto-start");

        // In development, this might fail because the executable path is different
        if cfg!(debug_assertions) {
            log::warn!("Auto-start may not work correctly in development mode");
        }

        // Don't fail the entire operation if auto-start fails
        match autostart_manager.enable() {
            Ok(_) => {
                log::info!("Auto-start enabled successfully");
            }
            Err(e) => {
                log::error!("Failed to enable auto-start: {e}");
                // Don't return error, just log it
                // This is common in development and shouldn't break settings save
            }
        }
    } else {
        log::info!("Disabling auto-start");
        autostart_manager.disable().map_err(|e| {
            log::error!("Failed to disable auto-start: {e}");
            e.to_string()
        })?;
        log::info!("Auto-start disabled successfully");
    }

    Ok(())
}

#[tauri::command]
async fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    let autostart_manager = app.autolaunch();
    autostart_manager.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn reload_global_shortcuts(app: AppHandle) -> Result<(), String> {
    log::info!("Reloading global shortcuts");

    // Get the latest settings
    let settings = get_settings(app.clone()).await?;

    // Unregister all current shortcuts
    if let Err(e) = app.global_shortcut().unregister_all() {
        log::warn!("Failed to unregister shortcuts: {e}");
    }

    // Re-register with new hotkey
    use tauri_plugin_global_shortcut::ShortcutState;

    let hotkey = settings.global_hotkey;
    log::info!("Registering new hotkey: {hotkey}");

    match app
        .global_shortcut()
        .on_shortcut(hotkey.as_str(), move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                log::debug!("Global shortcut activated: {_shortcut}");
                show_main_window(app);
            }
        }) {
        Ok(_) => {
            log::info!("Successfully registered global shortcut: {hotkey}");
            Ok(())
        }
        Err(e) => {
            log::error!("Failed to register hotkey '{hotkey}': {e}");
            // Try default as fallback
            app.global_shortcut()
                .on_shortcut("ctrl+shift+h", move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_main_window(app);
                    }
                })
                .map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

#[tauri::command]
async fn debug_store_location(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let mut debug_info = String::new();

    // Get various app directories
    if let Ok(app_data) = app.path().app_data_dir() {
        debug_info.push_str(&format!("AppData: {app_data:?}\n"));
    }

    if let Ok(app_local_data) = app.path().app_local_data_dir() {
        debug_info.push_str(&format!("AppLocalData: {app_local_data:?}\n"));
    }

    if let Ok(app_config) = app.path().app_config_dir() {
        debug_info.push_str(&format!("AppConfig: {app_config:?}\n"));
    }

    // Try to get the actual store path
    let _store = StoreBuilder::new(&app, "settings.json")
        .build()
        .map_err(|e| format!("Failed to build store: {e}"))?;

    // Get store path using the path method if available
    debug_info.push_str(
        "\nStore file should be in one of the above directories with filename: settings.json",
    );

    Ok(debug_info)
}

fn create_system_tray_menu(app: &AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let show_item = MenuItemBuilder::with_id("show", "Show HammerOverlay")
        .enabled(true)
        .build(app)?;
    let settings_item = MenuItemBuilder::with_id("settings", "Settings")
        .enabled(true)
        .build(app)?;
    let check_updates_item = MenuItemBuilder::with_id("check_updates", "Check for Updates")
        .enabled(true)
        .build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit")
        .enabled(true)
        .build(app)?;

    MenuBuilder::new(app)
        .item(&show_item)
        .item(&settings_item)
        .item(&check_updates_item)
        .item(&quit_item)
        .build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
        let _ = window.center();
        let _ = window.emit("show-overlay-view", ());
    }
}

fn setup_system_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Setting up system tray");

    let menu = create_system_tray_menu(app)?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("HammerOverlay - Discord Timestamp Converter")
        .on_menu_event(|app, event| {
            log::debug!("System tray menu event: {}", event.id.as_ref());

            match event.id.as_ref() {
                "show" => {
                    log::info!("Show window requested from system tray");
                    show_main_window(app);
                }
                "settings" => {
                    log::info!("Settings requested from system tray");

                    // Check if settings window already exists
                    if let Some(settings_window) = app.get_webview_window("settings") {
                        // If it exists, just show and focus it
                        let _ = settings_window.show();
                        let _ = settings_window.set_focus();
                    } else {
                        // Create a new settings window
                        match tauri::WebviewWindowBuilder::new(
                            app,
                            "settings",
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .title("HammerOverlay Settings")
                        .inner_size(500.0, 400.0) // Start with reasonable height
                        .resizable(false)
                        .decorations(false) // No title bar
                        .always_on_top(true) // Keep on top like main window
                        .center()
                        .build()
                        {
                            Ok(window) => {
                                // Emit event to the new window to show settings
                                let _ = window.emit("show-settings-view", ());
                            }
                            Err(e) => {
                                log::error!("Failed to create settings window: {e}");
                            }
                        }
                    }
                }
                "check_updates" => {
                    log::info!("Update check requested from system tray");

                    // Check if update checker window already exists
                    if let Some(update_window) = app.get_webview_window("updater") {
                        // If it exists, just show and focus it
                        let _ = update_window.show();
                        let _ = update_window.set_focus();
                    } else {
                        // Create a new update checker window
                        match tauri::WebviewWindowBuilder::new(
                            app,
                            "updater",
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .title("Check for Updates")
                        .inner_size(400.0, 300.0) // Smaller window for update checker
                        .resizable(false)
                        .decorations(false) // No title bar
                        .always_on_top(true)
                        .center()
                        .build()
                        {
                            Ok(window) => {
                                // Emit event to the new window to show update checker
                                let _ = window.emit("show-update-checker-view", ());
                            }
                            Err(e) => {
                                log::error!("Failed to create update checker window: {e}");
                            }
                        }
                    }
                }
                "quit" => {
                    log::info!("Application exit requested from system tray");
                    app.exit(0);
                }
                _ => {
                    log::warn!("Unknown system tray menu event: {}", event.id.as_ref());
                }
            }
        })
        .build(app)?;

    log::info!("System tray setup completed");
    Ok(())
}

fn setup_global_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::ShortcutState;

    log::info!("Setting up global shortcuts");

    // Load user settings to get the preferred hotkey
    let app_handle = app.clone();
    let settings_result = tauri::async_runtime::block_on(async { get_settings(app_handle).await });

    let hotkey = match settings_result {
        Ok(settings) => settings.global_hotkey,
        Err(e) => {
            log::warn!("Failed to load settings for hotkey, using default: {e}");
            "ctrl+shift+h".to_string()
        }
    };

    log::info!("Attempting to register hotkey: {hotkey}");

    let plugin_result = (|| -> Result<_, Box<dyn std::error::Error>> {
        let plugin = tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts([hotkey.as_str()])?
            .with_handler(|app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    log::debug!("Global shortcut activated: {_shortcut}");
                    show_main_window(app);
                }
            })
            .build();

        app.plugin(plugin)?;
        Ok(())
    })();

    match plugin_result {
        Ok(_) => {
            log::info!("Successfully registered global shortcut: {hotkey}");
        }
        Err(e) => {
            log::error!("Failed to register hotkey '{hotkey}': {e}");

            // Try default hotkey as fallback
            if hotkey != "ctrl+shift+h" {
                log::info!("Attempting to register default hotkey as fallback");
                let fallback_plugin = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["ctrl+shift+h"])?
                    .with_handler(|app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            log::debug!("Global shortcut activated: {_shortcut}");
                            show_main_window(app);
                        }
                    })
                    .build();

                app.plugin(fallback_plugin)?;
                log::info!("Successfully registered fallback hotkey: ctrl+shift+h");
            }
        }
    }

    log::info!("Global shortcuts setup completed");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Check for single instance
    let instance = SingleInstance::new("hammer-overlay-app").unwrap();
    if !instance.is_single() {
        log::warn!("Another instance of HammerOverlay is already running");
        eprintln!("HammerOverlay is already running!");

        // Try to show the existing instance window
        // This would require implementing inter-process communication
        // For now, just exit gracefully
        std::process::exit(1);
    }

    log::info!("Single instance check passed");

    tauri::Builder::default()
        .manage(TimeParserServiceState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            init_stats_db,
            get_format_stats,
            increment_format_usage,
            get_settings,
            save_settings,
            check_for_updates,
            install_update,
            toggle_autostart,
            is_autostart_enabled,
            reload_global_shortcuts,
            debug_store_location,
            get_time_parser_config,
            parse_time_with_local_service,
        ])
        .setup(|app| {
            // Initialize logging
            log::info!("HammerOverlay starting up...");
            log::info!("Application version: {}", env!("CARGO_PKG_VERSION"));

            // Set up system tray
            if let Err(e) = setup_system_tray(app.handle()) {
                log::error!("Failed to setup system tray: {e}");
                eprintln!("Failed to setup system tray: {e}");
            }

            // Set up global shortcuts
            if let Err(e) = setup_global_shortcuts(app.handle()) {
                log::error!("Failed to setup global shortcuts: {e}");
                eprintln!("Failed to setup global shortcuts: {e}");
            }

            start_time_parser_service(app.handle());

            // Initialize auto-start based on user settings
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(settings) = get_settings(app_handle.clone()).await {
                    if settings.auto_start {
                        if let Err(e) = toggle_autostart(app_handle, true).await {
                            log::warn!("Failed to enable auto-start: {e}");
                        } else {
                            log::info!("Auto-start enabled based on user settings");
                        }
                    }
                }
            });

            // Single instance check completed during app initialization
            log::debug!("Single instance enforcement active");

            // Hide window by default (start in system tray)
            if let Some(window) = app.get_webview_window("main") {
                log::info!("Hiding main window on startup");
                let _ = window.hide();
            } else {
                log::warn!("Main window not found during startup");
            }

            log::info!("HammerOverlay startup completed successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
