import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

  const handleClose = async () => {
    try {
      setShowOverlay(false);
      await appWindow.hide();
    } catch (error) {
      console.error("Error hiding window:", error);
    }
  };

  const handleSettingsClose = () => {
    setShowSettings(false);
  };

  const handleShowSettings = () => {
    setShowSettings(true);
    setShowOverlay(false);
  };

  const handleUpdateCheckerClose = () => {
    setShowUpdateChecker(false);
  };

  const handleShowUpdateChecker = () => {
    setShowUpdateChecker(true);
    setShowOverlay(false);
  };

  useEffect(() => {
    const setupWindow = async () => {
      try {
        await appWindow.setAlwaysOnTop(true);
        await appWindow.setFocus();
      } catch (error) {
        console.error("Error setting up window:", error);
      }
    };

    setupWindow();

    const unlistenFocus = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        setShowOverlay(true);
      }
    });

    // Listen for settings events from system tray
    const unlistenSettings = listen('show-settings', () => {
      handleShowSettings();
    });

    // Listen for update checker events from system tray
    const unlistenUpdateChecker = listen('show-update-checker', () => {
      handleShowUpdateChecker();
    });

    return () => {
      unlistenFocus.then(fn => fn());
      unlistenSettings.then(fn => fn());
      unlistenUpdateChecker.then(fn => fn());
    };
  }, []);

  return (
    <div className="app">
      {showOverlay && <Overlay onClose={handleClose} />}
      {showSettings && <Settings onClose={handleSettingsClose} />}
      {showUpdateChecker && <UpdateChecker onClose={handleUpdateCheckerClose} />}
    </div>
  );
}

export default App;
