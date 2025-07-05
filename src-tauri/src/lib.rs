// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            init_stats_db,
            get_format_stats,
            increment_format_usage,
        ])
        .setup(|app| {
            // Register global shortcut plugin with handler
            use tauri_plugin_global_shortcut::ShortcutState;
            
            let shortcuts = ["ctrl+shift+h", "ctrl+alt+h", "ctrl+shift+t", "ctrl+alt+t", "alt+shift+h"];
            
            // Try to register shortcuts with handler
            for shortcut in &shortcuts {
                // Build the plugin using the exact pattern from the documentation
                let plugin_result = (|| -> Result<_, Box<dyn std::error::Error>> {
                    let plugin = tauri_plugin_global_shortcut::Builder::new()
                        .with_shortcuts([*shortcut])?
                        .with_handler(|app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                    let _ = window.set_always_on_top(true);
                                    let _ = window.center();
                                }
                            }
                        })
                        .build();
                    
                    app.handle().plugin(plugin)?;
                    Ok(())
                })();
                
                match plugin_result {
                    Ok(_) => {
                        println!("Successfully registered global shortcut: {}", shortcut);
                        break;
                    }
                    Err(e) => {
                        println!("Failed to register {}: {}", shortcut, e);
                        continue;
                    }
                }
            }
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
