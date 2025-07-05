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
- **`src-tauri/src/lib.rs`**: Tauri commands for database operations, global shortcuts, window management
- **`src-tauri/tauri.conf.json`**: Window configuration (500x400, transparent, always on top, no decorations)
- **`src-tauri/Cargo.toml`**: Dependencies for plugins
- **Global Shortcuts**: Implemented using `tauri-plugin-global-shortcut` with fallback shortcuts

### Phase 4: Technical Challenges Resolved ✅
1. **Missing pnpm**: Switched to npm for package management
2. **Missing Rust**: User installed Rust toolchain
3. **Cargo dependency syntax**: Fixed `--features sqlite` qualification issue
4. **Missing npm packages**: Added `@tauri-apps/plugin-*` packages for frontend bindings
5. **Port conflicts**: Resolved Vite development server port issues
6. **Rust compilation errors**: 
   - Fixed SQL plugin API usage (simplified to stubs)
   - Corrected global shortcut registration patterns
   - Resolved import and method signature issues
   - Fixed unused variable warnings

## Current Status

### ✅ Working Features
- **Application Compilation**: Builds successfully with minor warnings
- **UI Components**: All React components render correctly
- **Window Management**: Overlay window appears and can be styled
- **Global Shortcut Registration**: Successfully registers shortcuts (Ctrl+Shift+H and fallbacks)
- **Basic Architecture**: Clean separation of concerns implemented

### ❌ Known Issues

#### 1. Window Dismissal Problem
- **Issue**: Once the overlay window appears, it doesn't dismiss properly
- **Impact**: Window stays open, making the app unusable for repeated interactions
- **Likely Cause**: Missing window close logic in keyboard handlers or improper event handling

#### 2. Global Shortcut Re-registration
- **Issue**: Shortcut works once but doesn't trigger again after the first use
- **Impact**: User can't reopen the overlay after closing it
- **Likely Cause**: Shortcut event handler not properly resetting or window state interference

#### 3. Clipboard Copy Functionality
- **Issue**: Copy to clipboard functionality isn't working
- **Impact**: Core feature (copying Discord timestamps) is non-functional
- **Likely Cause**: Missing clipboard write implementation or permission issues

#### 4. OpenAI API Key Configuration
- **Issue**: No mechanism to set up OpenAI API key
- **Impact**: LLM parsing will fail, falling back to chrono-node only
- **Likely Cause**: Missing environment variable handling or user configuration UI

### 🔄 Partially Working
- **Database Operations**: Stubbed but not fully implemented
- **Statistics Tracking**: Interface exists but not connected to actual database
- **Error Handling**: Basic error handling in place but needs refinement

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
├── tauri.conf.json      # Window configuration and permissions
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

## Next Steps Required

### High Priority Fixes
1. **Fix Window Dismissal**
   - Implement proper Escape key handling in `Overlay.tsx`
   - Add window close logic to keyboard event handlers
   - Ensure window properly hides/closes after copy action

2. **Fix Global Shortcut Re-registration**
   - Debug shortcut event handler lifecycle
   - Ensure shortcuts remain active after window operations
   - Add proper event cleanup and re-registration

3. **Implement Clipboard Copy**
   - Complete clipboard write functionality in `Row.tsx`
   - Add proper error handling for clipboard operations
   - Test cross-platform clipboard compatibility

4. **OpenAI API Key Setup**
   - Add environment variable handling for `OPENAI_API_KEY`
   - Implement settings UI for API key configuration
   - Add secure storage for API key

### Medium Priority Enhancements
1. **Database Integration**
   - Implement actual SQLite database operations
   - Add proper statistics tracking
   - Create database schema and migrations

2. **Error Handling**
   - Add comprehensive error handling throughout the app
   - Implement user-friendly error messages
   - Add logging for debugging

3. **Testing & Polish**
   - End-to-end functionality testing
   - Performance optimization
   - UI/UX improvements

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
- **`tauri.conf.json`**: Window settings, permissions, build configuration
- **`package.json`**: Frontend dependencies and scripts
- **`Cargo.toml`**: Rust dependencies and build settings
- **`env.example`**: Environment variables template (copy to `.env` and configure)
- **`.env`**: Environment variables (create from `env.example`, not in version control)

## Known Warnings
- Snake case naming warnings for FormatStats struct fields (cosmetic)
- Unused import warnings (cleaned up in latest version)

---

**Status**: Core functionality implemented but key features need debugging
**Next Session Goal**: Fix window dismissal, clipboard copy, and shortcut re-registration 