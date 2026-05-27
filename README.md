# HammerOverlay

A desktop overlay application for quickly converting natural language time expressions into Discord timestamp formats.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up the local parser API:**
   Create `api/.env` if you want agent-assisted parsing locally:
   ```
   OPENAI_API_KEY=your-openai-api-key-here
   ```

   The desktop build runs a bundled local API sidecar and generates a per-install local API key. OpenAI keys are not embedded in the frontend bundle.

3. **Run in development mode:**
   ```bash
   npm run tauri dev
   ```

4. **Build for production:**
   ```bash
   npm run tauri build
   ```

## Usage

- **Global Hotkey:** Press `Ctrl+Shift+H` to open the overlay
- **Input:** Type a natural language time expression (e.g., "tomorrow at 2pm", "next Friday")
- **Navigate:** Use ↑/↓ arrows to see all 7 Discord timestamp formats
- **Copy:** Press Enter to copy the selected format to clipboard
- **Close:** Press Escape to close the overlay

## Discord Timestamp Formats

- **:d** - Short Date (07/05/2025)
- **:D** - Long Date (July 5, 2025)  
- **:t** - Short Time (9:30 AM)
- **:T** - Long Time (9:30:00 AM)
- **:f** - Short Date/Time (July 5, 2025 9:30 AM)
- **:F** - Long Date/Time (Saturday, July 5, 2025 9:30 AM)
- **:R** - Relative Time (in 2 hours)

## Features

- **Agent-assisted parsing** through the bundled local API sidecar
- **Fallback parser** using chrono-node when LLM fails
- **Usage statistics** tracking in local SQLite database
- **Smart suggestions** based on your most-used formats
- **Global hotkey** support
- **Clipboard integration** for seamless workflow

## Architecture

- **Frontend:** React + TypeScript + Vite
- **Backend:** Rust + Tauri plus bundled local Node API sidecar
- **Database:** SQLite for usage statistics
- **Parsing:** LangGraph/OpenAI agent path when configured, optional plan-IR experiments, and chrono-node fallback
- **Clipboard:** Tauri clipboard plugin

## License

MIT License
