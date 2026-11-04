import { useState, useEffect, useLayoutEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

interface UpdateCheckerProps {
  onClose: () => void;
}

interface UpdateStatus {
  currentVersion: string;
  phase: 'idle' | 'checking' | 'upToDate' | 'downloading' | 'ready' | 'installing' | 'failed';
  availableVersion: string | null;
  message: string | null;
  previousAttemptFailed: boolean;
}

function statusText(status: UpdateStatus): string | null {
  switch (status.phase) {
    case 'idle':
      return 'Not checked yet.';
    case 'upToDate':
      return 'You are running the latest version.';
    case 'checking':
      return 'Checking…';
    case 'downloading':
      return `Downloading ${status.availableVersion}…`;
    case 'ready':
      return status.previousAttemptFailed
        ? status.message
        : `${status.availableVersion} is ready. Restart to update.`;
    case 'installing':
      return 'Installing…';
    case 'failed':
      return status.message;
  }
}

export function UpdateChecker({ onClose }: UpdateCheckerProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [fallbackVersion, setFallbackVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      setStatus(await invoke<UpdateStatus>('get_update_status'));
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    getVersion().then(setFallbackVersion).catch(() => {});
    refreshStatus();
  }, []);

  const phase = status?.phase;
  const busy = phase === 'checking' || phase === 'downloading';

  // Poll while a check or download is running
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(refreshStatus, 2000);
    return () => clearInterval(id);
  }, [busy]);

  // Auto-resize window height based on content (only for updater window)
  useLayoutEffect(() => {
    const window = getCurrentWindow();
    // Only resize if this is the updater window
    if (window.label !== 'updater') return;
    
    const container = document.querySelector('.settings-container');
    if (!container) return;
    
    const resizeWindow = () => {
      const contentHeight = container.scrollHeight;
      const finalHeight = contentHeight;
      window.setSize(new LogicalSize(400, finalHeight)).catch(console.error);
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
  }, [status]); // Resize when state changes

  const checkForUpdates = async () => {
    setError(null);
    // Show "Checking…" while the manual cycle runs; polling picks up progress
    setStatus(s => (s ? { ...s, phase: 'checking' } : s));
    try {
      setStatus(await invoke<UpdateStatus>('check_for_updates_now'));
    } catch (err) {
      setError(String(err));
      refreshStatus();
    }
  };

  const installUpdate = async () => {
    setError(null);
    setStatus(s => (s ? { ...s, phase: 'installing' } : s));
    try {
      // On success the app exits into the installer, so this normally never returns
      await invoke('install_update_now');
    } catch (err) {
      setError(String(err));
      refreshStatus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const installing = phase === 'installing';
  const version = status?.currentVersion ?? fallbackVersion;

  return (
    <div className="settings-container" style={{ width: '400px', maxHeight: '300px' }} onKeyDown={handleKeyDown} tabIndex={-1}>
        <div className="settings-header">
          <h2>Check for Updates</h2>
          <button className="close-button" onClick={onClose} aria-label="Close update checker">
            ×
          </button>
        </div>

        <div className="settings-content">
          <div className="update-info">
            <p>Current version: <strong>{version ?? '…'}</strong></p>
            {status && <p>{statusText(status)}</p>}
          </div>
        </div>

        <div className="settings-footer">
          <button
            className="cancel-button"
            onClick={onClose}
            disabled={installing}
          >
            Close
          </button>
          
          {phase === 'ready' ? (
            <button
              className="save-button"
              onClick={installUpdate}
            >
              Restart to update
            </button>
          ) : (
            <button
              className="save-button"
              onClick={checkForUpdates}
              disabled={!status || busy || installing}
            >
              Check for Updates
            </button>
          )}
        </div>

        {/* Toast Messages */}
        {error && (
          <div className="toast toast-error">
            {error}
          </div>
        )}
    </div>
  );
}
