import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Overlay } from "./components/Overlay";
import "./App.css";

function App() {
  const [showOverlay, setShowOverlay] = useState(true);
  const appWindow = getCurrentWindow();

  const handleClose = async () => {
    try {
      setShowOverlay(false);
      await appWindow.hide();
    } catch (error) {
      console.error("Error hiding window:", error);
    }
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

    return () => {
      unlistenFocus.then(fn => fn());
    };
  }, []);

  return (
    <div className="app">
      {showOverlay && <Overlay onClose={handleClose} />}
    </div>
  );
}

export default App;
