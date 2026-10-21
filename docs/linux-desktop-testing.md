# Linux desktop testing

The native feedback loop runs the actual Tauri application and bundled API under
X11. Its prerequisite gate is:

```sh
bash scripts/setup-linux-desktop.sh --install
bash scripts/setup-linux-desktop.sh --check
```

Run the check again in a fresh shell before starting native work. Both commands
exit `0` when prerequisites are ready and `2` when blocked. `--check` does not
install packages or create caches. A ready prerequisite check does not establish
that the application builds, that native scenarios pass, or that the Windows
installer works.

## Supported provisioning

Use Debian or Ubuntu with Node major 24 already provisioned and root or
noninteractive `sudo` available for package installation. The script resolves the
checkout from its own location, so it also works when called from another working
directory. It installs distribution packages through `apt-get`, without removing
packages or upgrading existing packages. If everything is ready, `--install`
returns without reinstalling it.

The package recipe includes WebKitGTK 4.1 and its WebDriver, GTK 3, Ayatana
AppIndicator, librsvg, libxdo, build tools, Python, Xvfb, Openbox, D-Bus, xdotool,
xclip, X11 utilities, xauth, and FFmpeg. Python must be 3.11 or newer. Rust is
pinned to `1.99.1` and `tauri-driver` to `2.1.0`. A different Rust or driver
version does not pass the gate.

These driver executables do not expose `--version`. The check verifies
`tauri-driver` through Cargo's installed-package metadata and a successful
executable `--help` invocation. It records WebKitWebDriver's distribution package
version and verifies its executable the same way.

Native libraries and executables must be installed at ordinary system paths.
The check ignores `PKG_CONFIG_PATH`, `PKG_CONFIG_LIBDIR`, and
`PKG_CONFIG_SYSROOT_DIR` and verifies WebKit's `WebKitWebProcess` and
`WebKitNetworkProcess` executables beneath the system WebKitGTK library directory.
A workspace extraction, PRoot, or a relocated WebKit installation does not
qualify.

A managed Docker container is a supported execution environment when the platform
provides Docker and permits standard package installation inside the container.
It must contain Node 24 and run this same script with native packages installed
at its own `/usr` paths. Run subsequent builds and desktop tests inside that
container too. Passing a container check does not make the outer worker ready.
Do not mount the host root writable, use a privileged container, or modify the
managed daemon to provision these dependencies.

For a managed cloud task, inspect its environment readiness and network policy
before network setup. Keep its Docker proxy defaults and registry configuration.
Give networked container commands a read-only mount of the provided proxy CA and
configure the relevant clients to trust it. Clients that replace their default
trust store need the combined system CA bundle. Do not copy credential files or
session trust material into an image or archive. No cloud publication, access,
network-policy, or external infrastructure changes are part of this recipe.

If the current worker cannot install packages at their compiled system paths,
the command reports blocked. Use the supported environment setup to provide a
root-capable image or container before claiming native verification. Independent
source changes and deterministic tests can continue while that gate is blocked.

## Toolchain and caches

The defaults are writable checkout-local directories, ignored through `.cache/`:

| Variable | Default relative to the checkout |
| --- | --- |
| `CARGO_HOME` | `.cache/linux-desktop/cargo` |
| `RUSTUP_HOME` | `.cache/linux-desktop/rustup` |
| `npm_config_cache` | `.cache/linux-desktop/npm` |

The script honors existing values for these variables and verifies that their
directories can be written. Keep the same values between setup and testing.
It preserves proxy and CA variables, leaves TLS verification enabled, and does
not change `HOME`, `CODEX_HOME`, or shell profiles. Rustup stores toolchain
configuration under the selected `RUSTUP_HOME`.
For direct Cargo/Tauri commands in a fresh shell, expose the same toolchain:

```sh
# Run from the checkout root. Preserve any existing cache overrides.
export CARGO_HOME="${CARGO_HOME:-$PWD/.cache/linux-desktop/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$PWD/.cache/linux-desktop/rustup}"
export npm_config_cache="${npm_config_cache:-$PWD/.cache/linux-desktop/npm}"
export RUSTUP_TOOLCHAIN=1.99.1
export PATH="$CARGO_HOME/bin:$PATH"
bash scripts/setup-linux-desktop.sh --check
```

Install JavaScript dependencies from the lockfiles with `npm ci` and
`npm --prefix api ci`. Setup does not read application `.env` files, configure
models, or make provider calls. Keep transport proxy and CA configuration when
isolating application credentials for offline tests.

## Native evidence and platform gates

For a cold development check, stop this checkout's dev session, remove only
`node_modules/.vite`, then run `npm run tauri -- dev --no-watch` in the supported
native environment. Press Ctrl+Shift+H and confirm that the overlay input loads
and accepts text. Stop the dev session before running the embedded baseline;
both use the same application and API resources.

The linked `@hammer-overlay/discord-timestamp-routing` package exports CommonJS.
Vite's `optimizeDeps.include` explicitly includes it so cold dev loading converts
its named exports for the WebView. Without that entry the overlay can stay blank
with `Importing binding name 'classifyDiscordTimestampInput' is not found.`
Preserve the package exports and production chunk configuration when maintaining
this setting. A passing production build alone does not check cold dev loading.

The native runner's public command is `npm run test:desktop`. Run serially on a
worker because the application uses fixed API and single-instance resources. Default coverage uses fresh application
state, offline parser paths, and zero model calls. An explicitly requested model
run with missing configuration is blocked; fallback success is not model success.

Evidence belongs in one ignored `artifacts/desktop/` directory per run. It includes
the result, readable summary, meaningful screenshots, finalized MP4, relevant
logs, commit, executable hash, dependency versions, parser mode, and source
cleanliness. Exclude credentials and authentication headers. Report visual review
as screenshots, sampled frames, or direct video review according to what was
actually inspected.

Ordinary development needs the relevant native scenarios once. Twenty consecutive
full runs with fresh application state, including hide/reopen, qualify lifecycle
repeatability before Linux testing becomes a required CI gate. A failed run
breaks that streak.

Linux evidence does not establish WebView2, native popup, or installed Windows
behavior. `AGENTS.md` requires installed Windows MSI smoke evidence before a
desktop/runtime PR, merge, or release that depends on installed-app behavior.
This setup does not satisfy that gate.

## Observed environments

The checker prints actual distribution, Node, Python, GTK/WebKit, Rust, driver,
and FFmpeg versions. Retain that output with native evidence instead of assuming
that distribution packages have identical versions across workers.

The outer worker inspected on 2026-10-20 was Debian 13.6 with Node 24.19.0,
Python 3.12.14, and FFmpeg 7.1.5. It ran as UID 1000 without sudo or writable
`/usr` and lacked the system WebKit/Rust/X11 prerequisites. Its install and check
commands correctly reported blocked. A managed container qualification is
recorded separately after running the same recipe at ordinary inner system paths.

The recipe passed `--install`, then two `--check` runs in a fresh managed
`node:24-bookworm` container on 2026-10-20. The image digest was
`sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0`.
It reported Debian 12, Node 24.22.0, Python 3.11.2, GTK 3.24.38, WebKitGTK
2.50.6, `webkit2gtk-driver` 2.50.6-1~deb12u2, FFmpeg/FFprobe 5.1.9, Rust
1.99.1, and `tauri-driver` 2.1.0. WebKit helpers existed beneath
`/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/`. Repeating `--install` returned ready
without invoking package installation. This qualifies prerequisites only.

## Running the native suites

```sh
python3 -m unittest discover -s scripts -p 'test_desktop_smoke.py' -v
npm run test:desktop -- --suite baseline
npm run test:desktop -- --suite picker
npm run test:desktop -- --suite all
```

Run these commands inside the same supported environment used for setup. The
runner checks prerequisites, builds through Tauri's existing `beforeBuildCommand`,
and finds the debug executable through Cargo metadata. `CARGO_TARGET_DIR` works
without a hardcoded target path. The Linux config only changes bundle targets and
updater artifact generation; this command builds no installer.

`--mode offline` is the default. It strips provider, parser, frontend and dev
entrypoint overrides, disables observability, and uses fresh XDG state and an
ephemeral local API key. Transport proxy and CA settings remain available. The
app and driver start from a separate temporary working directory because the
Rust debug build also searches relative paths for `api/.env`. The real sidecar's
readiness response must confirm that offline providers are absent. State,
settings and key files are deleted after extracting sanitized logs. Only the
current run's SQLite generation IDs and corresponding copy outcome count toward
the persistence assertion.

`--mode model` requires explicit inherited application provider configuration.
It uses the existing OpenAI or Plan-IR settings, verifies a model-required live
smoke row and the persisted model identity, calls and duration, and reports the
parse latency against the 5-second product SLO. Its 30-second RPC transport bound
does not alter the app's inference timeout. Missing configuration exits blocked;
fallback does not count as model coverage. Do not run a paid model merely to
qualify the offline baseline.

`baseline` has 12 named checks. `picker` has 20 named checks: 17 in the main
desktop and one each in three additional fresh desktops (API unavailable,
America/New_York DST, and a 1280×600 screen). `all` combines them for 32 named
checks across four desktop sessions. These are check counts, not repeated runs.

`--repeat N` builds once and runs fresh isolated desktops serially, stopping at
the first non-pass. Repetition is offline-only. The one-time qualification is:

```sh
npm run test:desktop -- --suite all --repeat 20
```

Every iteration gets a separate result directory and the same executable hash.
Each full iteration includes the three fresh picker fixtures. A failed iteration
breaks the streak; preserve its evidence and diagnose it before another
qualification invocation. There are no automatic retries.

Exit `0` means assertions, video validation and cleanup passed. Exit `1` means a
test or capture failed, and exit `2` means prerequisites, resources or requested
configuration are blocked. Ordinary WebDriver requests have a 5-second bound,
startup has 30 seconds, and failure desktop screenshots have 3 seconds. Native
visibility and settled geometry are polled before reopening and taking captures.
The pointer stays away from rows during keyboard checks.

The runner owns private process groups for Xvfb, D-Bus, Openbox, WebDriver and
clipboard helpers, and tracks descendants including the app, sidecar and WebKit.
It never reuses an occupied API/driver port or kills an existing desktop. Teardown
allows 5 seconds before terminating remaining owned descendants and reports a
cleanup failure when forced termination is necessary. Child output goes to files so a surviving clipboard selection owner cannot hold a caller's
output pipe open.

Each run prints its `artifacts/desktop/<run-id>/` folder. Read `results.json` and
`summary.md` alongside the desktop PNGs, `desktop.mp4` and sanitized logs. Video
is finalized and checked with `ffprobe` and a decoded frame. Direct X11 capture
works when WebDriver is unresponsive. The original assertion error stays visible
if capture also fails. Visual review remains `pending` until a coding agent
records what screenshots, sampled frames or video it actually inspected.

The baseline now checks native Ctrl+A/paste over auto-imported clipboard text,
selected-text typing, caret insertion, and deletion. The auxiliary typing/caret
cases set selection through WebDriver, then use real X11 edits; they do not prove
native selection navigation. Native format-preference persistence remains outside
this assertion because the corresponding Rust commands are stubs.

## Coverage and controlled fixtures

Baseline checks cover the hotkey, supervised API startup, authenticated Rust/Node
parse, seven previews, Down/Enter copy and native hide, clipboard reopen/import
and replacement, five range previews, malformed input, offline natural language,
Escape dismissal, and this run's SQLite generation/copy records with zero model
calls. The fixed main desktop timezone is UTC.

Picker checks cover focused clarification arrows/numeric activation; choosing
from scratch; adjusting a parsed instant while retaining seconds and format
(including exact native copy); cancel, validation and focus; native field keys;
returning to text and discarding a draft on reopen; range-to-single conversion;
and Space copying the focused row's own format. Additional checks hold actual
IPC response completion to test late parse success, service rejection, verifier
completion, pending-cancel resume, completed-cancel without reparsing, and five
initialization/parse-setup ownership boundaries. The verifier fixture tags a
real offline parse response to enter the verifier branch; it tests ownership,
not model interpretation. These controlled wrappers restore in `finally`.

The three serial fresh fixtures verify manual operation with the API disabled;
DST gap rejection, both repeated-hour offsets and unchanged-epoch preservation
in America/New_York; and native popup/keyboard/scroll usability at 1280×600.
Calendar values for some cases are fixture setup; native keyboard and clipboard
assertions use X11 events, not synthetic DOM key events. Unit conversion tests
add exact bounds/calendar cases beyond these native journeys.

## Explicit model mode

Use `npm run test:desktop -- --suite baseline --mode model` only when a model run
is intended and its existing provider is configured in the invoking environment.
For OpenAI, provide `OPENAI_API_KEY` and the intended `OPENAI_MODEL`; for Plan-IR,
provide `TEMPORAL_FEATURE_PLAN_IR=true`, `TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL`, and
`TEMPORAL_PLAN_IR_ENDPOINT_MODEL`, plus endpoint authentication/settings required
by that existing service. Checkout `.env` files are deliberately not loaded.
Never put credentials in artifact files or commit them. No new provider or model
infrastructure is part of this runner.

The explicit model-required row uses `day after next saturday at l33t time`,
America/New_York, reference `2026-05-24T12:00:00Z`, and exact epoch `1780249020`.
It requires an agent/tool method and persisted positive model-call count, model
identity, and duration. The manifest records elapsed parse latency against the
5-second product SLO; a fallback cannot satisfy this check. Missing configuration
exits 2 as blocked. This work ran offline only and made no model calls.

## Qualification and release record

Fresh managed cloud task restoration is **BLOCKED**: this session has no fresh
task creation tooling. The provisioned Debian 12 Docker environment establishes
ordinary-system-path setup on the current worker, not a fresh cloud task. The
remaining acceptance run must provision a genuinely fresh task, install both
lockfiles, run setup/check and one full native suite without this chat's scratch
files, and retain its output.

Repeatability qualification is **BLOCKED** pending 20 consecutive full passes.
The current qualification result and retained failures are recorded below; do
not treat a single successful suite as qualification. Linux CI is deferred under
the approved qualification rule; `.github/workflows/build.yml` retains its
existing Windows job. Once qualified, add `ubuntu-24.04`, Node 24, Rust 1.99.1,
tauri-driver 2.1.0, dependency caches, setup, root/API `npm ci`, root `npm test`,
the Python boundary unittest command above, and one full native suite. Upload
`artifacts/desktop/` with `if: always()` and fail on assertion/capture/cleanup
errors (no `continue-on-error`).

On 2026-10-21, the single required invocation of
`npm run test:desktop -- --suite all --repeat 20` exited 1 and stopped at run 2:

| Directory under `artifacts/desktop/` | Actual outcome |
| --- | --- |
| `20261021T001002-57e2e3-01/` | PASS: 29 main checks + 3 fresh-fixture checks = 32; all four recordings readable and all cleanup lists empty |
| `20261021T001002-57e2e3-02/` | FAIL: 6 baseline checks passed, then caret deletion timed out during clipboard replacement; readable 12.584s recording and empty cleanup list |

Both results identify commit `d1d7b32` and the same executable SHA-256
`7f8537ad38052330dc24e6029e7016b1ac08c0560f1268742cc607b75b9b1216`.
Run 1 records clean source; run 2 records dirty source because this documentation
was being written during the invocation. Application and runner source did not
change and the executable was built only once. Only one full iteration passed;
runs 3–20 did not execute.

Run 2 recorded Backspace keyup with no keydown/input, despite focused textarea,
focused native HammerOverlay window, live app/WebKit helpers and responsive
read-only driver probes. A separate bounded diagnostic at
`artifacts/desktop/task7-raw-input-diagnostic-2/` reproduced missing DOM keydown
for caret insertion: the XI2 observer recorded raw press and release immediately
after `xdotool type x`, while DOM recorded only keyup `x`. This narrows the
observation past X server raw input; it does not establish where native delivery
or WebKit processing lost the keydown. The first diagnostic directory
`task7-raw-input-diagnostic/` preserves an observer-setup failure caused by absent
`xmodmap`, corrected by using Xlib keycode lookup in the second diagnostic.
Neither diagnostic counts toward qualification. No causal fix, timeout increase,
retry, or second qualification invocation was made.

Installed Windows acceptance is **NOT RUN**; see the
[exact MSI checklist and record](manual-picker-windows-smoke.md). Linux native
and deterministic evidence cannot lift the `AGENTS.md` desktop PR/merge/release
gate.

Historical current-product evidence at commit `d1d7b32`: picker
`artifacts/desktop/20261021T000605-0794eb-01/` passed 20 named checks; full suite
`artifacts/desktop/20261021T000713-3bbdee-01/` passed 32. Both used executable
SHA-256 `7f8537ad38052330dc24e6029e7016b1ac08c0560f1268742cc607b75b9b1216`.
These passes do not erase earlier missing native keydown, unexpected date focus
loss, or WebDriver `RemoteDisconnected` observations. The retained baseline
failure at `artifacts/desktop/20261021T000007-f4af3b-01/` recorded only keyup during
caret deletion. No root cause or reliability fix has been established for those
observations.

Coding-agent visual review is documented in
`artifacts/desktop/20261020T234832-cc5360-01/controller-visual-review.json`:
selected screenshots and sampled MP4 frames, not full video playback or an
independent model judge. It found readable 480px controls, correct DST choices,
reachable short-screen results, and a calendar fitting near the edge. Transient
resize/scroll repaint was observed; renderer behavior versus capture timing is
unresolved. The later fix review inspected clarification and adjusted-result
screenshots in `20261021T000605-0794eb-01`. Artifacts are ignored local evidence;
retain/archive them with a handoff because a clean clone will not contain them.

Task 7's additional review is recorded in
`artifacts/desktop/20261021T001002-57e2e3-01/task7-visual-review.json`: adjusted
result and failure screenshots, plus a short-desktop frame at 2s and the failed
run at 9s. Controls and seconds are readable, and the failed edit still shows
the unchanged token/caret. This is sampled-frame review, not full playback.
