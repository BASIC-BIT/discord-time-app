# Linux desktop feedback loop

Status: approved in conversation. Implementation has not started. See [the combined implementation plan](../plans/2026-10-20-desktop-feedback-and-manual-picker.md) and [the manual picker design](2026-10-20-manual-datetime-picker-design.md).

## Goal and scope

Give a coding agent working in a cloud task enough evidence to assess desktop changes: run the actual Tauri app, exercise native interactions and the bundled API, capture the result, and review it visually. Keep the implementation small. The manual date/time picker will be the first feature developed against this setup, with choosing a time and adjusting a parsed result equally important.

Use a small dependency setup script and a native smoke runner, exposed as `npm run test:desktop`. Prefer the Python standard library for WebDriver HTTP requests and process control, building on the spike. Reuse the existing desktop build and API tests. Do not introduce a testing framework, review service, provider abstraction, dashboard, or automatic retry system.

Coding-agent review is sufficient for v1. Independent LLM/VLM/video judging is deferred. Linux testing does not establish Windows installer or WebView2 behavior.

## Environment and execution

The supported environment contains Node 24, a pinned Rust toolchain and Tauri driver, WebKitGTK and its driver, Xvfb, a small window manager, D-Bus, X11 input/clipboard tools, and FFmpeg. Install native dependencies through the environment's supported setup mechanism at their expected system paths. Qualify that mechanism first; do not assume this worker permits system installation. If it cannot provide those paths, report the bootstrap as blocked. PRoot and a custom relocation layer are outside the maintained v1 design.

The setup script checks prerequisites and can run again without damaging existing state. It does not depend on `/workspace/scratch`, onboarding helpers, a particular checkout path, or artifacts left by this chat. Record tested versions; the dependency recipe must also work from a fresh cloud task.

Each test run:

1. Uses the existing build pipeline to produce a native debug executable with the production frontend and API sidecar bundled. It does not require a Vite server or build an installer.
2. Creates a fresh application configuration, database, desktop, and artifact directory. Runs serially on a worker because the app currently uses fixed API and single-instance resources. Fails clearly if required resources are occupied.
3. Starts the native app through Tauri WebDriver and waits for observable window and sidecar readiness. Uses real X11 events for shortcuts and clipboard interactions, with WebDriver inspecting the actual webview.
4. Runs the scenarios, captures evidence, and terminates all process groups it owns, including Node and WebKit helpers. It never terminates unrelated processes.

Poll observable conditions within bounded timeouts. In particular, establish that the native window has finished hiding before reopening it, keep the pointer outside rows during keyboard checks, and let window geometry settle before screenshots. Investigate the spike's hide/reopen stall rather than assuming these measures resolve it.

## Scenarios and parser modes

Keep a compact suite covering shortcut opening; supervised API startup; an exact epoch parsed through Rust IPC and the authenticated Node API; seven format previews; keyboard selection and native clipboard copy; dismissal and clipboard import on reopen; range previews; invalid input; offline natural-language handling; and persisted API usage and copy outcomes. Include replacing auto-imported clipboard text as a regression case. Verify records created by this run, not counts accumulated by earlier runs.

The default baseline requires no provider credentials, isolates application state, and exercises the existing offline paths without changing production parser defaults. A separate explicitly selected mode uses the application's existing model configuration and records its identity and latency. Missing configuration means model coverage is unavailable; an explicitly requested model run fails as blocked. A successful fallback does not count as a successful model-path test. No paid model run is required to qualify the offline baseline.

The development-server import issue and clipboard replacement bug found during the spike remain separate product fixes with reproductions. Do not preserve a fixture workaround as proof that the broken user interaction works. Native format-preference persistence is also unproven because its Rust commands are currently stubs; API SQLite records provide the baseline persistence assertion.

## Evidence and agent review

Write one folder per run under ignored `artifacts/desktop/`, containing a JSON result, a short readable summary, screenshots of meaningful states, a finalized desktop MP4, and relevant logs. Include the commit, executable hash, dependency versions, parser mode, model identity when applicable, and whether the source had uncommitted changes. Exclude credentials and authentication headers.

Capture artifacts on both success and failure. Verify that the MP4 is readable. A failed recording or incomplete assertion run is not a fully passing run. Distinguish assertion failures from environment/setup failures. Bound diagnostic collection so an unresponsive WebDriver cannot prevent cleanup; retain a desktop screenshot even when webview capture fails.

The coding agent inspects screenshots and representative recording frames for clipping, layout, focus, window transitions, and confusing states, then adds concise findings with artifact paths or timestamps. State whether review inspected screenshots, sampled frames, or video directly. Visual judgment supplements exact assertions. The spike's transient white repaint remains an observation until capture timing and renderer behavior are distinguished.

## Acceptance and rollout

Start with the cloud command. It must run successfully in a fresh cloud task, preserve useful evidence on failure, and leave no owned live app/helper processes or occupied resources behind.

Before making native testing a required CI check, complete 20 consecutive full native runs, each using fresh application state and exercising hide/reopen. This is a one-time qualification and a focused check after changes to test lifecycle behavior, not work required after every UI edit. Any failure remains visible and breaks the qualification streak. Ordinary development runs the relevant scenarios once.

After qualification, add a Linux job alongside the existing Windows workflow and upload artifacts even on failure. Reuse the same command. Existing API tests remain in place; model-backed tests run only in their explicitly configured mode. Changes that depend on installed-app behavior still require the installed Windows MSI smoke evidence specified in `AGENTS.md`.

The picker design follows this specification. The testing setup must support both of its acceptance journeys: open, choose, copy; and type, resolve, adjust, copy. It does not determine the picker layout or expand v1 into a cross-platform release system.
