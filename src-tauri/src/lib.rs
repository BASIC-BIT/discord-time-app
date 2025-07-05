// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

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

// Register global hotkey with callback
#[tauri::command]
async fn register_global_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    
    let shortcut = hotkey.parse::<Shortcut>()
        .map_err(|e| format!("Invalid shortcut format: {}", e))?;
    
    // Register the shortcut with callback
    match app.global_shortcut().register(shortcut) {
        Ok(_) => {
            println!("Successfully registered hotkey: {}", hotkey);
            Ok(())
        }
        Err(e) => {
            println!("Failed to register hotkey {}: {}", hotkey, e);
            Err(format!("Failed to register shortcut: {}", e))
        }
    }
}

// Register hotkey with callback that shows the window
fn register_hotkey_with_callback(app: AppHandle, hotkey: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    
    let shortcut = hotkey.parse::<Shortcut>()
        .map_err(|e| format!("Invalid shortcut format: {}", e))?;
    
    // Register the shortcut
    app.global_shortcut().register(shortcut)
        .map_err(|e| format!("Failed to register shortcut: {}", e))?;
    
    println!("Successfully registered hotkey: {}", hotkey);
    Ok(())
}

// Try to register hotkey with fallback options
async fn try_register_hotkey(app: AppHandle) -> Result<String, String> {
    let hotkeys = vec![
        "Ctrl+Shift+H",
        "Ctrl+Alt+H", 
        "Ctrl+Shift+T",
        "Ctrl+Alt+T",
        "Alt+Shift+H",
    ];
    
    for hotkey in hotkeys {
        match register_hotkey_with_callback(app.clone(), hotkey) {
            Ok(_) => {
                println!("Successfully registered hotkey: {}", hotkey);
                return Ok(hotkey.to_string());
            }
            Err(e) => {
                println!("Failed to register {}: {}", hotkey, e);
                continue;
            }
        }
    }
    
    Err("Could not register any hotkey".to_string())
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            // Try to register a global hotkey with fallback options
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match try_register_hotkey(app_handle).await {
                    Ok(hotkey) => {
                        println!("Application ready with hotkey: {}", hotkey);
                        println!("Note: Hotkey registered but callback may not work - you can manually open the window");
                    }
                    Err(e) => {
                        println!("Warning: No hotkey registered - {}", e);
                        println!("You can still use the application by opening it manually");
                    }
                }
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
