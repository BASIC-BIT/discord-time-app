// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Emitter, menu::{MenuBuilder, MenuItemBuilder}, tray::TrayIconBuilder};
use tauri_plugin_store::{StoreExt, StoreBuilder};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use single_instance::SingleInstance;

#[derive(Debug, Serialize, Deserialize)]
pub struct FormatStats {
    pub d: u32,
    pub D: u32,
    pub t: u32,
    pub T: u32,
    pub f: u32,
    pub F: u32,
    pub R: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppSettings {
    pub auto_start: bool,
    pub global_hotkey: String,
    pub auto_close_on_focus_loss: bool,
    pub auto_load_clipboard: bool,
    pub use_llm_parsing: bool,
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
            theme: "dark".to_string(),
        }
    }
}

#[tauri::command]
async fn init_stats_db(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn get_format_stats(_app: AppHandle) -> Result<FormatStats, String> {
    Ok(FormatStats {
        d: 0, D: 0, t: 0, T: 0, f: 0, F: 0, R: 0,
    })
}

#[tauri::command]
async fn increment_format_usage(_app: AppHandle, format: String) -> Result<(), String> {
    println!("Incrementing usage for format: {}", format);
    Ok(())
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    log::debug!("Loading app settings");
    
    // Create store with explicit path builder
    let store = tauri_plugin_store::StoreBuilder::new("settings.json")
        .build(app.handle())
        .map_err(|e| {
            log::error!("Failed to build settings store: {}", e);
            e.to_string()
        })?;
    
    // Try to load the store from disk first
    store.load().map_err(|e| {
        log::warn!("Failed to load store from disk (this is normal on first run): {}", e);
        e.to_string()
    }).ok();
    
    let settings = if let Some(settings_value) = store.get("settings") {
        match serde_json::from_value(settings_value.clone()) {
            Ok(settings) => {
                log::debug!("Successfully loaded settings from store");
                settings
            }
            Err(e) => {
                log::warn!("Failed to parse settings, using defaults: {}", e);
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
    
    // Create store with explicit path builder
    let store = tauri_plugin_store::StoreBuilder::new("settings.json")
        .build(app.handle())
        .map_err(|e| {
            log::error!("Failed to build settings store: {}", e);
            e.to_string()
        })?;
    
    let settings_value = serde_json::to_value(&settings).map_err(|e| {
        log::error!("Failed to serialize settings: {}", e);
        e.to_string()
    })?;
    
    // Use set method with proper error handling
    store.set("settings".to_string(), settings_value);
    
    // Explicitly save the store
    store.save().map_err(|e| {
        log::error!("Failed to save settings to disk: {}", e);
        e.to_string()
    })?;
    
    log::info!("Settings saved successfully");
    Ok(())
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<bool, String> {
    log::info!("Checking for updates");
    
    match app.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    log::info!("Update available: {}", update.version);
                    Ok(true)
                }
                Ok(None) => {
                    log::info!("No updates available");
                    Ok(false)
                }
                Err(e) => {
                    log::error!("Error checking for updates: {}", e);
                    Err(format!("Failed to check for updates: {}", e))
                }
            }
        }
        Err(e) => {
            log::error!("Updater not available: {}", e);
            Err(format!("Updater not available: {}", e))
        }
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    match app.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    match update.download_and_install(
                        |_chunk_length, _content_length| {},
                        || {}
                    ).await {
                        Ok(_) => {
                            log::info!("Update installed successfully");
                            Ok(())
                        }
                        Err(e) => {
                            log::error!("Error installing update: {}", e);
                            Err(format!("Failed to install update: {}", e))
                        }
                    }
                }
                Ok(None) => {
                    log::info!("No update available to install");
                    Err("No update available".to_string())
                }
                Err(e) => {
                    log::error!("Error checking for update: {}", e);
                    Err(format!("Failed to check for update: {}", e))
                }
            }
        }
        Err(e) => Err(format!("Updater not available: {}", e)),
    }
}

#[tauri::command]
async fn toggle_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    let autostart_manager = app.autolaunch();
    
    if enable {
        log::info!("Enabling auto-start");
        autostart_manager.enable().map_err(|e| {
            log::error!("Failed to enable auto-start: {}", e);
            e.to_string()
        })?;
        log::info!("Auto-start enabled successfully");
    } else {
        log::info!("Disabling auto-start");
        autostart_manager.disable().map_err(|e| {
            log::error!("Failed to disable auto-start: {}", e);
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
async fn debug_store_location(app: AppHandle) -> Result<String, String> {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    
    let mut debug_info = String::new();
    
    // Get various app directories
    if let Ok(app_data) = app.path().app_data_dir() {
        debug_info.push_str(&format!("AppData: {:?}\n", app_data));
    }
    
    if let Ok(app_local_data) = app.path().app_local_data_dir() {
        debug_info.push_str(&format!("AppLocalData: {:?}\n", app_local_data));
    }
    
    if let Ok(app_config) = app.path().app_config_dir() {
        debug_info.push_str(&format!("AppConfig: {:?}\n", app_config));
    }
    
    // Try to get the actual store path
    let store = StoreBuilder::new("settings.json")
        .build(app.handle())
        .map_err(|e| format!("Failed to build store: {}", e))?;
    
    // Get store path using the path method if available
    debug_info.push_str("\nStore file should be in one of the above directories with filename: settings.json");
    
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
                    show_main_window(app);
                    let _ = app.emit("show-settings", ());
                }
                "check_updates" => {
                    log::info!("Update check requested from system tray");
                    show_main_window(app);
                    let _ = app.emit("show-update-checker", ());
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
    let settings_result = tauri::async_runtime::block_on(async {
        get_settings(app_handle).await
    });
    
    let hotkey = match settings_result {
        Ok(settings) => settings.global_hotkey,
        Err(e) => {
            log::warn!("Failed to load settings for hotkey, using default: {}", e);
            "ctrl+shift+h".to_string()
        }
    };
    
    log::info!("Attempting to register hotkey: {}", hotkey);
    
    let plugin_result = (|| -> Result<_, Box<dyn std::error::Error>> {
        let plugin = tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts([&hotkey])?
            .with_handler(|app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    log::debug!("Global shortcut activated: {}", _shortcut);
                    show_main_window(app);
                }
            })
            .build();
        
        app.plugin(plugin)?;
        Ok(())
    })();
    
    match plugin_result {
        Ok(_) => {
            log::info!("Successfully registered global shortcut: {}", hotkey);
        }
        Err(e) => {
            log::error!("Failed to register hotkey '{}': {}", hotkey, e);
            
            // Try default hotkey as fallback
            if hotkey != "ctrl+shift+h" {
                log::info!("Attempting to register default hotkey as fallback");
                let fallback_plugin = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["ctrl+shift+h"])?
                    .with_handler(|app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            log::debug!("Global shortcut activated: {}", _shortcut);
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
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
            debug_store_location,
        ])
        .setup(|app| {
            // Initialize logging
            log::info!("HammerOverlay starting up...");
            log::info!("Application version: {}", env!("CARGO_PKG_VERSION"));
            
            // Set up system tray
            if let Err(e) = setup_system_tray(app.handle()) {
                log::error!("Failed to setup system tray: {}", e);
                eprintln!("Failed to setup system tray: {}", e);
            }
            
            // Set up global shortcuts
            if let Err(e) = setup_global_shortcuts(app.handle()) {
                log::error!("Failed to setup global shortcuts: {}", e);
                eprintln!("Failed to setup global shortcuts: {}", e);
            }
            
            // Initialize auto-start based on user settings
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(settings) = get_settings(app_handle.clone()).await {
                    if settings.auto_start {
                        if let Err(e) = toggle_autostart(app_handle, true).await {
                            log::warn!("Failed to enable auto-start: {}", e);
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
