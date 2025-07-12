import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface UpdateCheckerProps {
  onClose: () => void;
}

export function UpdateChecker({ onClose }: UpdateCheckerProps) {
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [hasUpdate, setHasUpdate] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const checkForUpdates = async () => {
    try {
      setChecking(true);
      setError(null);
      setSuccess(null);
      
      const updateAvailable = await invoke<boolean>('check_for_updates');
      setHasUpdate(updateAvailable);
      
      if (updateAvailable) {
        setSuccess('Update available! Click "Install Update" to upgrade.');
      } else {
        setSuccess('You are running the latest version.');
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
      setError('Failed to check for updates. Please check your internet connection.');
      setHasUpdate(null);
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    try {
      setInstalling(true);
      setError(null);
      
      await invoke('install_update');
      setSuccess('Update installed successfully! The application will restart.');
      
      // Close the checker after a short delay
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err) {
      console.error('Failed to install update:', err);
      setError('Failed to install update. Please try again or download manually.');
    } finally {
      setInstalling(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="settings-overlay" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="settings-container" style={{ width: '400px', maxHeight: '300px' }}>
        <div className="settings-header">
          <h2>Check for Updates</h2>
          <button className="close-button" onClick={onClose} aria-label="Close update checker">
            ×
          </button>
        </div>

        <div className="settings-content">
          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="update-info">
            <p>Current version: <strong>0.1.0</strong></p>
            
            {hasUpdate === null && (
              <p>Click "Check for Updates" to see if a newer version is available.</p>
            )}
            
            {hasUpdate === false && (
              <p>You are running the latest version of HammerOverlay.</p>
            )}
            
            {hasUpdate === true && (
              <div>
                <p><strong>A new version is available!</strong></p>
                <p>Click "Install Update" to download and install the latest version. The application will restart automatically.</p>
              </div>
            )}
          </div>
        </div>

        <div className="settings-footer">
          <button
            className="cancel-button"
            onClick={onClose}
            disabled={checking || installing}
          >
            Close
          </button>
          
          {hasUpdate === true ? (
            <button
              className="save-button"
              onClick={installUpdate}
              disabled={installing}
            >
              {installing ? 'Installing...' : 'Install Update'}
            </button>
          ) : (
            <button
              className="save-button"
              onClick={checkForUpdates}
              disabled={checking}
            >
              {checking ? 'Checking...' : 'Check for Updates'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
} 