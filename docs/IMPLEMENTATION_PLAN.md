## HammerTime Overlay – Implementation Plan for a Coding‑LLM
### 0. High‑Level Goal (MVP)

Build a **tiny Windows desktop overlay** that:

1. Pops up on a **global hot‑key** (default <kbd>Ctrl + Shift + H</kbd>, user‑configurable).
2. **Pre‑loads** the current clipboard and any active text selection into an editable text box.
3. Sends that text, plus the user’s local timezone and per‑format usage stats, to **OpenAI gpt‑4o‑mini** (timeout ≤ 1 s).
4. Receives `{epoch, suggestedFormatIndex}` and renders **one “best guess”** timestamp row (`<t:…> …`).
   *If the user hits ↑/↓ the UI expands into a seven‑row selector.*
5. **Enter** → copy the highlighted `<t:…>` string to the clipboard and close.
   **Esc** → close without copying.
6. **Local SQLite** file records which format was chosen. Next launch, the most‑used format becomes the default.
7. **LLM fallback**: If the OpenAI call errors, parse with `chrono-node` (`en` locale) and pick format 0 (`<t:…:d>`).
8. Clean, human‑readable code; zero external diagnostics (telemetry stubbed behind a feature flag).

The entire flow should compile, package, and run in **≤ 2 hours of human effort**.

---

### 1. Key Tech Stack (+ current versions)

| Layer             | Choice                                | Version                | Reason                                         |
| ----------------- | ------------------------------------- | ---------------------- | ---------------------------------------------- |
| Shell / windowing | **Tauri**                             | CLI & crates **2.6.2** | 10 MB bundle, native overlay, built‑in updater |
| UI lib            | **React**                             | **18.3.1**             | Familiar, easy to swap for Svelte later        |
| Build tool        | **Vite**                              | **7.0.2**              | Fast HMR, React template                       |
| Global shortcuts  | `tauri-plugin-global-shortcut`        | **2.3.0**              | MIT/Apache‑2.0                                 |
| SQLite stats      | `tauri-plugin-sql` (`sqlite` feature) | **2.3.0**              | Same plugin line                               |
| OpenAI client     | `openai` (npm)                        | **5.8.2**              | Browser‑compatible                             |
| Fallback parser   | `chrono-node` (npm)                   | **2.8.3**              | 60 KB gzipped                                  |

All dependencies are MIT‑compatible; license the project **MIT**.

---

### 2. Project Bootstrap (10 min)

```bash
# 1. Scaffold
pnpm create tauri-app hammer-overlay
cd hammer-overlay
# Choose: React + TypeScript template

# 2. JS deps
pnpm add openai chrono-node

# 3. Rust side deps
cargo add tauri-plugin-global-shortcut tauri-plugin-sql --features sqlite
```

Create a private `.env` file with `OPENAI_API_KEY=...`; Tauri will bundle it at build.

---

### 3. Directory Layout

```
src/
 ├─ main.tsx          # React entry
 ├─ components/
 │    ├─ Overlay.tsx  # Popup window
 │    └─ Row.tsx      # Timestamp row + copy button
 ├─ lib/
 │    ├─ prompt.ts    # Builds LLM prompt
 │    ├─ formats.ts   # 7 Discord formats
 │    ├─ stats.ts     # SQLite helpers
 │    └─ parse.ts     # Fallback chrono-node
 └─ tauri/
      ├─ main.rs      # Hot‑key, Clipboard, Settings
      └─ updater.rs   # Stub auto‑update
```

Keep React components dumb; business logic lives in `lib/`.

---

### 4. Settings & Storage

```ts
interface Settings {
  hotkey: string;            // "Ctrl+Shift+H"
  autoContext: boolean;      // default true
  telemetry: boolean;        // default false (stub)
  openaiKeyPath: string;     // encrypted file path
}
```

*Store as `settings.json` in `%APPDATA%/HammerOverlay/`.*
**Format stats** table (`sqlite.db`):

```sql
CREATE TABLE IF NOT EXISTS usage (
  format TEXT PRIMARY KEY,
  count  INTEGER DEFAULT 0
);
```

---

### 5. LLM Prompt (lib/prompt.ts)

```
System: “You are a timestamp assistant...”
User:
TEXT: "Thursday at 9"
TIMEZONE: "America/Indianapolis"
FORMAT_STATS_JSON: {"d":42,"D":3,"t":17,"T":8,"f":9,"F":1,"R":5,"raw":0}
RETURN JSON: {epoch:number, suggestedFormatIndex:0-6, confidence:0-1}
```

*We’ll treat `confidence < 0.5` as “low”; in that case don’t auto‑fill—display the input box only.*

---

### 6. React Flow

1. On mount, grab `clipboardReadText()` via Tauri API and send to `<textarea>`.
2. `useEffect` → call `/invoke llm_parse` (bridged to TS) with current text.
3. Render **single row** with suggested format.
4. Key handlers:

   * <kbd>↑</kbd>/<kbd>↓</kbd> → toggle `expanded` state and change selected index.
   * <kbd>Enter</kbd> → `clipboardWriteText(formatString)`, increment usage in SQLite, `window.close()`.
   * <kbd>Esc</kbd> → `window.close()`.

---

### 7. Rust (main.rs)

```rust
#[tauri::command]
fn register_hotkey(hotkey: String) { /* plugin call */ }

#[tauri::command]
async fn llm_parse(input: String, stats: Json<Value>) -> Result<FormatOut> { /* OpenAI or chrono */ }

#[tauri::command]
fn inc_usage(format: String) { /* SQL UPDATE */ }
```

Encrypt the user’s OpenAI key using `tauri::api::crypto::encrypt` and store under `%APPDATA%`.

---

### 8. LLM → TS bridge

*Expose the above commands through `tauri.invoke`.*
Keep error handling loud in dev (`console.error`), silent toast in prod.

---

### 9. Fallback Parsing (lib/parse.ts)

```ts
export function parseFallback(text: string): number | null {
  const ref = chrono.parseDate(text, new Date(), { forwardDate: true });
  return ref ? Math.floor(ref.getTime() / 1000) : null;
}
```

If both LLM *and* fallback return null, show an inline error “Need a fuller date/time”.

---

### 10. Packaging & Updater

`tauri.conf.json`:

```jsonc
{
  "updater": {
    "active": true,
    "endpoints": ["https://github.com/yourUser/hammer-overlay/releases/latest"]
  }
}
```

Run:

```bash
pnpm tauri build --target x86_64-pc-windows-msvc
```

CI (GitHub Actions `windows-latest`, `macos-latest`) runs the same command and uploads builds.

---

### 11. Hour‑Level Task Board

| Time          | Task                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| **0:00–0:10** | Scaffold project & install deps.                                                       |
| **0:10–0:25** | Implement global hot‑key and blank overlay window.                                     |
| **0:25–0:45** | Clipboard read/write + editable textbox.                                               |
| **0:45–1:15** | Implement LLM call & fallback parser.                                                  |
| **1:15–1:35** | React UI: single row, expand on ↑/↓, enter/esc.                                        |
| **1:35–1:50** | SQLite usage stats + default suggestion logic.                                         |
| **1:50–2:00** | Build, smoke‑test, create installer. *(CI config can slip to later if time runs out.)* |

---

### 12. Coding Guidelines for the LLM

1. **Human‑style naming** (`parseInput`, `settingsPath`) and **doc comments**.
2. Keep React components **function‑based** with hooks; avoid class components.
3. Use **async/await**, never naked `.then()` chains.
4. **Prettier** (`pnpm prettier`) and **ESLint React‑Recommended** config baked into the scaffold.
5. Avoid magic numbers; formats live in `formats.ts`:

```ts
export const formats = [
  { code:":d", label:"07/05/2025" },
  { code:":D", label:"July 5, 2025" },
  /* … */
];
```

6. **Early return** on errors; surface friendly error messages to the UI.
7. No additional dependencies unless strictly necessary—keep the bundle lean.

---

### 13. Future (Post‑MVP) Backlog  ❄️  (out of scope for “two‑hour ship”)

* Diagnostics upload + opt‑in/opt‑out UI
* Local LLM (e.g., llama.cpp runner) behind feature flag
* Mac/Linux packaging & notarization
* Multiple hot‑key profiles
* Auto‑paste back into active window (Win32 `SendInput`)
* Theming / CSS variables for dark/light toggle
* Telemetry‑driven default format suggestion powered by the same OpenAI call