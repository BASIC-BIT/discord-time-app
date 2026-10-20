# Desktop Feedback and Manual Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a dependable native Linux feedback loop, then add an inline manual date/time picker for choosing or adjusting Discord timestamps.

**Architecture:** One dependency setup script and one Python native runner exercise the actual Tauri executable, bundled API, X11 interactions, and SQLite. The picker adds a small editor and calendar conversion helper to the existing overlay, preserving its previews and copy flow. Qualify repeatability and add CI after the feature works.

**Tech Stack:** Node 24, React 19, TypeScript, Tauri 2/Rust, WebKitGTK 4.1, Python 3.11+ standard library, Xvfb/Openbox/D-Bus, xdotool/xclip, FFmpeg, and `@js-temporal/polyfill` 0.5.1.

**Spec:** [Linux desktop feedback](../specs/2026-10-20-linux-desktop-feedback-design.md) and [manual picker](../specs/2026-10-20-manual-datetime-picker-design.md), both approved in conversation.

## Global Constraints

- Expose the native command as `npm run test:desktop`; use ignored `artifacts/desktop/` for evidence.
- Do not introduce a testing framework, review service, provider abstraction, dashboard, or automatic retry system.
- Use ordinary system dependency paths; PRoot and a custom relocation layer are outside the maintained v1 design.
- Default to offline tests, fresh application state, and zero model calls. Explicit model mode must report missing configuration as blocked and must not count fallback as model success.
- Keep the existing 480px width, all seven formats, selected format when adjusting a timestamp, and `:f` for a new manual timestamp.
- Use native date/time controls with seconds, device timezone only, explicit handling of gaps/repeated local times, and no date-picker library.
- Manual editing works without the parser API. Parser defaults and semantic interpretation rules do not change.
- Use coding-agent visual review. Describe sampled-frame review accurately; independent model judging is deferred.
- Complete 20 consecutive fresh-state native runs before enforcing CI; ordinary UI development does not require 20 runs.
- Preserve `AGENTS.md`: hotkey prewarm, 5-second parsing SLO, accuracy requirements, and hosted temporal-model maximum `$50/month`. Do not train or provision models for this work.
- Do not open a desktop/runtime PR, merge, or release changes depending on installed behavior before installed Windows MSI smoke evidence exists. Linux evidence cannot satisfy that gate.
- Continue in the existing isolated cloud checkout.

## Review Focus

1. Inherited credentials or checkout `.env` files must not activate providers in offline mode; test environment isolation and launch cwd in Task 2.
2. Cancelling an editor opened during parsing must resume text work, while a late result/error/finalizer after manual apply cannot change the manual result; test Task 6.
3. An existing instant in the repeated daylight-saving hour must survive an unchanged edit, and a changed wall time must invalidate its old offset choice; test Tasks 5 and 6.
4. Calendar popups and keyboard navigation near screen edges or on a short desktop must remain usable without an accidental copy or overlay dismissal; exercise Task 6 and Windows smoke in Task 7.
5. A stalled WebDriver, failed recording, or surviving helper must produce failure evidence and bounded cleanup without killing unrelated processes; test Task 2 and qualify Task 7.

## File map and delivery order

| Files | Responsibility |
| --- | --- |
| `scripts/setup-linux-desktop.sh`, `docs/linux-desktop-testing.md` | Reproducible prerequisites and operating instructions |
| `scripts/desktop_smoke.py`, `scripts/test_desktop_smoke.py` | Owned processes, native scenarios, bounded WebDriver, evidence and runner boundary tests |
| `src-tauri/tauri.linux-test.conf.json` | Linux test build overrides only |
| `vite.config.ts` | Linked CommonJS dependency optimization fix |
| `src/components/Overlay.tsx` | Clipboard fix, manual/text ownership, editor integration and parser cancellation |
| `src/lib/manualDateTime.ts`, `src/lib/manualDateTime.test.ts` | Calendar/epoch conversion and deterministic tests |
| `src/components/ManualDateTimePicker.tsx`, `src/components/Row.tsx`, `src/App.css` | Native editor, result focus, layout and accessibility |
| `package.json`, `package-lock.json` | Commands, direct Temporal dependency and Node test types |
| `.github/workflows/build.yml` | Qualified Linux job beside the existing Windows job |

Task order is 1 → 2 → 3 → 4 → 5 → 6 → 7. Each task ends with a working deliverable and its own commit. The two small product fixes remain separate from the runner and picker commits. Read both specs and `AGENTS.md` before execution.

---

### Task 1: Qualify and document the supported Linux environment

**Files:** Create `scripts/setup-linux-desktop.sh`, `docs/linux-desktop-testing.md`.

**Interfaces:** Script flags `--check` and `--install`; exits `0` when ready and `2` when blocked. Pin Rust `1.99.1` and `tauri-driver` `2.1.0`, the versions used in the spike. Require Node major `24` and Python `3.11+`. Record actual distro/WebKit/FFmpeg versions rather than claiming identical distro packages across environments.

- [ ] **Step 1: Establish the environment failure condition.** Check whether the supported managed-environment setup can install WebKit helpers at their compiled system paths. Inspect readiness and proxy/CA policy through supplied runtime tools and `/etc/codex/network-policy.json` when available. A workspace-only extraction does not qualify. On the current worker, the existing workspace sysroot must not make `--check` pass. Do not change environment publication/access settings implicitly.
- [ ] **Step 2: Implement the setup script.** Resolve the checkout from the script path. Check GTK/WebKit pkg-config packages, `WebKitWebDriver`, `Xvfb`, `openbox`, `dbus-run-session`, `xdotool`, `xclip`, `xdpyinfo`, `xwininfo`, `ffmpeg`, and `ffprobe`, plus the pinned toolchain. `--install` uses supported package installation for `libwebkit2gtk-4.1-dev`, `webkit2gtk-driver`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, X11 utilities and desktop tools. Preserve proxy/CA settings, use writable Cargo/npm caches, and do not repurpose `HOME` or `CODEX_HOME`.
- [ ] **Step 3: Verify the recipe twice.** Run `bash scripts/setup-linux-desktop.sh --install`, then `bash scripts/setup-linux-desktop.sh --check` twice. Expected: ready, pinned executable versions, helper files present at ordinary paths, and no destructive reinstallation. If installation is unavailable, record blocked status and obtain the supported environment setup before claiming native verification. Independent source/test work may continue, but native acceptance remains blocked.
- [ ] **Step 4: Document fresh-task startup and commit.** Include the two commands, the prerequisite gate, where artifacts will live, and platform limits. Do not copy spike paths or onboarding helpers. Commit as `chore: add supported Linux desktop test setup`.

### Task 2: Build the native runner, evidence, and lifecycle checks

**Files:** Create `scripts/desktop_smoke.py`, `scripts/test_desktop_smoke.py`, `src-tauri/tauri.linux-test.conf.json`; modify `package.json`, `docs/linux-desktop-testing.md`.

**Interfaces:** `test:desktop` runs `python3 scripts/desktop_smoke.py`. CLI: `--mode offline|model` defaults to offline, `--suite baseline|picker|all` initially supports baseline, and `--repeat N` defaults to `1`. Repetition is qualification, stops at the first failure, and is offline-only. Exit `0` means assertions and capture passed; `1` means test/capture failure; `2` means environment/configuration blocked. Report visual review separately as pending until the coding agent supplies findings.

Keep helpers in this runner, not a framework. Expose `build_environment(inherited: Mapping[str, str], run_dir: Path, mode: str) -> dict[str, str]` and an owned `DesktopSession` context manager constructed with keyword arguments `run_dir: Path`, `mode: str`, `time_zone: str = "UTC"`, `screen_size: tuple[int, int] = (1280, 900)`, and `disable_api: bool = False`. Later scenarios consume `evaluate(script: str, *args: object) -> object`, `invoke(command: str, args: dict[str, object] | None = None) -> object`, `keys(*keys: str) -> None`, `paste(text: str) -> None`, `clipboard() -> str | None`, and `capture(name: str) -> None` on that session. `paste` supplies the clipboard and Ctrl+V; scenarios explicitly choose selection/clearing. `run_baseline(session: DesktopSession) -> None` raises on assertion failure. Use a simple list of named check results, not a plugin registry.

- [ ] **Step 1: Write failing boundary tests.** In `scripts/test_desktop_smoke.py`, use `unittest` to assert offline provider-variable removal, model-mode credential preservation without logging values, a hung local HTTP request timing out, recording failure preventing success, and cleanup terminating an owned child/grandchild while leaving an unrelated sleeper alive. Use fake fixture processes only for runner boundary tests. Run `python3 -m unittest discover -s scripts -p 'test_desktop_smoke.py' -v`; expect failures until the runner exists.

  Pin the environment contract in `test_offline_env_removes_provider_configuration`:
  ```python
  env = build_environment({"OPENAI_API_KEY": "sentinel-provider-key", "HTTPS_PROXY": "http://proxy:8080"}, run_dir, "offline")
  self.assertNotIn("OPENAI_API_KEY", env)
  self.assertEqual(env["HTTPS_PROXY"], "http://proxy:8080")
  self.assertEqual(env["DOTENV_CONFIG_PATH"], "/dev/null")
  ```
  Name the other tests `test_model_env_preserves_configured_identity_without_logging_secrets`, `test_stalled_webdriver_times_out`, `test_failed_recording_is_not_a_pass`, and `test_cleanup_only_terminates_owned_process_groups`. The cleanup test must check live descendants and resource release, not merely that the immediate parent exited.
- [ ] **Step 2: Implement isolated startup and the real build.** The Linux config contains only `bundle.targets: ["deb"]` and `bundle.createUpdaterArtifacts: false`. Build with `npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.linux-test.conf.json`, reusing `beforeBuildCommand`. Resolve the executable via Cargo metadata's target directory, including `CARGO_TARGET_DIR`. Do not reuse a stale executable. A repeat invocation may build once and use the same identified binary for its fresh-state iterations.
- [ ] **Step 3: Implement owned execution and baseline scenarios.** Create a per-run temporary app state and XDG paths; launch driver/app from that isolated cwd so Rust's development `.env` search cannot read checkout `api/.env`. `DOTENV_CONFIG_PATH=/dev/null` alone is insufficient because Rust also reads env files. Remove inherited parser/frontend/dev overrides in offline mode, disable model/observability paths, use an ephemeral local auth key, and preserve transport settings. Confirm the real API's sanitized readiness reports no provider configured. Use fresh process groups, detect occupied resources, move the pointer off result rows, wait for native hide completion before reopening, and wait for settled geometry instead of copying the spike's fixed sleeps. Readiness budget is 30 seconds, ordinary WebDriver requests 5 seconds, and failure capture 3 seconds. Give an explicit model-parse RPC 30 seconds and record its latency against the 5-second product SLO separately; this transport bound does not introduce a runtime inference cutoff.
- [ ] **Step 4: Cover the baseline assertions and model mode.** Exercise the spike's 11 checks with `<t:1780000000:f>`, exact `:F` clipboard output after Down/Enter, five range rows, malformed input rejection, and the fixed UTC natural-language result `May 28, 2026 at 2 PM` → `1779976800`. Set the test device timezone to UTC. Existing fixture transitions may explicitly clear the input; direct clipboard replacement is not covered until Task 4. Correlate SQLite usage/outcome records with this run's generation IDs; assert zero model calls offline. Explicit model mode additionally requires configured identity, an actual model call and persisted model identity/duration; fallback or absent configuration is not a pass. Use a known model-required row/reference instant from `api/scripts/temporal-live-smoke.ts`, with its exact expected result, rather than a timestamp token that resolves without a model. Reuse existing application configuration, not a new provider layer. Do not invoke a paid run merely to finish this task.
- [ ] **Step 5: Implement evidence and fail-safe cleanup.** Always write `results.json`, `summary.md`, screenshots, a finalized MP4, and sanitized logs under `artifacts/desktop/<run-id>/`. Include commit/dirty state, executable SHA-256, tool versions, parser mode and model coverage. Capture the desktop directly with FFmpeg when WebDriver is unresponsive. Finalize and validate video with `ffprobe`. Give teardown 5 seconds, then terminate remaining owned process groups and report cleanup failure; never reuse or kill arbitrary existing processes. Keep child stdout away from runner pipes so clipboard ownership cannot hold the runner open. Redact known auth/provider values and never archive key/settings files. Capture failure must not mask the original assertion failure.
- [ ] **Step 6: Verify and commit.** Run the boundary tests, then `npm run test:desktop -- --suite baseline`. Expected: 11 checks, readable captures, model coverage explicitly offline, no surviving owned processes/resources. Reproduce the earlier hide/reopen stall with last-command/phase diagnostics; isolate and fix its actual cause in runner, WebKit setup, or app lifecycle as the evidence requires. Do not claim readiness by removing the scenario or extending timeouts. A clipboard regression is added in Task 4. Commit as `test: add native Linux desktop smoke runner`.

### Task 3: Fix cold Vite loading of the shared routing package

**Files:** Modify `vite.config.ts`, `docs/linux-desktop-testing.md`.

**Interfaces:** Preserve shared package exports and production behavior. Add `@hammer-overlay/discord-timestamp-routing` to Vite's `optimizeDeps.include`; do not migrate the package's module system.

- [ ] **Step 1: Reproduce the cold failure.** From an owned native dev session, run `npm run tauri -- dev --no-watch` after clearing only the checkout's generated Vite optimizer cache. Press Ctrl+Shift+H. Preserve the blank overlay and the missing `classifyDiscordTimestampInput` import error. Terminate this session before smoke tests; it shares the app/API resources.
- [ ] **Step 2: Apply the dependency optimization change.** Keep the existing React plugin, Vite port, and production chunk configuration.
- [ ] **Step 3: Verify both paths.** Repeat the cold native dev launch: input is usable and no missing-export error appears. Run `npm run test:routing`, `npm run build`, and the embedded baseline smoke. Expected: routing tests pass and both native dev and embedded UI load. Save the dev screenshot and command outcome in the task evidence.
- [ ] **Step 4: Commit** as `fix: optimize shared routing dependency in Vite dev`.

### Task 4: Fix replacement of auto-imported clipboard text

**Files:** Modify `src/components/Overlay.tsx`, `scripts/desktop_smoke.py`.

**Interfaces:** Keep `handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>): void`. Add `clipboard_replacement` to `run_baseline`; the baseline now has 12 named checks. `paste(text)` must not hide the bug by clearing the field with Backspace first.

- [ ] **Step 1: Add the failing native regression.** Copy a timestamp, dismiss, reopen with clipboard import, select all, and paste `<t:1780000000:t> - <t:1780003600:t>` directly. Assert the complete textarea value and five range rows. Run baseline; expect the current handler to retain only `>`.
- [ ] **Step 2: Fix the event handling at its source.** Accept the actual textarea value and clear the clipboard-origin flag on a real edit. Remove reconstruction from the last character and post-edit selection position. Preserve normal browser select-all replacement, paste, deletion and caret editing; do not add phrase-specific rules.
- [ ] **Step 3: Verify user edit variants.** Assert direct replacement works, typing into selected imported text replaces the selection normally, and deliberate caret editing preserves the surrounding text. Run the 12-check baseline and `npm test`; save the passing replacement capture.
- [ ] **Step 4: Commit** as `fix: preserve complete edits to imported clipboard text`.

### Task 5: Implement exact manual calendar/instant conversion

**Files:** Create `src/lib/manualDateTime.ts`, `src/lib/manualDateTime.test.ts`; modify `package.json`, `package-lock.json`.

**Interfaces:** Declare these exports; all epoch values are integer seconds:

```ts
type ManualDraft = { date: string; time: string; timeZone: string; offset: string | null };
type InstantChoice = { epochSeconds: number; offset: string };
type DraftResolution =
  | { kind: 'valid'; choice: InstantChoice }
  | { kind: 'ambiguous'; choices: readonly [InstantChoice, InstantChoice] }
  | { kind: 'invalid'; message: string };
function seedManualDraft(input: { epochSeconds: number | null; now: Date; timeZone: string }): ManualDraft;
function resolveManualDraft(draft: ManualDraft): DraftResolution;
```

- [ ] **Step 1: Write deterministic failing tests using `node:test`.** Assert UTC `2026-06-10 14:30:00` → `1781101800`; seconds `:45` → `1781101845`; new drafts floor the supplied clock to its minute; existing drafts preserve seconds. Assert invalid calendar fields, empty fields, negative/out-of-range epochs, and shared upper bound `253402300799`. For `America/New_York`, `2026-03-08 02:30:00` is invalid; `2026-11-01 01:30:00` offers `1793511000/-04:00` and `1793514600/-05:00`. An existing epoch in either occurrence round-trips unchanged.

  Pin `resolves an exact UTC instant including seconds` to the public helper:
  ```ts
  assert.deepEqual(resolveManualDraft({date: '2026-06-10', time: '14:30:45', timeZone: 'UTC', offset: null}),
    {kind: 'valid', choice: {epochSeconds: 1781101845, offset: '+00:00'}});
  ```
  Additional named cases are `rejects a daylight-saving gap`, `requires an offset for a repeated hour`, `preserves either existing repeated-hour instant`, `accepts epoch zero and the shared maximum`, and `rejects incomplete or normalized invalid dates`.
- [ ] **Step 2: Add direct dependencies and commands.** Install root runtime dependency `@js-temporal/polyfill@0.5.1` and root dev dependency `@types/node@24`; keep the API lockfile unchanged unless an actual API dependency change requires it. Add `test:manual` as `node --test src/lib/manualDateTime.test.ts` and include it in root `test` between routing and API tests. Node 24 supplies TypeScript stripping, so no new test framework/compiler runner is needed. Run `npm run test:manual`; expect missing-helper failures before implementation.
- [ ] **Step 3: Implement the helper.** Import the shared maximum epoch constant. Use Temporal earlier/later resolution plus wall-time comparison to distinguish normal times, gaps and repeated times; never accept a normalized different wall time. Resolve a repeated time only with an explicit matching offset. Seed existing instants with their actual offset. Frontend code must not import API/server modules.
- [ ] **Step 4: Verify and commit.** Run `npm run test:manual`, `npm run build`, and `npm test`. Also run `npx tsc --noEmit`; record existing unrelated failures separately and introduce no new errors in touched files. Commit as `feat: add deterministic manual date and time conversion`.

### Task 6: Add the inline editor and protect manual results

**Files:** Create `src/components/ManualDateTimePicker.tsx`; modify `src/components/Overlay.tsx`, `src/components/Row.tsx`, `src/App.css`, `scripts/desktop_smoke.py`.

**Interfaces:** The component consumes Task 5's `ManualDraft` and conversion functions. Export `ManualDateTimePickerProps` with `initialDraft: ManualDraft`, `onApply(choice: InstantChoice): void`, and `onCancel(): void`. The component owns the draft/validation; Overlay seeds it once, owns its open/closed state and committed text/manual result. Extend the runner with `run_picker(session: DesktopSession) -> None` for `--suite picker` and include it in `all`.

- [ ] **Step 1: Add failing native journeys.** At UTC, open an empty overlay, choose `2026-06-10 14:30:00`, apply and assert seven rows, `:f` selected, visible Manual label, no clipboard write, then copy `<t:1781101800:f>`. Separately import `<t:1780000000:F>`, open its result card, retain seconds `40`, change `20:26:40` to `20:27:40`, apply and assert exact output `<t:1780000060:F>` with `:F` still selected. Cancel must preserve the old epoch/format. Run `npm run test:desktop -- --suite picker`; expect absent editor controls. Name these checks `manual_from_scratch`, `adjust_parsed_preserves_format_and_seconds`, and `cancel_preserves_result`.
- [ ] **Step 2: Implement editor presentation and ownership.** Use labeled `input[type=date]` and `input[type=time]` with `step=1`, native validation plus Task 5's result, timezone/offset text, offset choices only when ambiguous, and Use date/time/Cancel buttons. Clear an earlier offset choice when fields change. Add the accessible calendar button and edit-result button. Hide copyable rows and disable text input during editing. Apply commits a manual epoch, clears the range and old generation association, preserves or defaults format as specified, and leaves the overlay open. Keep original text with a Manual label and Use text action. Text edits return to normal parsing. A range opens a new-instant draft seeded from now; cancel leaves the range untouched.
- [ ] **Step 3: Implement lifecycle protection in Overlay.** Add one active input revision, incremented on transitions that invalidate work, alongside the existing abort controllers. Guard every asynchronous state write, error path, timer and finalizer against its captured revision, including writes before the current post-API abort check. Opening cancels parse/verification/progress; cancel resumes only interrupted unresolved text work. Apply cannot be overwritten by late responses, selection suggestions or verification. Do not change backend interpretation, prewarm, or parser defaults.
- [ ] **Step 4: Verify pending-response transitions deterministically.** In the native timing scenario only, temporarily wrap the actual Tauri `invoke` promise for `parse_time_with_local_service`, hold its real response, then release it after manual apply. Also exercise late rejection and a controlled verification completion. Assert manual epoch, selected format, provenance and errors remain unchanged. Restore the wrapper in `finally`; do not add a production testing hook or fake provider service. Assert cancelling a pending edit resumes parsing, whereas cancelling an edit of a finished result does not issue a new parse. Persisted manual copy must not be attributed to the earlier model generation.
- [ ] **Step 5: Implement and exercise keyboard/focus/sizing.** Native fields own arrows/Tab. Stop Enter after apply so it cannot bubble into copy; Escape cancels the editor before the closed editor permits overlay dismissal. Focus date on open, opener on cancel, selected focusable result on apply. Include editor/validation changes in native resize, constrain content to available screen height, and preserve the 480px width. Add accessibility names, expanded state, error associations, and editor footer hints.
- [ ] **Step 6: Complete acceptance scenarios and visual review.** Test Use text and normal typing after manual apply; close/reopen with no stale draft; API-unavailable manual selection in a fresh `DesktopSession(disable_api=True)` that sets `HAMMEROVERLAY_DISABLE_SUPERVISED_API=1` only for that fixture; range-to-single apply/cancel; empty/invalid fields; unchanged repeated-hour offset and invalidation after edits. A fresh `DesktopSession(time_zone="America/New_York")` owns DST UI cases; a session with `screen_size=(1280, 600)` and the window near an edge owns popup/scroll/focus cases. Supply the required run directory/mode arguments in each case. Capture all meaningful states and review screenshots plus sampled recording frames. Run `npm run test:manual`, `npm test`, `npm run build`, and `npm run test:desktop -- --suite all`. No feature acceptance is inferred merely from helper tests.
- [ ] **Step 7: Commit** as `feat: add inline manual date and time picker`.

### Task 7: Qualify repeatability, add CI, and record Windows verification

**Files:** Modify `.github/workflows/build.yml`, `docs/linux-desktop-testing.md`, `README.md`; create `docs/manual-picker-windows-smoke.md`; modify `scripts/desktop_smoke.py` only if qualification exposes a diagnosed lifecycle issue.

**Interfaces:** `npm run test:desktop -- --suite all --repeat 20` creates 20 fresh-state runs with separate outcomes and fails at the first non-pass. The manifest identifies the same build across that invocation. CI uses the same command without a framework-specific runner.

- [ ] **Step 1: Verify fresh-task restoration.** Use the supported cloud configuration/setup mechanism in a genuinely fresh task; run setup, installs, and one full native run without this chat's scratch/onboarding files. Preserve its evidence. If a fresh task or required setup is unavailable, mark this acceptance item blocked rather than substituting another current-worker run.
- [ ] **Step 2: Qualify the final native suite.** Run the 20-run command after Tasks 1–6. Inspect individual outcomes, finalized captures, cleanup, clipboard replacement and hide/reopen. Any failure breaks the streak and remains in evidence. Diagnose the cause and rerun qualification only after a justified fix. Do not add silent retries, delete failures, or require this loop after every routine UI edit.
- [ ] **Step 3: Add the Linux CI job after qualification.** Use `ubuntu-24.04`, Node 24, pinned Rust/driver setup, dependency caches, root/API `npm ci`, root `npm test` including the new conversion tests, `python3 -m unittest discover -s scripts -p 'test_desktop_smoke.py' -v`, and one `npm run test:desktop -- --suite all`. Upload `artifacts/desktop/` with `if: always()`. Keep the Windows job; make the new job a real failure on assertion/capture failure rather than using `continue-on-error`. Repository branch-protection settings need not change automatically.
- [ ] **Step 4: Verify the installed Windows path before a desktop PR.** On Windows, run `npm run tauri:build -- --config src-tauri/tauri.ci.conf.json`, install that exact MSI, record its hash/version, and execute both picker journeys, clipboard replacement, native date/time popup keyboard handling, timezone/DST choices, focus restoration, and sizing near desktop edges. Save screenshots/video and a result in the smoke document. Run the existing `npm run verify:installed:routing-smoke` when its documented runtime prerequisites are available, without claiming it covers the picker. If Windows access is unavailable, preserve that blocker and do not open the desktop/runtime PR under `AGENTS.md`.
- [ ] **Step 5: Document and commit the result.** README links to the Linux command and Windows record. Document provider-mode configuration, failure evidence, qualification summary, and coding-agent review artifact references; do not invent successful evidence. Re-run affected commands only if fixes changed relevant behavior. Commit as `ci: add qualified Linux desktop smoke checks` once the qualification and intended CI changes are verified.

## Completion and execution handoff

Deliverables are the setup recipe, one native runner with readable artifacts, the two small regressions fixed, the manual picker, and qualified CI. Installed Windows evidence controls PR/release readiness; unavailable provider access is explicitly separate from offline coverage.

This plan has been written and reviewed as a planning artifact, not executed. Recommended execution is native in this session because tasks share the runner and Overlay interfaces and the user requested low overhead. After plan review and execution-method selection, use the corresponding execution skill; do not begin implementation during planning.
