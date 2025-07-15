import { useState, useEffect, useLayoutEffect, useRef } from 'react';
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
  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load settings on component mount
  useEffect(() => {
    loadSettings();
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  // Auto-resize window height based on content (only for settings window)
  useLayoutEffect(() => {
    const window = getCurrentWindow();
    // Only resize if this is the settings window
    if (window.label !== 'settings') return;
    
    const container = document.querySelector('.settings-container');
    if (!container) return;
    
    const resizeWindow = () => {
      const contentHeight = container.scrollHeight;
      const finalHeight = contentHeight;
      window.setSize(new LogicalSize(500, finalHeight)).catch(console.error);
    };
    
    // Immediate resize for first render
    resizeWindow();
    
    // Set up ResizeObserver for future content changes
    const resizeObserver = new ResizeObserver(() => {
      resizeWindow();
    });
    
    resizeObserver.observe(container);
    
    // Cleanup observer
    return () => {
      resizeObserver.disconnect();
    };
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
      
      // Clear any existing timeout
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      
      setSuccess('Settings saved successfully!');
      successTimeoutRef.current = setTimeout(() => setSuccess(null), 3000);
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
      <div className="settings-container" onKeyDown={handleKeyDown} tabIndex={-1}>
        <div className="loading">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="settings-container" onKeyDown={handleKeyDown} tabIndex={-1}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="settings-content">
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

        {/* Toast Messages */}
        {success && (
          <div className="toast toast-success">
            {success}
          </div>
        )}
        {error && (
          <div className="toast toast-error">
            {error}
          </div>
        )}
    </div>
  );
} 