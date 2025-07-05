# HammerTime Overlay - Development Progress

## Project Overview
Building a Windows desktop application that converts natural language time expressions into Discord timestamp formats using a global hotkey. The app uses Tauri + React + TypeScript with OpenAI GPT-4o-mini for intelligent parsing.

## Implementation Timeline

### Phase 1: Project Setup ✅
- **Scaffolding**: Created Tauri + React + TypeScript project using `npm create tauri-app`
- **Dependencies Added**:
  - Frontend: `openai`, `chrono-node`, `@tauri-apps/plugin-*` packages
  - Backend: `tauri-plugin-global-shortcut`, `tauri-plugin-sql`, `tauri-plugin-clipboard-manager`
- **Architecture**: Established clean separation between frontend (React components) and backend (Rust Tauri commands)

### Phase 2: Core Frontend Implementation ✅
- **`src/lib/formats.ts`**: 7 Discord timestamp formats (:d, :D, :t, :T, :f, :F, :R) with formatting functions
- **`src/lib/parse.ts`**: Fallback parsing using chrono-node library
- **`src/lib/prompt.ts`**: OpenAI GPT-4o-mini integration with system prompts
- **`src/lib/stats.ts`**: SQLite usage statistics tracking (stubbed for MVP)
- **`src/components/Row.tsx`**: Individual timestamp format display with copy functionality
- **`src/components/Overlay.tsx`**: Main overlay window with input, parsing, navigation, and keyboard shortcuts
- **`src/App.tsx`**: Application wrapper with window management
- **`src/App.css`**: Dark theme styling for overlay interface

### Phase 3: Backend Implementation ✅
- **`src-tauri/src/lib.rs`**: Tauri commands for database operations and global shortcuts
- **`src-tauri/tauri.conf.json`**: Window configuration (480x350, borderless, always on top, no decorations)
- **`src-tauri/Cargo.toml`**: Dependencies for plugins
- **Global Shortcuts**: Implemented using `tauri-plugin-global-shortcut` with fallback shortcuts
- **Permissions**: Added all required permissions in `src-tauri/capabilities/default.json`

### Phase 4: Issues Resolved ✅

#### 1. **Permissions Configuration** ✅
- **Issue**: Missing permissions for window operations and clipboard access
- **Solution**: Added comprehensive permissions to `src-tauri/capabilities/default.json`:
  - `core:window:allow-set-always-on-top`
  - `core:window:allow-hide`, `core:window:allow-show`
  - `core:window:allow-set-focus`, `core:window:allow-center`
  - `clipboard-manager:allow-read-text`, `clipboard-manager:allow-write-text`

#### 2. **Window Management** ✅
- **Issue**: Window was closing instead of hiding, breaking global shortcuts
- **Solution**: Changed from `window.close()` to `window.hide()` to keep app running

#### 3. **Window Sizing and Layout** ✅
- **Issue**: White boundary around overlay content, mismatched window and content sizes
- **Solution**: 
  - Adjusted window size to 480x350 to match content
  - Made overlay fill entire window (100% width/height)
  - Removed centering and padding that created white space
  - Added flex layout for proper content distribution

#### 4. **Code Cleanup** ✅
- **Issue**: Accumulated debugging code and unused functions from troubleshooting
- **Solution**: 
  - Removed all debug console.log statements
  - Removed unused Tauri commands (`show_overlay`, `hide_overlay`, etc.)
  - Simplified component logic back to essentials
  - Cleaned up comments and unnecessary complexity

## Current Status

### ✅ **Working Features**
- **Global Shortcuts**: `Ctrl+Shift+H` and fallback shortcuts work reliably
- **Window Management**: Overlay shows on shortcut, hides on Esc/Enter
- **Clipboard Integration**: Reads current clipboard on open, copies Discord timestamps
- **Parsing**: Fallback parsing with chrono-node (OpenAI integration ready)
- **UI/UX**: Clean dark theme, keyboard navigation, format selection
- **Layout**: Perfect window sizing with no white boundaries
- **Permissions**: All required permissions properly configured

### Phase 5: Advanced Features Implementation ✅

#### 1. **OpenAI LLM Integration** ✅
- **Issue**: LLMs are bad at date math but good at understanding intent
- **Solution**: Two-stage approach:
  - **Stage 1**: LLM normalizes ambiguous input into clear text (e.g., "tomorrow at 5" → "tomorrow at 5:00 PM")
  - **Stage 2**: chrono-node parses the normalized text with precise date math
- **Environment**: Uses `VITE_OPENAI_API_KEY` environment variable
- **Fallback**: Gracefully falls back to chrono-node if no API key configured

#### 2. **Discord Timestamp Recognition** ✅
- **Feature**: Detects existing Discord timestamps in clipboard
- **Behavior**: When opening with `<t:1234567890:d>` in clipboard, extracts epoch and shows all format alternatives
- **UX**: Auto-expands format list when timestamp detected, no parsing needed

#### 3. **Request Optimization** ✅
- **Debouncing**: 500ms debounce on input to prevent API spam
- **Cancellation**: AbortController cancels previous requests when new ones start
- **Race Condition Prevention**: Multiple abort checks throughout request lifecycle
- **Performance**: Only processes final input, cancels intermediate requests

#### 4. **Enhanced LLM Prompting** ✅
- **Context**: Provides current date/time, timezone, and user's format preferences
- **Examples**: Includes concrete Discord format examples in prompt
- **Intent Mapping**: Clear guidance on when to use each format type
- **Validation**: Robust response validation and error handling

### 🔍 **Current Issues & Improvement Areas**

#### **UI/UX Improvements**
1. **Relative Time Display**: Shows "in X hours" instead of proper "days/months/years" like Discord
2. **Click to Copy**: Remove copy button icon, just click row to copy and close
3. **Window Height**: Expand window to show all formats, remove up/down scrolling
4. **Focus Management**: Auto-close when window loses focus (configurable setting)

#### **LLM & Parsing Issues**  
5. **Date Interpretation**: "2 mondays from now at noon" returned 3 mondays away
6. **Response Speed**: 500ms debounce feels slow, needs optimization
7. **Ambiguous Times**: Should offer multiple interpretations with left/right navigation

#### **Clipboard & Input**
8. **Clipboard Control**: Setting to disable auto-loading clipboard
9. **Input Replacement**: Typing should replace clipboard text, not append
10. **Placeholder Text**: Show clipboard content as placeholder-style text

#### **Configuration System**
11. **Settings Menu**: Need configuration interface for:
    - Global hotkey customization
    - Auto-close on focus loss
    - Clipboard auto-load behavior
    - LLM vs fallback parsing preferences

#### **Security Issues**
12. **🚨 OpenAI API Key Exposure**: Currently the API key is embedded in frontend bundle
    - **Problem**: `VITE_OPENAI_API_KEY` gets compiled into the frontend, visible to all users
    - **Risk**: Anyone can extract the key from the built application and abuse it
    - **Current Status**: Documented but not yet fixed (MVP uses user's own API key)
    - **Future Solution**: Host backend API that proxies OpenAI requests with server-side key
    - **Temporary Mitigation**: Users must provide their own API keys (current approach)

### 📝 **Implementation Notes**
- **Window Lifecycle**: App stays running in background, window shows/hides on demand
- **State Management**: Overlay component unmounts/remounts for clean state reset
- **Permissions**: All Tauri capabilities properly configured for security
- **Architecture**: Clean separation between UI logic and system integration
- **LLM Flow**: Intent normalization → precise parsing → format suggestion

## Technical Architecture

### Frontend (React + TypeScript)
```
src/
├── components/
│   ├── Overlay.tsx      # Main overlay UI with input and format selection
│   └── Row.tsx          # Individual timestamp format display
├── lib/
│   ├── formats.ts       # Discord timestamp format definitions
│   ├── parse.ts         # Fallback parsing with chrono-node
│   ├── prompt.ts        # OpenAI integration and prompts
│   └── stats.ts         # Database interaction stubs
├── App.tsx              # Main application wrapper
└── App.css              # Dark theme styling
```

### Backend (Rust + Tauri)
```
src-tauri/
├── src/
│   └── lib.rs           # Tauri commands and global shortcut handling
├── capabilities/
│   └── default.json     # Security permissions configuration
├── tauri.conf.json      # Window configuration and settings
└── Cargo.toml           # Rust dependencies
```

### Key Technologies
- **UI Framework**: React 18.3.1 with TypeScript
- **Desktop Framework**: Tauri 2.6.2
- **Global Shortcuts**: `tauri-plugin-global-shortcut`
- **Database**: `tauri-plugin-sql` with SQLite
- **Clipboard**: `tauri-plugin-clipboard-manager`
- **AI Processing**: OpenAI GPT-4o-mini via `openai` npm package
- **Fallback Parser**: `chrono-node` for offline parsing

## Development Commands
```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cp env.example .env
# Edit .env with your actual values (especially OPENAI_API_KEY)

# 3. Run in development mode
npm run tauri dev

# 4. Build for production
npm run tauri build

# 5. Run frontend only (for UI testing)
npm run dev
```

## Configuration Files
- **`tauri.conf.json`**: Window settings (480x350), permissions, build configuration
- **`package.json`**: Frontend dependencies and scripts
- **`Cargo.toml`**: Rust dependencies and build settings
- **`src-tauri/capabilities/default.json`**: Security permissions
- **`env.example`**: Environment variables template (copy to `.env` and configure)
- **`.env`**: Environment variables (create from `env.example`, not in version control)

---

**Status**: ✅ **Advanced MVP Complete with LLM Integration**
**Next Steps**: Polish UI/UX, add configuration system, implement settings menu 