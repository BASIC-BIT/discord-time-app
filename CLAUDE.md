# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HammerOverlay is a Windows desktop application that converts natural language time expressions into Discord timestamp formats. Built with Tauri (Rust backend) + React (TypeScript frontend).

## Development Commands

```bash
# Development mode with hot reload
npm run start
# or
npm run tauri dev

# Production build
npm run tauri build

# Frontend-only development
npm run dev

# Preview production build
npm run preview
```

## Architecture

### Frontend (src/)
- **Main Components**: 
  - `App.tsx`: Main application with overlay functionality
  - `components/Overlay.tsx`: Core UI for time conversion
  - `components/Row.tsx`: Individual timestamp format display
  - `components/Settings.tsx`: Settings management
  - `components/UpdateChecker.tsx`: Auto-update UI

- **Key Libraries** (src/lib/):
  - `formats.ts`: Discord timestamp format definitions
  - `parsing.ts`: OpenAI integration for NLP parsing
  - `prompts.ts`: GPT prompts for time parsing
  - `discordTimestamps.ts`: Discord timestamp generation

### Backend (src-tauri/)
- `src/lib.rs`: Tauri commands and window management
- `tauri.conf.json`: Window configuration (borderless, always-on-top, 480px width)
- Uses plugins: global-shortcut, clipboard-manager, sql, store, updater

### API Server (api/)
- Separate backend service for secure OpenAI API calls
- Fastify-based with TypeScript
- SQLite database for usage tracking
- Docker deployment ready

## Critical Security Issue

⚠️ **The frontend currently makes direct OpenAI API calls** exposing the API key in the client bundle. The backend API has been implemented but NOT integrated. Priority fix needed.

## Key Features

1. **Global Hotkey**: Ctrl+Shift+H activates overlay
2. **Time Parsing**: OpenAI GPT-4o-mini with chrono-node fallback
3. **Discord Formats**: 7 timestamp formats (t, T, d, D, f, F, R)
4. **System Tray**: Minimize to tray, auto-start option
5. **Auto-Updates**: Built-in update checking
6. **Single Instance**: Prevents multiple app instances

## Testing & Linting

Currently no test framework is implemented. No linting commands are configured in package.json.

## CI/CD (GitHub Actions)

- **Build Workflow**: Triggered on push/PR, creates debug builds
- **Release Workflow**: Triggered on version tags (v*), handles code signing and releases

## Environment Setup

1. Create `.env` file:
   ```
   VITE_OPENAI_API_KEY=your-key-here
   ```

2. For development code signing:
   ```powershell
   ./scripts/create-test-certificate.ps1
   ```

## Window State

The app maintains window position/size in Tauri store. The overlay is:
- Borderless and always-on-top
- 480px wide
- Transparent background
- Draggable via title bar

## State Management

- Settings stored in Tauri store plugin
- Usage statistics in SQLite database
- Window state persisted between sessions

## Important Files

- `docs/PROGRESS.md`: Development history and current status
- `docs/PRODUCTION_DEPLOYMENT.md`: Production checklist
- `scripts/create-test-certificate.ps1`: Test certificate generation

## Development Resources

- Use Context7 to find up to date documentation on libraries when planning or debugging.