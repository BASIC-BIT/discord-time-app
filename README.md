# HammerOverlay

A desktop overlay application for quickly converting natural language time expressions into Discord timestamp formats.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up your OpenAI API key:**
   Create a `.env` file in the root directory:
   ```
   VITE_OPENAI_API_KEY=your-openai-api-key-here
   ```
   
   **⚠️ Security Note**: The API key will be embedded in the built application. Only use your personal API key. For production deployment, consider hosting a backend API to proxy requests and keep the key server-side.

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

- **LLM-powered parsing** with OpenAI GPT-4o-mini
- **Fallback parser** using chrono-node when LLM fails
- **Usage statistics** tracking in local SQLite database
- **Smart suggestions** based on your most-used formats
- **Global hotkey** support
- **Clipboard integration** for seamless workflow

## Architecture

- **Frontend:** React + TypeScript + Vite
- **Backend:** Rust + Tauri
- **Database:** SQLite for usage statistics
- **Parsing:** OpenAI API + chrono-node fallback
- **Clipboard:** Tauri clipboard plugin

## License

MIT License
