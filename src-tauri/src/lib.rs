// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};

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

// Initialize the stats database
#[tauri::command]
async fn init_stats_db(_app: AppHandle) -> Result<(), String> {
    // For now, just return success - we'll implement proper database initialization later
    Ok(())
}

// Get format usage statistics
#[tauri::command]
async fn get_format_stats(_app: AppHandle) -> Result<FormatStats, String> {
    // Return default stats for now - we'll implement proper database queries later
    Ok(FormatStats {
        d: 0, D: 0, t: 0, T: 0, f: 0, F: 0, R: 0,
    })
}

// Increment format usage count
#[tauri::command]
async fn increment_format_usage(_app: AppHandle, format: String) -> Result<(), String> {
    // For now, just return success - we'll implement proper database updates later
    println!("Incrementing usage for format: {}", format);
    Ok(())
}

// Register global hotkey (simplified version)
#[tauri::command]
async fn register_global_hotkey(_app: AppHandle, hotkey: String) -> Result<(), String> {
    // For now, just return success - global shortcuts are stubbed out
    println!("Would register hotkey: {}", hotkey);
    Ok(())
}



// Show overlay window
#[tauri::command]
async fn show_overlay(window: Window) -> Result<(), String> {
    window.show().map_err(|e| format!("Failed to show window: {}", e))?;
    window.set_focus().map_err(|e| format!("Failed to focus window: {}", e))?;
    Ok(())
}

// Hide overlay window
#[tauri::command]
async fn hide_overlay(window: Window) -> Result<(), String> {
    window.hide().map_err(|e| format!("Failed to hide window: {}", e))?;
    Ok(())
}

// Close overlay window
#[tauri::command]
async fn close_overlay(window: Window) -> Result<(), String> {
    window.close().map_err(|e| format!("Failed to close window: {}", e))?;
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
            register_global_hotkey,
            show_overlay,
            hide_overlay,
            close_overlay
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
                                // Show the overlay window
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                    let _ = window.set_always_on_top(true);
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
