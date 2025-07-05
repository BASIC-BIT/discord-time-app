import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Overlay } from "./components/Overlay";
import "./App.css";

function App() {
  const [showOverlay, setShowOverlay] = useState(true);
  const appWindow = getCurrentWindow();

  const handleClose = async () => {
    setShowOverlay(false);
    await appWindow.close();
  };

  useEffect(() => {
    // Set up window properties for overlay behavior
    const setupWindow = async () => {
      try {
        // Make window always on top
        await appWindow.setAlwaysOnTop(true);
        
        // Set window to be focusable
        await appWindow.setFocusable(true);
        
        // Focus the window
        await appWindow.setFocus();
      } catch (error) {
        console.error("Error setting up window:", error);
      }
    };

    setupWindow();
  }, []);

  return (
    <div className="app">
      {showOverlay && <Overlay onClose={handleClose} />}
    </div>
  );
}

export default App;
