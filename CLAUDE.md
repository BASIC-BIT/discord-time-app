# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Guidelines

- **Never commit code before testing**: Always ensure changes work through automated testing, test scripts, or manual verification before committing
- **No Claude Code signatures in commits**: Don't add "Generated with Claude Code" or similar signatures to commit messages
- **Update this file when needed**: When discovering important patterns, conventions, or guidelines while working on the codebase, add them to this file for future Claude instances

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

## Windows Process Management

To kill the app on Windows, use PowerShell:
```powershell
powershell -Command "Stop-Process -Name 'hammer-overlay' -Force"
```

DO NOT use `taskkill /F /IM` - it doesn't work correctly in this environment.

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

## Window Auto-Resize Best Practices

### Problem Solved
Dynamic popup windows (Settings, UpdateChecker) had timing issues with auto-resize on first render, leading to:
- Windows starting too small and taking time to scale up
- Fragile timing hacks using `requestAnimationFrame` + `setTimeout`
- Inconsistent behavior between first render and subsequent updates

### Solution: ResizeObserver + useLayoutEffect Pattern

```typescript
import { useLayoutEffect } from 'react';

useLayoutEffect(() => {
  const window = getCurrentWindow();
  if (window.label !== 'target-window') return;
  
  const container = document.querySelector('.content-container');
  if (!container) return;
  
  const resizeWindow = () => {
    const contentHeight = container.scrollHeight;
    const finalHeight = Math.max(minHeight, Math.min(contentHeight + padding, maxHeight));
    window.setSize(new LogicalSize(width, finalHeight)).catch(console.error);
  };
  
  // Immediate resize for first render
  resizeWindow();
  
  // Set up ResizeObserver for future content changes
  const resizeObserver = new ResizeObserver(() => {
    resizeWindow();
  });
  
  resizeObserver.observe(container);
  
  // Cleanup observer
  return () => {
    resizeObserver.disconnect();
  };
}, [stateVariablesThatAffectContent]);
```

### Key Principles
1. **Use `useLayoutEffect`** - Runs synchronously after DOM mutations but before paint, preventing flicker
2. **Use `ResizeObserver`** - Browser-native API for detecting content size changes
3. **Immediate + Continuous** - Resize immediately on first render, then observe for changes
4. **Proper Cleanup** - Always disconnect ResizeObserver to prevent memory leaks
5. **Apply Selectively** - Only use for dynamic popup windows, not fixed-size overlays

### When to Apply
- ✅ Settings windows with dynamic content
- ✅ Update checkers with changing states  
- ✅ Any popup with varying content height
- ❌ Fixed-size overlay windows (main app)
- ❌ Windows with `resizable: false` by design

## Important Files

- `docs/PROGRESS.md`: Development history and current status
- `docs/PRODUCTION_DEPLOYMENT.md`: Production checklist
- `scripts/create-test-certificate.ps1`: Test certificate generation

## Development Resources

- Use Context7 to find up to date documentation on libraries when planning or debugging.