# Auto-updater handoff (PR #29), 2026-11-04

Written at BASIC's wrap-up request. A fresh agent continues from here; the original session stays open but idle.

## State

- PR: https://github.com/BASIC-BIT/discord-time-app/pull/29 (ready for review, not draft). Branch `claude/dreamy-fermat-c562d2`. **Frozen head `f3fd609`** (the conductor's note said b214ea0; two more commit batches landed after it; f3fd609 is correct). Worktree: `D:\bench\discord-time-app\.claude\worktrees\awesome-swirles-2408a1`.
- CI on f3fd609: `Build and Test` success, `Claude review` run success. `cargo test` 62/62, clippy `--all-features -D warnings` clean, `npm run build` clean.
- Issue #27 (scope), #30 (hardening backlog incl. everything deferred from review rounds), #31 (log rotation).
- Spec: `docs/superpowers/specs/2026-11-04-auto-updater-design.md`. Plan: `docs/superpowers/plans/2026-11-04-auto-updater.md`. Runbook: `docs/UPDATER.md`.

## Review rounds (repo Claude reviewer edits comment 6636769184 in place; the desktop relay never shows edits, read it with `gh api repos/BASIC-BIT/discord-time-app/issues/comments/6636769184 --jq .body`)

1. 2a117d2: 5 findings (busy test, adopted sidecar in hook, total timeout, slow /health, window gaps) — fixed in 75498d3..0a615e2.
2. 0a615e2: 3 P1 (declined install leaves no app; dev builds auto-install prod MSI; stale evidence) + 2 P2 — fixed (watchdog, debug gate, probe retry, window copy) in e299e55..dcfde6b.
3. dcfde6b: watchdog only on launch path; deadline race; ready lock held; probe gating; toasts; tray during download; script Cargo.toml rewrite — fixed in d59eeaa..2e78ae3 (+ script 98332ba).
4. 2e78ae3: watchdog before msiexec appears; cap abandons relaunch; ready lock; Installing refusal — fixed in 316a717..e1d660d.
5. e1d660d: marker write blocks manual restart; Local SLM in-flight busy; stale artifacts — fixed in 98d6345..4e4ab13.
6. 4e4ab13: tray failure silent + **tray id "main" collided with the config tray (real bug)**; probe deadline; UpToDate clearing a hand-off — fixed in f4137ed..b214ea0 (+ integrity recording d4d1e35).
7. b214ea0: two tray icons (config + code); parse path could kill; unsupervised updater thread — fixed in abd2fdf..f3fd609 (single config tray with id `hammer-overlay-tray`, menu attached via `on_menu_event`).
8. f3fd609: 4 P2 (on-demand probe cost, startup probe on main thread, AlreadyReady re-check, two MSIs in memory) — **deferred to #30**, reply posted on the PR. The gate finding (P1) stays open until the smoke below.

## Smoke procedure (the merge gate, AGENTS.md:17)

- Script: `scripts/verify-installed-updater-smoke.ps1`. Run from a **normal (non-elevated)** PowerShell or the PowerShell tool, never from a Bash tool (its sandbox hides `%LOCALAPPDATA%`).
- MSIs are already built from f3fd609 under `C:\Users\steve\AppData\Local\Temp\claude\33c73b947736ac6f\f5fef4f5-59e2-4b6b-bf72-4e82b21e773a\scratchpad\smoke\artifacts\` (`new-0.0.1.msi`, `new-0.0.2.msi`, `old-0.0.1.msi` + `.sig`, `new.commit` = f3fd609...). If that scratch folder is gone, drop `-SkipBuild` and the script rebuilds in a temp git worktree (~12 min, unelevated, needs npm; `git status` must be clean for `src-tauri/Cargo.toml`/`Cargo.lock`).
- The elevated run **refuses stale artifacts**: it compares `new.commit` with `git rev-parse HEAD` and aborts (exit 99) unless `-AllowStaleArtifacts`. Never pass that switch for the gate.
- One UAC prompt (the script relaunches itself with RunAs). Inside the run no further prompts: the smoke app inherits the elevated token, so the user-facing UAC prompt and declining it are not exercised (disclosed in the PR body; `appRanElevated` in reports).
- Legs: `auto` (hidden overlay: no-server case keeps the app up, then auto-install on launch, relaunch as 0.0.2), `tray` (visible overlay defers with `Update 0.0.2 ready; restart to update`, next plain launch installs), `oldhop` (old-code MSI from df68d0d updated in place, orphaned sidecar handling), `kill` (hand-started sidecar reporting 0.0.9 is killed and respawned). `-Leg all` = those four, ~35 min, unattended. `click` is separate: after install and the ready line, **three beeps and a message box "Updater smoke: your turn"**; the operator clicks the tray icon "HammerOverlay Updater Smoke" → "Restart to update 0.0.2" within 180 s; then the script waits up to 600 s for the relaunch. `-Leg all,click` runs everything under one prompt (~40 min, operator needed near the end).
- Evidence: `api/reports/temporal-ml/updater-smoke-{auto,tray,oldhop,kill,click}.json` and `updater-smoke-run.log` (git-ignored). Each report carries `newMsisBuiltFrom`, `relaunchedIntegrity`/`elevated`, `sidecarIntegrity`.
- Dry-run history: all four unattended legs passed on the dcfde6b build (auto 13/13, tray 15/15, oldhop 12/12, kill 11/11). `click` has never passed (one run: BASIC missed the console prompt; the message box was added after). **No leg has run on f3fd609.**
- Safety: the smoke product is "HammerOverlay Updater Smoke" on parser port 8858; it never touches `C:\Program Files\HammerOverlay` (8857). The script uninstalls the smoke product and frees 8858/8859 at start and end.

## Before any release (BASIC)

- Signing-key custody: confirm the updater private key + password exist outside GitHub secrets and fill the "Custody outside GitHub verified on" line in `docs/UPDATER.md`; if missing, follow the rotation section there.
- Release notes must tell v0.1.5/v0.1.6 users to open "Check for Updates" → "Install Update" once (no background check in those versions).

## Verified vs assumed

- Verified (unit + code review): decision logic, lock order, watchdog script shape, sidecar probe parsing, release guard, docs.
- Verified on installed MSIs (dcfde6b build): launch auto-install, tray deferral then install, old-client hop, kill-and-respawn, watchdog present and cleaned up.
- Not yet verified: any leg on f3fd609; the tray click; the single-tray change (`abd2fdf`) visually; the relaunched app's integrity level; the watchdog actually relaunching after a declined/failed install (only observed waiting).
- Assumed: the MSI's `AUTOLAUNCHAPP` relaunch token (the smoke records it; if `High`, #30's plugin bump to 2.11 `restart_after_install(false)` is the fix).

## Prompt for a fresh agent (start it in `D:\bench\discord-time-app`)

```
You are finishing PR #29 (auto-updater) for BASIC-BIT/discord-time-app. Read docs/handoffs/2026-11-04-auto-updater.md in the worktree D:\bench\discord-time-app\.claude\worktrees\awesome-swirles-2408a1 first; it is the source of truth. Do not change code: the head f3fd609 is frozen for the merge gate. First three actions: (1) in that worktree run `git status --short` and `git rev-parse HEAD` and confirm HEAD is f3fd609 and the tree is clean; (2) confirm the smoke MSIs exist at the scratchpad path in the handoff and `new.commit` equals that HEAD (else rebuild with the script's -BuildOnly from a normal PowerShell, ~12 min); (3) ask BASIC for one UAC approval, then run from the PowerShell tool (never Bash): `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-installed-updater-smoke.ps1 -Leg all,click -SkipBuild -KeepArtifacts -WorkDir C:\Users\steve\AppData\Local\Temp\claude\33c73b947736ac6f\f5fef4f5-59e2-4b6b-bf72-4e82b21e773a\scratchpad\smoke` and tell BASIC to click the tray item "HammerOverlay Updater Smoke" -> "Restart to update 0.0.2" when the beeps and the "Updater smoke: your turn" box appear. If any leg fails, stop and report the failing check and log excerpt; never relaunch elevated without BASIC's word. On all five passing: paste a per-leg table (checks, elapsed, msiexec exit, relaunchedIntegrity) into the PR #29 body replacing the "Still owed" smoke lines, read the Claude review comment 6636769184 directly (it is edited in place) and reply if it raises anything new, then send the conductor session local_4a192d78-d101-4d8b-bcbf-d4625b773883 a three-line merge-ready packet: PR URL, head f3fd609, the asks (merge is BASIC's; custody check before release; if relaunchedIntegrity is High, note #30's plugin bump).
```
