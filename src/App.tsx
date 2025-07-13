import { useState, useEffect } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Overlay } from "./components/Overlay";
import { Settings } from "./components/Settings";
import { UpdateChecker } from "./components/UpdateChecker";
import "./App.css";

function App() {
  const [showOverlay, setShowOverlay] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpdateChecker, setShowUpdateChecker] = useState(false);
  const appWindow = getCurrentWindow();
  const windowLabel = appWindow.label;

  const handleClose = async () => {
    try {
      setShowOverlay(false);
      await appWindow.hide();
    } catch (error) {
      console.error("Error hiding window:", error);
    }
  };

  const handleSettingsClose = async () => {
    // For settings window, just close it
    if (windowLabel === "settings") {
      await appWindow.close();
    } else {
      // For main window, switch back to overlay
      setShowSettings(false);
      setShowOverlay(true);
      await appWindow.setAlwaysOnTop(true);
    }
  };

  const handleShowSettings = () => {
    setShowSettings(true);
    setShowOverlay(false);
  };

  const handleUpdateCheckerClose = async () => {
    // For updater window, just close it
    if (windowLabel === "updater") {
      await appWindow.close();
    } else {
      // For main window, switch back to overlay
      setShowUpdateChecker(false);
      setShowOverlay(true);
    }
  };

  const handleShowUpdateChecker = () => {
    setShowUpdateChecker(true);
    setShowOverlay(false);
  };

  useEffect(() => {
    if (windowLabel === "settings") {
      // This is the settings window
      setShowSettings(true);
      setShowOverlay(false);
      setShowUpdateChecker(false);
      
      // Listen for settings view event
      const unlistenSettingsView = listen('show-settings-view', () => {
        setShowSettings(true);
      });
      
      return () => {
        unlistenSettingsView.then(fn => fn());
      };
    } else if (windowLabel === "updater") {
      // This is the updater window
      setShowUpdateChecker(true);
      setShowOverlay(false);
      setShowSettings(false);
      
      // Listen for update checker view event
      const unlistenUpdateView = listen('show-update-checker-view', () => {
        setShowUpdateChecker(true);
      });
      
      return () => {
        unlistenUpdateView.then(fn => fn());
      };
    } else {
      // This is the main window
      const setupWindow = async () => {
        try {
          await appWindow.setAlwaysOnTop(true);
          await appWindow.setFocus();
        } catch (error) {
          console.error("Error setting up window:", error);
        }
      };

      setupWindow();

      const unlistenFocus = appWindow.onFocusChanged(async ({ payload: focused }) => {
        if (focused) {
          setShowOverlay(true);
          // Reload settings when window gains focus to catch changes from settings window
          try {
            await invoke('reload_global_shortcuts');
          } catch (error) {
            console.error('Failed to reload shortcuts:', error);
          }
        }
      });

      // Listen for update checker events from system tray
      const unlistenUpdateChecker = listen('show-update-checker', () => {
        handleShowUpdateChecker();
      });

      return () => {
        unlistenFocus.then(fn => fn());
        unlistenUpdateChecker.then(fn => fn());
      };
    }
  }, [windowLabel]);

  return (
    <div className="app">
      {showOverlay && <Overlay onClose={handleClose} />}
      {showSettings && <Settings onClose={handleSettingsClose} />}
      {showUpdateChecker && <UpdateChecker onClose={handleUpdateCheckerClose} />}
    </div>
  );
}

export default App;
