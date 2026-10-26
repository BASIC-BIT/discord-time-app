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

## Validation policy, amended 2026-10-21

A real Tauri Linux cloud-container run is sufficient PR/merge validation for
shared desktop behavior when it exercises the shared UI, native API, SQLite,
clipboard, hotkey, and layout, and includes screenshots, finalized video, and
coding-agent review. Report the tested commit and actual coverage. Linux cannot
prove WebView2, MSI, or Windows-specific behavior.

Windows-specific installer, updater, runtime, native integration, local SLM
launcher, and installed-path changes require smoke evidence from the exact
installed MSI before PR/merge. Every Windows release requires that evidence.
The shared picker does not change Windows packaging, so its Windows `NOT RUN`
record is a tracked platform limitation rather than a blanket PR/merge blocker.
The v0.1.2 installed local SLM launcher failure remains the reason for the
Windows-specific gate in `AGENTS.md`.

After a causal fix, run the targeted regression and the relevant full smoke suite.
For lifecycle changes, document a small repeat sample and why its size covers the
affected transitions. No fixed passing streak is required. Preserve every
failure, stop at the first non-pass, and diagnose before rerunning; do not add
silent retries or discard failures to obtain a pass. Routine shared UI changes
need their relevant native scenarios and visual review.

Prove restoration in a fresh supported container using maintained setup and a
clean checkout, both lockfile installs, setup/check, and one full native suite.
Record the image, versions, commands, cache mounts, and evidence. Explicit Cargo,
Rustup, npm, or build dependency caches may be reused; do not reuse application
state, a chat scratch runtime, a sysroot, or onboarding helpers. Native packages
must remain at the container's ordinary system paths. Creating a new managed
task is not a separate gate.

This amendment replaces the earlier fixed 20-pass, fresh-managed-task, and blanket
installed-Windows gates. Current acceptance, CI configuration, and retained
historical failures appear below.

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
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_INCREMENTAL=0
export PATH="$CARGO_HOME/bin:$PATH"
bash scripts/setup-linux-desktop.sh --check
```

Install JavaScript dependencies from the lockfiles with `npm ci` and
`npm --prefix api ci`. Setup does not read application `.env` files, configure
models, or make provider calls. Keep transport proxy and CA configuration when
isolating application credentials for offline tests.

## Clean-checkout Docker recipe

Run from the source checkout in a managed environment with Docker available.
Check environment readiness and network policy first. The managed Docker client
supplies its proxy defaults; keep its configuration unchanged. This recipe mounts
the provided public proxy CA and combined system trust bundle read-only. It
creates a tracked-files-only clone with empty dependency caches and no application
state, `.env`, or chat runtime files. Keep the clone after the run to review its
`artifacts/desktop/` evidence.

```sh
set -euo pipefail
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
  -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock info >/dev/null
fresh_checkout="$(mktemp -d /tmp/hammer-desktop-checkout.XXXXXX)"
git clone --local --no-hardlinks "$PWD" "$fresh_checkout"
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
  -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock run --rm -i --user 0:0 \
  --mount "type=bind,src=$fresh_checkout,dst=/workspace/discord-time-app" \
  --mount "type=bind,src=${CODEX_PROXY_CERT:?provided proxy CA required},dst=/run/proxy-ca.pem,readonly" \
  --mount type=bind,src=/etc/ssl/certs/ca-certificates.crt,dst=/run/combined-ca.pem,readonly \
  -e NODE_EXTRA_CA_CERTS=/run/proxy-ca.pem \
  -e SSL_CERT_FILE=/run/combined-ca.pem -e CURL_CA_BUNDLE=/run/combined-ca.pem \
  -w /workspace/discord-time-app \
  node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0 \
  bash -se <<'CONTAINER'
set -euo pipefail
# Trust only this known bind checkout inside the owned ephemeral container.
git config --global --add safe.directory /workspace/discord-time-app
export CARGO_HOME="$PWD/.cache/linux-desktop/cargo"
export RUSTUP_HOME="$PWD/.cache/linux-desktop/rustup"
export npm_config_cache="$PWD/.cache/linux-desktop/npm"
export RUSTUP_TOOLCHAIN=1.99.1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
export PATH="$CARGO_HOME/bin:$PATH"
bash scripts/setup-linux-desktop.sh --install
bash scripts/setup-linux-desktop.sh --check
npm ci
npm --prefix api ci
test_state="$(mktemp -d)"
DB_PATH="$test_state/usage.db" LANGFUSE_ENABLED=false TEMPORAL_FEATURE_PLAN_IR=false npm test
command -v tauri-driver
python3 -m unittest discover -s scripts -p 'test_desktop_smoke.py' -v
npm run test:desktop -- --suite all
CONTAINER
echo "Evidence: $fresh_checkout/artifacts/desktop/"
```

The exact `safe.directory` entry fixes Git's dubious-ownership rejection when a
root container reads a host-owned bind checkout. It changes only the ephemeral
container's Git configuration. Do not use a wildcard or change host-global Git
trust. A matching checkout UID is an alternative once system setup is complete.
The declared dependency caches are `.cache/linux-desktop/{cargo,rustup,npm}` and
Cargo's `src-tauri/target`. They start empty here; later runs may reuse only those
dependency/build caches. The runner creates and cleans private application state
for each desktop. No privileged mode, TLS bypass, or sandbox-disabling flags are
needed. Never bake session CAs or credentials into an image.

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

Use the validation policy above to select relevant scenarios and a justified
repeat sample after lifecycle changes. Keep Windows coverage explicit in the
[installed MSI record](manual-picker-windows-smoke.md).

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
the first non-pass. Repetition is offline-only. Choose and record `N` for the
lifecycle transitions being checked, rather than using a fixed qualification
streak. For example, a small sample can check clipboard replacement and
hide/reopen after their causal fix, alongside the targeted regression and full
suite. This is an operating policy; the runner's command interface is unchanged.

Every iteration gets a separate result directory and the same executable hash.
Each full iteration includes the three fresh picker fixtures. Preserve failed
iterations and diagnose them before rerunning. There are no automatic retries.

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

Clean-checkout restoration and native acceptance passed on 2026-10-21. A fresh
tracked clone in the pinned `node:24-bookworm` container passed maintained
setup/install/check, both `npm ci` commands, and a cold native build in 3m42s.
No old Cargo, Rustup, npm, application state, scratch runtime, or sysroot files
were reused. Root `npm test` passed offline with a private SQLite path at
`4360e55`; the later transport change touches only the Python runner and its
regression. Root tests also passed against that transport change in the original
container, with zero model calls.

The final fresh run at clean commit `8d9c7fb` passed `--suite all`, 32 named
checks across four desktop sessions. Evidence is archived under
`artifacts/desktop/fresh-container/20261021T063324-80b1fb-01/`. All four sessions
exited 0, had empty cleanup error lists, and produced readable videos lasting
41.917, 2.417, 8.917, and 6.75 seconds. All used executable SHA-256
`6b7380e45eab67851ceacb60b44943171c9859047b3fa4c031afad67d461c5d7`.
The updated Python boundary discovery passed all 12 tests in 12.609s, including
the actual installed `tauri-driver` proxy regression with no skips. The initial
fresh restoration at `4360e55` also passed all 32 checks in
`artifacts/desktop/fresh-container/20261021T062813-915a7e-01/`.

Two causes now have causal fixes and regressions. Consuming overlay Escape before
native hide prevents WebKit's stale key-forwarding state from dropping the first
keydown after reopen. The HTTP caller now uses stdlib `HTTPConnection`, reads
the complete response, and closes its own connection without forcing upstream
`Connection: close`. A controlled real-proxy regression reproduced the old
WebKit/Hyper close-window race and passes with the fixed caller. It checks small
and multiwrite responses without retries. After both fixes, a maintained
`--suite all --repeat 2` invocation in the original container passed 32 checks per
sample, preserving the same assertions. Two samples exercised fresh sessions and
repeated hide/reopen, clipboard, and picker lifecycle transitions.

Linux CI is configured in `.github/workflows/build.yml` beside the unchanged
Windows job. It runs on `ubuntu-24.04` inside the pinned bookworm image, validates
Node 24, caches the declared dependencies/build output, runs maintained setup,
both lockfile installs, offline root tests, all Python boundaries with the
installed proxy on `PATH`, and one full native suite. Assertion, capture, and
cleanup failures fail the job. It uploads `artifacts/desktop/` with
`if: always()`. The job explicitly trusts only its checked-out directory in the
ephemeral container's Git configuration. Checkout's temporary configuration does
not carry into later shell steps, and container root may differ from the owner
of the bind-mounted checkout.

The first hosted run, `39557313119`, passed setup, dependency installation,
offline tests, and all 12 Python boundaries. The native step stopped before
build with Git's dubious-ownership rejection; the failure evidence was uploaded.
A mismatched-owner fixture reproduced that rejection with checkout-only trust,
passed after adding exact-directory trust to the job configuration, and verified
that an unrelated repository remained untrusted. This first failure remains
historical evidence, not a current hosted blocker.

Hosted run
[39557777802](https://github.com/BASIC-BIT/discord-time-app/actions/runs/39557777802)
succeeded at PR head `4fb4a3a`, testing merge commit
`1375ebb9e997d5b2f319712326366029cbbc6467`. Linux job `119081514398`
passed offline root tests, all 12 Python boundaries with the installed proxy,
and all 32 native checks. Its four sessions had empty cleanup error lists and
readable recordings lasting 44.5, 3, 8.666667, and 6.5 seconds. Artifact
`12326846155` was uploaded, downloaded, and reviewed through representative
screenshots and a sampled video frame. The job logs confirm cache save. The
Windows job also passed, including Rust tests, build, MSI/executable verification,
and artifact upload.

The later run
[39622968439](https://github.com/BASIC-BIT/discord-time-app/actions/runs/39622968439)
at head `4a53871` also succeeded on Linux and Windows. Linux job `119300896110`
passed all 12 boundaries and the full native suite, with evidence under
`artifacts/desktop/20261021T151002-ebd213-01/` in artifact `12354973387`.
It used the existing dependency cache. These hosted records validate those
revisions; subsequent source changes require their own relevant verification.
Installed Windows MSI and WebView2 smoke remain **NOT RUN**. Windows CI success
does not establish installed-app behavior.

The first fresh invocation stopped before build because root did not trust the
host-owned Git checkout. Its failure remains in
`artifacts/desktop/fresh-container/20261021T062741-9289fe-01/`. Trusting only the
exact bind path inside that owned container corrected provisioning before the
successful run. The Docker recipe above includes that step.

Earlier failures remain below as historical evidence. The earlier 20-pass
requirement is superseded.

Final fresh-run visual review is recorded in
`artifacts/desktop/fresh-container/20261021T063324-80b1fb-01/controller-visual-review.json`.
The coding agent inspected four screenshots and a main-video frame at 20s.
Fields, seconds, timezone, actions, the retained DST offset, and the last result
after keyboard scrolling were readable. This is sampled review, without full
video playback or an independent model judge. The earlier fresh-run 2s resize
frame still records a transient blank lower rectangle; settled controls were
readable. The final sample does not establish that transient repaint is absent.

On 2026-10-21, the invocation under the former 20-pass policy of
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
runs 3–20 did not execute. The retained results are historical evidence, not a
current passing-streak requirement.

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
Neither diagnostic established acceptance. The later Escape fix and regression
described above resolved the stale key-forwarding cause without a timeout
increase or retry.

Installed Windows acceptance is **NOT RUN**; see the
[exact MSI checklist and record](manual-picker-windows-smoke.md). Linux native
and deterministic evidence cannot establish Windows-specific behavior. This
`NOT RUN` limitation alone does not block shared picker PR/merge; exact installed
MSI evidence remains required for Windows-specific changes and Windows releases.

Historical current-product evidence at commit `d1d7b32`: picker
`artifacts/desktop/20261021T000605-0794eb-01/` passed 20 named checks; full suite
`artifacts/desktop/20261021T000713-3bbdee-01/` passed 32. Both used executable
SHA-256 `7f8537ad38052330dc24e6029e7016b1ac08c0560f1268742cc607b75b9b1216`.
These passes did not erase earlier missing native keydown, unexpected date focus
loss, or WebDriver `RemoteDisconnected` observations. The retained baseline
failure at `artifacts/desktop/20261021T000007-f4af3b-01/` recorded only keyup during
caret deletion. The later Escape and transport fixes address their proven
causes; no causal fix is claimed for the separate historical date-focus
observation. The retained post-Escape full failure at
`artifacts/desktop/20261021T061902-b7fcdf-01/` passed all four native edit variants
before stopping on `RemoteDisconnected`. The subsequent transport regression
reproduced that failure class through the real proxy before fixing the caller.

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
