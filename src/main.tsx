import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./lib/logger"; // Initialize enhanced logger

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
