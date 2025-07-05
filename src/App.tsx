import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Overlay } from "./components/Overlay";
import "./App.css";

function App() {
  const [showOverlay, setShowOverlay] = useState(true);
  const appWindow = getCurrentWindow();

  const handleClose = async () => {
    try {
      // First hide the overlay component
      setShowOverlay(false);
      
      // Then hide the window
      console.log("Hiding window...");
      await appWindow.hide();
      console.log("Window hidden successfully");
    } catch (error) {
      console.error("Error hiding window:", error);
    }
  };

  useEffect(() => {
    // Set up window properties for overlay behavior
    const setupWindow = async () => {
      try {
        // Make window always on top
        await appWindow.setAlwaysOnTop(true);
        
        // Focus the window
        await appWindow.setFocus();
      } catch (error) {
        console.error("Error setting up window:", error);
      }
    };

    setupWindow();

    // Listen for window focus changes to show overlay when window is shown
    const unlistenFocus = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        console.log("Window gained focus, showing overlay");
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
