import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

interface AppSettings {
  auto_start: boolean;
  global_hotkey: string;
  auto_close_on_focus_loss: boolean;
  auto_load_clipboard: boolean;
  use_llm_parsing: boolean;
  theme: string; // "dark", "light", "system"
}

const defaultSettings: AppSettings = {
  auto_start: false,
  global_hotkey: "ctrl+shift+h",
  auto_close_on_focus_loss: false,
  auto_load_clipboard: true,
  use_llm_parsing: true,
  theme: "dark",
};

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load settings on component mount
  useEffect(() => {
    loadSettings();
  }, []);

  // Auto-resize window height based on content (only for settings window)
  useEffect(() => {
    const window = getCurrentWindow();
    // Only resize if this is the settings window
    if (window.label !== 'settings') return;
    
    const resizeWindow = async () => {
      try {
        // Wait for next frame to ensure DOM is updated
        requestAnimationFrame(() => {
          setTimeout(() => {
            const container = document.querySelector('.settings-container');
            const contentHeight = container ? container.scrollHeight : document.body.scrollHeight;
            // Ensure minimum height and add padding for buttons
            const finalHeight = Math.max(500, Math.min(contentHeight + 40, 800)); // More padding
            window.setSize(new LogicalSize(500, finalHeight)).catch(console.error);
          }, 100);
        });
      } catch (error) {
        console.error('Error resizing settings window:', error);
      }
    };
    
    // Always resize, whether loading or not
    resizeWindow();
  }, [loading, error, success]); // Resize when any state changes

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loadedSettings = await invoke<AppSettings>('get_settings');
      setSettings(loadedSettings);
    } catch (err) {
      console.error('Failed to load settings:', err);
      setError('Failed to load settings. Using defaults.');
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      
      await invoke('save_settings', { settings });
      
      // Handle auto-start toggle (don't fail if this errors in dev mode)
      try {
        await invoke('toggle_autostart', { enable: settings.auto_start });
      } catch (autoStartError) {
        console.warn('Auto-start toggle failed (this is normal in development):', autoStartError);
        // Don't show this error to the user - settings still saved successfully
      }
      
      // Reload global shortcuts with new settings
      await invoke('reload_global_shortcuts');
      
      setSuccess('Settings saved successfully!');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSettingChange = (key: keyof AppSettings, value: boolean | string) => {
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (loading) {
    return (
      <div className="settings-overlay" onKeyDown={handleKeyDown} tabIndex={-1}>
        <div className="settings-container">
          <div className="loading">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-overlay" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="settings-container">
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="settings-content">
          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="setting-group">
            <h3>Startup</h3>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.auto_start}
                onChange={(e) => handleSettingChange('auto_start', e.target.checked)}
              />
              <span>Start HammerOverlay automatically when Windows starts</span>
            </label>
          </div>

          <div className="setting-group">
            <h3>Global Hotkey</h3>
            <div className="setting-item">
              <label htmlFor="hotkey">Hotkey to show overlay:</label>
              <input
                type="text"
                id="hotkey"
                value={settings.global_hotkey}
                onChange={(e) => handleSettingChange('global_hotkey', e.target.value)}
                placeholder="e.g., ctrl+shift+h"
                className="hotkey-input"
              />
            </div>
          </div>

          <div className="setting-group">
            <h3>Behavior</h3>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.auto_close_on_focus_loss}
                onChange={(e) => handleSettingChange('auto_close_on_focus_loss', e.target.checked)}
              />
              <span>Auto-close when overlay loses focus</span>
            </label>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.auto_load_clipboard}
                onChange={(e) => handleSettingChange('auto_load_clipboard', e.target.checked)}
              />
              <span>Automatically load clipboard content when opening</span>
            </label>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.use_llm_parsing}
                onChange={(e) => handleSettingChange('use_llm_parsing', e.target.checked)}
              />
              <span>Use AI parsing for better time understanding</span>
            </label>
          </div>

          <div className="setting-group">
            <h3>Appearance</h3>
            <div className="setting-item">
              <label htmlFor="theme">Theme:</label>
              <select
                id="theme"
                value={settings.theme}
                onChange={(e) => handleSettingChange('theme', e.target.value)}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Use System Default</option>
              </select>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button
            className="cancel-button"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="save-button"
            onClick={saveSettings}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
} 