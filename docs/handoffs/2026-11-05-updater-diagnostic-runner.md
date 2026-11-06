# Diagnostic runner candidate for PR #29

Runner-only preparation is implemented in this isolated candidate. The recommendation is to review the two PowerShell files, then approve exactly one elevated `auto` diagnostic attempt. Application code and the frozen installer pair are unchanged. This candidate does not establish installed acceptance or explain the missing post-relaunch result.

The latest coordinator instruction permits this preparation under standing source authority. It preserves the frozen application checkout and artifacts, and keeps application P2 changes separate. No additional runner-preparation approval is requested. The elevated retry still requires BASIC's explicit approval after this instrumentation is reviewed.

## What changed

- The runner writes a provisional per-leg report before diagnostics and cleanup, keeps separate stage JSON/log snapshots, and finalizes cleanup success or failure afterward. An interrupted checkpoint remains explicitly incomplete.
- Checkpoints before/after the existing final `auto` log assertion capture process owner/profile, parent, path, installed version, app/sidecar integrity and health version. Snapshots cover the collector's smoke logs and, when known, the process owner's smoke log candidates. The actual runtime-resolved path stays UNKNOWN unless independently established. No process environment or arbitrary command-line capture was added.
- The manifest server records separate request and response JSON lines, attempted HTTP status, bytes successfully written, completion and errors. A completed response still does not prove the application processed it.
- The first failed leg or cleanup stops the sequence. The original final assertion and its 60-second wait remain intact. Existing installer exit-1618 retries remain in place and must be disclosed in any approved run.
- `-ApplicationCommit` explicitly distinguishes the frozen application from this runner candidate. It requires exact artifact stamp and matching application paths, refuses rebuild mode, and cannot be overridden by `-AllowStaleArtifacts`. Reports record runner base/tree state, dirty status, script SHA-256, application stamp and MSI hashes separately.
- Runtime preflight rejects reused reports/transcripts, manifest logs and installer logs before UAC. `-SkipBuild` no longer prunes build worktrees. A future run must use copies of the frozen artifacts in a fresh scratch directory and a fresh evidence directory.

## Review scope and verification

Changed source files:

- [Diagnostic runner](../../scripts/verify-installed-updater-smoke.ps1)
- [Offline regressions](../../scripts/test-updater-smoke-diagnostics.ps1)
- [Serialized HTTP loopback regression](../../scripts/test-updater-smoke-http.ps1)

Run the offline checks from this candidate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-updater-smoke-diagnostics.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-updater-smoke-http.ps1
```

Both checks parse the runner and load selected function definitions without executing its entry point. They never start the application, call the installer, terminate a process or elevate. The diagnostic checks use fixture process/token responses, in-memory response streams and a new temporary Git repository with signing and hooks disabled. The HTTP check starts one hidden, ordinary PowerShell child serving harmless fixture files on an ephemeral loopback port. It uses the exact script serialized by `Start-ManifestServer`, bounding only its request count and accept wait so it exits without a process-stop helper.

Observed red/green evidence: the original runner failed with `Missing durable diagnostic checkpoint helper.` After implementation, Windows PowerShell 5.1 checks passed for persistence before cleanup, injected cleanup failure, stopping before the next leg, successful continuation, unknown identity/token values, owner-profile file snapshots, independent stage reports, completed/interrupted/404 responses, runner-only provenance, rejection of changed application source and refusal to overwrite earlier evidence. `git diff --check` passed.

### Review correction: checkpoint IO cannot skip cleanup

The review found a bug in the first diagnostic candidate: `Invoke-ElevatedLegs` called `Save-SmokeCheckpoint` at the start of `finally` without a catch. Its report write could throw before either manifest-server cleanup or smoke uninstall was attempted.

Reproduced before fixing, with this regression failure: `Checkpoint failure skipped cleanup at before-cleanup. Escaped error: injected before-cleanup checkpoint write failure`.

The runner now catches both pre-cleanup and final-checkpoint write failures. Cleanup is still attempted, diagnostic failure makes the leg fail, and no later leg starts. Provisional reports retain `running` or `failed` status until successful finalization, so a failed final write cannot leave a provisional pass. If writes recover, the final failed report includes the diagnostic error. If output remains unwritable, a warning preserves the reason in console/transcript output where available and the runner returns failure; it cannot promise a JSON file on an unwritable destination.

Windows PowerShell 5.1 regressions passed for failure before cleanup, failure writing the final report, and all report writes failing. They verify both cleanup attempts, the failed result, no next leg, and retained diagnostic error/warning. The successful-leg cases also still pass.

### Real serialized HTTP evidence

The loopback regression passed on Windows PowerShell 5.1 with the actual serialized standalone `HttpListener` server. It verifies a completed manifest HTTP 200, a completed 404 without query disclosure, an interrupted 16 MiB fixture response from a client TCP reset, and another successful manifest request afterward. The four response records distinguish completion from interruption. The finite server exited normally; no application, installer, process-stop helper or elevation was used.

Steward subsequently reported an independent diagnostic-regression pass. Its independent HTTP attempt failed during `HttpListener` construction with `Operation is not supported on this platform`. That is separate environment evidence, not a replacement for this lane's retained Windows loopback pass. No fallback server or repeated passing streak was introduced to hide that failure.

Remaining gaps are real CIM owner/token access, cross-profile file permissions, and the installed relaunch. A completed HTTP response still does not prove the application processed an up-to-date result. No Rust/frontend build was rerun because application source did not change. The candidate is stopped for review; no installed retry follows from these checks.

## Next installed gate, not executed

Review preparation is complete. The runner source is committed, and all three frozen MSIs, their signatures and `new.commit` have been copied into a fresh scratch directory. Every copied file's SHA-256 equals its source; the three MSI hashes also equal the recorded baseline, and the application stamp still matches the frozen application. The evidence destination does not yet exist. Copy inventory and exact identities are in the appendix below.

**BASIC's explicit approval of a new installed attempt is still pending.** The previous run authorization is not reused. After that approval, execute this one command from a normal PowerShell, using the reviewed worktree as-is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\steve\.codex\worktrees\updater-smoke-diagnostics\discord-time-app\scripts\verify-installed-updater-smoke.ps1" -Leg auto -SkipBuild -KeepArtifacts -ApplicationCommit f3fd60975b718b4d8fb22193166de603789ad136 -WorkDir "C:\Users\steve\AppData\Local\Temp\hammer-updater-diagnostic-20261105-01a1a8be" -Output "C:\Users\steve\.codex\worktrees\updater-smoke-diagnostics\discord-time-app\api\reports\temporal-ml\updater-smoke-diagnostic-20261105-01a1a8be"
```

The command has not been executed. Do not point this candidate at the original failed-run scratch directory, replace its stamp, or rebuild/sign from the candidate. No `-AllowStaleArtifacts` is needed for this explicit runner/application split. Do not supply internal `-Elevated` or `-ViaRunAs` yourself. BASIC handles the native UAC prompt. There is no tray click in `auto`. A failure stops and preserves diagnostics; it does not authorize another elevated attempt.

Application P2 fixes, the remaining four installed legs, exact-candidate acceptance, post-window readiness review, merge, signing-key custody and release remain separate work. Do not call this runner candidate merge-ready or installed-tested.

## Candidate identity and preservation

- Branch: `codex/updater-smoke-diagnostics` in the managed worktree at `C:/Users/steve/.codex/worktrees/updater-smoke-diagnostics/discord-time-app`.
- Runner implementation commit: `3d1545f3214cd7d925dcf79e328695f7a1e1f5ef`, based on `64430992ef645d50159b0fe760e8f96b6652d7e2`. A subsequent documentation-only checkpoint records this run packet; it does not change the runner. No commit has been pushed.
- Runner file SHA-256: `2006CE27259126CDC8724D1702CB5E19B101CCFE58AB17AD4B780F2999EEB261`.
- Frozen application/MSI stamp: `f3fd60975b718b4d8fb22193166de603789ad136`.
- Frozen checkout: `D:/bench/discord-time-app/.claude/worktrees/awesome-swirles-2408a1`.
- Earlier diagnosis and artifact hashes remain in that checkout's `docs/handoffs/2026-11-05-updater-smoke-diagnosis.md`.
- Review-correction diagnostic fixture: `C:/Users/steve/AppData/Local/Temp/updater-diagnostics-test-f58ea4616c96452aaf570fb5e5a659f7`.
- Actual serialized HTTP fixture: `C:/Users/steve/AppData/Local/Temp/updater-http-test-4004c8f19b534dbda7dbb32742559b9a`.
- Fresh scratch directory: `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261105-01a1a8be`.
- Copy inventory: `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261105-01a1a8be/artifact-copy.json`, including source/copy SHA-256 values for seven files. This is file identity evidence, not new cryptographic signature verification or installed acceptance.
- Future evidence directory: `C:/Users/steve/.codex/worktrees/updater-smoke-diagnostics/discord-time-app/api/reports/temporal-ml/updater-smoke-diagnostic-20261105-01a1a8be`. The final per-leg report will be `updater-smoke-auto.json`, with separate stage JSON/log snapshots and the run transcript beside it. The local manifest log will remain in the fresh scratch directory.

No remote post, push, merge, BuildOnly, MSI rebuild, signing, install, elevation or relaunch was performed during this preparation. The previously rejected status message to Steward was not retried.
