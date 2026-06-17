import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

interface AppSettings {
  auto_start: boolean;
  global_hotkey: string;
  auto_close_on_focus_loss: boolean;
  auto_load_clipboard: boolean;
  use_llm_parsing: boolean;
  deterministic_preflight: boolean;
  theme: string; // "dark", "light", "system"
  local_slm_enabled: boolean;
  local_slm_auto_start: boolean;
  local_slm_prewarm: boolean;
  local_slm_endpoint_base_url: string;
  local_slm_model: string;
  local_slm_launcher_path: string;
  local_slm_adapter_path: string;
  local_slm_docker_image: string;
  local_slm_startup_timeout_seconds: number;
}

interface LocalSlmStatus {
  enabled: boolean;
  autoStart: boolean;
  ready: boolean;
  state: string;
  message: string;
  endpointBaseUrl: string;
  model: string;
  adapterPath: string;
  installRoot?: string;
  runtimeInstalled: boolean;
  adapterInstalled: boolean;
  dockerAvailable: boolean;
  dockerImage: string;
  dockerImageInstalled: boolean;
  adapterPackageUrl?: string;
  launcherPath?: string;
  lastOutput?: string;
}

const defaultSettings: AppSettings = {
  auto_start: false,
  global_hotkey: "ctrl+shift+h",
  auto_close_on_focus_loss: false,
  auto_load_clipboard: true,
  use_llm_parsing: true,
  deterministic_preflight: false,
  theme: "dark",
  local_slm_enabled: false,
  local_slm_auto_start: false,
  local_slm_prewarm: true,
  local_slm_endpoint_base_url: "http://127.0.0.1:8765/v1",
  local_slm_model: "qwen-temporal-ir-qwen35-bf16-chat-time-range-2687",
  local_slm_launcher_path: "",
  local_slm_adapter_path: "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora",
  local_slm_docker_image: "ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8",
  local_slm_startup_timeout_seconds: 360,
};

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [persistedSettings, setPersistedSettings] = useState<AppSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [slmBusy, setSlmBusy] = useState(false);
  const [slmStatus, setSlmStatus] = useState<LocalSlmStatus | null>(null);
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
  }, [loading, error, success, slmStatus, slmBusy]); // Resize when any state changes

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loadedSettings = await invoke<AppSettings>('get_settings');
      setSettings(loadedSettings);
      setPersistedSettings(loadedSettings);
      await refreshSlmStatus();
    } catch (err) {
      console.error('Failed to load settings:', err);
      setError('Failed to load settings. Using defaults.');
    } finally {
      setLoading(false);
    }
  };

  const refreshSlmStatus = async () => {
    try {
      const status = await invoke<LocalSlmStatus>('get_local_slm_status');
      setSlmStatus(status);
      return status;
    } catch (err) {
      console.error('Failed to load Local SLM status:', err);
      setSlmStatus({
        enabled: settings.local_slm_enabled,
        autoStart: settings.local_slm_auto_start,
        ready: false,
        state: 'unknown',
        message: 'Could not read Local SLM status.',
        endpointBaseUrl: settings.local_slm_endpoint_base_url,
        model: settings.local_slm_model,
        adapterPath: settings.local_slm_adapter_path,
        runtimeInstalled: false,
        adapterInstalled: false,
        dockerAvailable: false,
        dockerImage: settings.local_slm_docker_image,
        dockerImageInstalled: false,
      });
      return null;
    }
  };

  const runSlmAction = async (command: string, genericError: string) => {
    try {
      setSlmBusy(true);
      setError(null);
      const status = await invoke<LocalSlmStatus>(command);
      setSlmStatus(status);
      const loadedSettings = await invoke<AppSettings>('get_settings');
      setSettings(loadedSettings);
      setPersistedSettings(loadedSettings);
      if (status.state === 'failed') {
        setError(status.message);
      }
      return status;
    } catch (err) {
      console.error(`${command} failed:`, err);
      setError(genericError);
      return null;
    } finally {
      setSlmBusy(false);
    }
  };

  const installRuntimeFiles = async () => {
    await runSlmAction('install_local_slm_runtime_files', 'Failed to install Local SLM runtime files.');
  };

  const downloadLocalSlmModel = async () => {
    await runSlmAction('download_local_slm_model', 'Failed to download Local SLM model package.');
  };

  const pullDockerImage = async () => {
    await runSlmAction('pull_local_slm_docker_image', 'Failed to pull Local SLM Docker image.');
  };

  const startLocalSlm = async () => {
    try {
      setSlmBusy(true);
      setError(null);
      const status = await invoke<LocalSlmStatus>('start_local_slm');
      setSlmStatus(status);
      if (status.state === 'failed') {
        setError(status.message);
      }
    } catch (err) {
      console.error('Failed to start Local SLM:', err);
      setError('Failed to start Local SLM. Check Docker and model runtime settings.');
    } finally {
      setSlmBusy(false);
    }
  };

  const stopLocalSlm = async () => {
    try {
      setSlmBusy(true);
      setError(null);
      const status = await invoke<LocalSlmStatus>('stop_local_slm');
      setSlmStatus(status);
    } catch (err) {
      console.error('Failed to stop Local SLM:', err);
      setError('Failed to stop Local SLM.');
    } finally {
      setSlmBusy(false);
    }
  };

  const localSlmParserSettingsChanged = (nextSettings: AppSettings) => {
    return (
      persistedSettings.local_slm_enabled !== nextSettings.local_slm_enabled ||
      persistedSettings.local_slm_endpoint_base_url !== nextSettings.local_slm_endpoint_base_url ||
      persistedSettings.local_slm_model !== nextSettings.local_slm_model
    );
  };

  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(persistedSettings);
  const slmActionDisabled = slmBusy || settingsDirty;

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      const shouldRestartParser = localSlmParserSettingsChanged(settings);
      
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
      if (shouldRestartParser) {
        await invoke('restart_time_parser_service').catch((parserError) => {
          console.warn('Parser restart failed after Local SLM settings save:', parserError);
        });
      }
      setPersistedSettings(settings);
      const status = await refreshSlmStatus();
      if (settings.local_slm_enabled && settings.local_slm_auto_start && status?.state !== 'ready') {
        void startLocalSlm();
      }
      
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

  const handleSettingChange = (key: keyof AppSettings, value: boolean | string | number) => {
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
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.deterministic_preflight}
                onChange={(e) => handleSettingChange('deterministic_preflight', e.target.checked)}
              />
              <span>Run deterministic preflight before AI parsing</span>
            </label>
          </div>

          <div className="setting-group local-slm-group">
            <h3>Local SLM Runtime</h3>
            <p className="setting-help">
              The local small language model proposes Temporal Plan-IR. HammerOverlay still validates and executes timestamps deterministically. Runtime files install into app data; the model package and Docker image are installed separately.
            </p>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.local_slm_enabled}
                onChange={(e) => handleSettingChange('local_slm_enabled', e.target.checked)}
              />
              <span>Enable local SLM parsing</span>
            </label>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.local_slm_auto_start}
                disabled={!settings.local_slm_enabled}
                onChange={(e) => handleSettingChange('local_slm_auto_start', e.target.checked)}
              />
              <span>Start the Local SLM automatically with HammerOverlay</span>
            </label>
            <label className="setting-item">
              <input
                type="checkbox"
                checked={settings.local_slm_prewarm}
                disabled={!settings.local_slm_enabled}
                onChange={(e) => handleSettingChange('local_slm_prewarm', e.target.checked)}
              />
              <span>Warm the model when the overlay opens</span>
            </label>
            <div className="setting-item setting-item-column">
              <label htmlFor="local-slm-endpoint">Endpoint:</label>
              <input
                type="text"
                id="local-slm-endpoint"
                value={settings.local_slm_endpoint_base_url}
                onChange={(e) => handleSettingChange('local_slm_endpoint_base_url', e.target.value)}
                className="wide-input"
                placeholder="http://127.0.0.1:8765/v1"
              />
            </div>
            <div className="setting-item setting-item-column">
              <label htmlFor="local-slm-model">Model:</label>
              <input
                type="text"
                id="local-slm-model"
                value={settings.local_slm_model}
                onChange={(e) => handleSettingChange('local_slm_model', e.target.value)}
                className="wide-input"
              />
            </div>
            <div className="setting-item setting-item-column">
              <label htmlFor="local-slm-launcher">Launcher script:</label>
              <input
                type="text"
                id="local-slm-launcher"
                value={settings.local_slm_launcher_path}
                onChange={(e) => handleSettingChange('local_slm_launcher_path', e.target.value)}
                className="wide-input"
                placeholder="Path to scripts/start-temporal-peft-server.ps1"
              />
              <p className="setting-help setting-help-compact">
                Use Install Runtime Files to prepare an app-data launcher for installed builds.
              </p>
            </div>
            <div className="setting-item setting-item-column">
              <label htmlFor="local-slm-adapter">Adapter path:</label>
              <input
                type="text"
                id="local-slm-adapter"
                value={settings.local_slm_adapter_path}
                onChange={(e) => handleSettingChange('local_slm_adapter_path', e.target.value)}
                className="wide-input"
              />
            </div>
            <div className="setting-item setting-item-column">
              <label htmlFor="local-slm-docker-image">Docker image:</label>
              <input
                type="text"
                id="local-slm-docker-image"
                value={settings.local_slm_docker_image}
                onChange={(e) => handleSettingChange('local_slm_docker_image', e.target.value)}
                className="wide-input"
              />
            </div>
            <div className="setting-item setting-item-column">
              <label htmlFor="local-slm-timeout">Startup timeout seconds:</label>
              <input
                type="number"
                id="local-slm-timeout"
                min="30"
                max="900"
                value={settings.local_slm_startup_timeout_seconds}
                onChange={(e) => handleSettingChange('local_slm_startup_timeout_seconds', Number(e.target.value))}
                className="number-input"
              />
            </div>
            <div className={`local-slm-status local-slm-status-${slmStatus?.state ?? 'unknown'}`}>
              <div>
                <strong>Status:</strong> {slmStatus?.state ?? 'unknown'}
              </div>
              <div>{slmStatus?.message ?? 'Status has not loaded yet.'}</div>
              {slmStatus?.installRoot && <div className="local-slm-detail">Install root: {slmStatus.installRoot}</div>}
              {slmStatus?.launcherPath && <div className="local-slm-detail">Launcher: {slmStatus.launcherPath}</div>}
              {slmStatus?.adapterPath && <div className="local-slm-detail">Adapter: {slmStatus.adapterPath}</div>}
              {slmStatus?.dockerImage && <div className="local-slm-detail">Docker image: {slmStatus.dockerImage}</div>}
              {slmStatus && (
                <div className="local-slm-checks">
                  <span className={slmStatus.runtimeInstalled ? 'local-slm-check-ok' : 'local-slm-check-missing'}>Runtime files: {slmStatus.runtimeInstalled ? 'installed' : 'missing'}</span>
                  <span className={slmStatus.adapterInstalled ? 'local-slm-check-ok' : 'local-slm-check-missing'}>Model: {slmStatus.adapterInstalled ? 'installed' : 'missing'}</span>
                  <span className={slmStatus.dockerAvailable ? 'local-slm-check-ok' : 'local-slm-check-missing'}>Docker: {slmStatus.dockerAvailable ? 'available' : 'missing'}</span>
                  <span className={slmStatus.dockerImageInstalled ? 'local-slm-check-ok' : 'local-slm-check-missing'}>Image: {slmStatus.dockerImageInstalled ? 'installed' : 'missing'}</span>
                </div>
              )}
              {settingsDirty && (
                <div className="local-slm-detail">Save settings before installing, pulling, or starting so those actions use the values shown here.</div>
              )}
            </div>
            <div className="local-slm-actions">
              <button className="secondary-button" onClick={() => void refreshSlmStatus()} disabled={slmBusy}>
                Refresh
              </button>
              <button className="secondary-button" onClick={installRuntimeFiles} disabled={slmActionDisabled}>
                Install Runtime Files
              </button>
              <button className="secondary-button" onClick={downloadLocalSlmModel} disabled={slmActionDisabled || !slmStatus?.adapterPackageUrl}>
                Download Model
              </button>
              <button className="secondary-button" onClick={pullDockerImage} disabled={slmActionDisabled || !settings.local_slm_docker_image}>
                Pull Docker Image
              </button>
              <button className="secondary-button" onClick={startLocalSlm} disabled={slmActionDisabled || !settings.local_slm_enabled}>
                {slmBusy ? 'Working...' : 'Start Local SLM'}
              </button>
              <button className="secondary-button" onClick={stopLocalSlm} disabled={slmBusy}>
                Stop
              </button>
            </div>
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
