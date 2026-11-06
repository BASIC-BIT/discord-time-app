# Diagnostic runner candidate for PR #29

The corrected runner reached the smoke leg in the separately approved attempt, but failed its preparation check because old smoke log content remained after reset. It finalized diagnostics and cleanup, then stopped. No installation or app launch was reached. Application code and the frozen installer pair are unchanged. Both one-run approvals have been consumed; another elevated attempt is not authorized.

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
- [Actual child-handoff regression](../../scripts/test-updater-smoke-handoff.ps1)
- [Scoped reset-error regression](../../scripts/test-updater-smoke-reset.ps1)

Run the offline checks from this candidate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-updater-smoke-diagnostics.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-updater-smoke-http.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-updater-smoke-handoff.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-updater-smoke-reset.ps1
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

## Approved attempt result: failed before smoke

BASIC approved exactly one diagnostic attempt with `Approve one diagnostic run`. That attempt executed the prepared command below and returned exit code 1. The parent printed `auto    no report`. The evidence directory and transcript were not created; the smoke install directory was absent afterward. No installed checks ran, no MSI exit was captured, and relaunched integrity is UNKNOWN. No second elevated attempt was started.

Source inspection found a runner argument-forwarding bug. The parent forwards `-ApplicationCommit` but not `-SkipBuild` to its elevated child. The top-level guard rejects `ApplicationCommit` without `SkipBuild` before opening the transcript or entering a leg. This deterministically explains a pre-transcript failure for the prepared command, although the child console's error text was not retained. The offline helper regressions missed this entry-point handoff. This is a runner preparation defect, not evidence of an application updater failure.

The correction is committed separately. Both launch branches now forward `-SkipBuild` and use the existing canonical runner path. The frozen-artifact guard stays intact. This scoped source correction was authorized after the failed attempt; no second elevated run followed it. The single-run approval is consumed and is not reused.

The new non-elevated regression extracts and executes the actual parent handoff body, including its argument construction, instead of duplicating those strings. RunAs is intercepted, and the already-admin path is intercepted separately. Ordinary PowerShell fixture children bind the production parameter block, execute the actual frozen-mode guard and read-only artifact preflight, then stop. The OS privilege check and all transcript/smoke/build/install entry-point actions are excluded from these fixtures. They do not elevate or impersonate an administrator.

The regression reproduced the exact guard failure without `SkipBuild`, then passed for both paths after the fix. It verifies `SkipBuild`, `Elevated`, `ViaRunAs`, `ApplicationCommit`, leg, manifest port, old commit, output/work paths and the optional stale-artifact switch. `KeepArtifacts` belongs to parent cleanup; build-only options are not needed by a child forced into SkipBuild mode. This pass is argument/preflight evidence, not installed evidence.

### Fixture portability correction

Steward's independent handoff check then failed in the already-admin fixture because its host emitted the harmless Git warning `unable to access C:/Users/steve/.config/git/ignore: Permission denied`. Windows PowerShell wrapped the ordinary child's stderr as a terminating `NativeCommandError` under the fixture's `ErrorActionPreference = Stop`. That was fixture stderr handling, not evidence of a child mode-guard failure.

The test now relaxes that preference only around the direct native-child invocation, captures its exit code immediately, restores the original preference, and reads retained stderr separately. Both fixture children deliberately emit harmless stderr while exiting zero. An additional negative case omits SkipBuild only in the fixture adapter, proving the actual frozen-mode guard still returns nonzero and prevents preflight. The regression reproduced the harmless-stderr termination before this correction and passed afterward. No production runner behavior changed in this portability fix, and no installed attempt was made.

The local attempt record is `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261105-01a1a8be/attempt-result.json`. It preserves the parent console output, exit code, absence of reports, provenance and source finding. All seven copied artifact hashes still match the copy inventory. The frozen application and its original failed-run evidence were not changed.

## Corrected attempt: terminal failure during reset

BASIC separately approved `Approve one corrected attempt`. The reviewed runner ran from a clean `e73eb09` checkout on November 5 at 10:25:55 PM Eastern. It returned exit 1 after approximately 13.4 seconds, with a finalized `failed` report and no cleanup error.

| Observation | Terminal result |
|---|---|
| Checks | 0 passed, 1 failed: `Smoke log directory is empty before the leg.` |
| Checkpoint/final report | Saved; `stage=complete`, `incomplete=false` |
| Application installation and launch | NOT REACHED, reset precedes `Invoke-AutoLeg` |
| MSI installation exit | UNKNOWN/not observed; no install log was created |
| Relaunched app/sidecar token | UNKNOWN; no current-run relaunch occurred |
| Cleanup | Completed with no reported cleanup error |
| Real app isolation | `realHammerOverlayPidsUnchanged=true` |
| Frozen evidence | All seven original/copied artifact hashes still match |

The retained pre-cleanup snapshot contains historical `Application version: 0.0.2` at November 4, 7:28:44 PM Eastern, and `Up to date (0.0.2)` at 7:28:49 PM. These match the first attempt's relaunch/manifest timing and precede the corrected run by more than a day. The older application therefore did emit the previously missing result. This does not retroactively finalize the older failed run, establish its token integrity, or pass the current run. The precise collector/reset path or filesystem failure remains UNKNOWN; `Reset-SmokeData` suppresses removal errors, so the report cannot identify that cause.

Reports, transcript and historical log snapshot are preserved in the evidence directory below. `terminal-summary.json` records the terminal result separately from the runner's primary report. No second attempt, other leg, source fix, rebuild, signing, merge or release followed this failure. Investigation of the reset and collector paths should preserve the historical logs rather than silently deleting them or weakening the empty-log check.

### Bounded reset diagnosis and prepared diagnostic correction

Read-only inspection after terminal cleanup confirmed that the retained 6,815-byte log is under the current LocalAppData smoke reset root. Its attributes were Archive, with neither ReadOnly nor ReparsePoint set. Its ACL had inherited allow entries and no explicit deny; the owner was Administrators. These are current metadata observations, not proof that the earlier elevated removal had effective delete access or no sharing conflict. Neither the finalized report nor transcript retained an exact removal error. **The reset failure's historical filesystem cause remains UNKNOWN.**

The smallest runner-only diagnostic correction is implemented separately at `18e5129`. `Reset-SmokeData` now receives the existing leg report, records each of the same two roots before/after removal, and retains removal error message, error ID, category and target through PowerShell's ErrorVariable. It also warns with those details so they remain visible if report writing fails. It still removes only the original smoke identifier roots, with the same flags, and retains the exact empty-log assertion. No deletion-scope extension, assertion suppression, application change or elevated retry was made.

The fixture reproduced `Reset discarded exact removal errors` before this change, then passed after it. It intercepts Remove-Item, injects access-denied errors for exactly two fresh fixture roots, and verifies precise error fields, the unchanged guard, and preserved fixture content. A silent no-op case still fails the guard without fabricating an IO error. The existing cleanup/report diagnostic regression also passed after the caller update. These checks finished before the interruption and were not repeated merely to resume the chat.

Read-only observations are saved in `reset-readonly-observation.json` beside the finalized failed-run report. That report, transcript, snapshots and prepared MSI files were not modified by this source correction. The reset diagnostic has not run against real profile data. Review this small source change before considering another separately approved installed attempt.

## Executed corrected command, retained for traceability

Review preparation is complete. The runner source is committed, and all three frozen MSIs, their signatures and `new.commit` have been copied into a fresh scratch directory. Every copied file's SHA-256 equals its source; the three MSI hashes also equal the recorded baseline, and the application stamp still matches the frozen application. The evidence destination does not yet exist. Copy inventory and exact identities are in the appendix below.

**Do not replay this command.** It is the corrected attempt described above. Its one-run approval is consumed, and its evidence destination now contains the failed run. The earlier argument-handoff failure's command remains preserved in documentation checkpoint `cb16362`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\steve\.codex\worktrees\updater-smoke-diagnostics\discord-time-app\scripts\verify-installed-updater-smoke.ps1" -Leg auto -SkipBuild -KeepArtifacts -ApplicationCommit f3fd60975b718b4d8fb22193166de603789ad136 -WorkDir "C:\Users\steve\AppData\Local\Temp\hammer-updater-diagnostic-20261105-01a1a8be" -Output "C:\Users\steve\.codex\worktrees\updater-smoke-diagnostics\discord-time-app\api\reports\temporal-ml\updater-smoke-diagnostic-20261105-handoff-fixed"
```

Do not point this candidate at the original failed-run scratch directory, replace its stamp, or rebuild/sign from the candidate. No `-AllowStaleArtifacts` is needed for this explicit runner/application split. Do not supply internal `-Elevated` or `-ViaRunAs` yourself. BASIC handles the native UAC prompt. There is no tray click in `auto`. A failure does not authorize another elevated attempt.

Application P2 fixes, the remaining four installed legs, exact-candidate acceptance, post-window readiness review, merge, signing-key custody and release remain separate work. Do not call this runner candidate merge-ready or installed-tested.

## Candidate identity and preservation

- Branch: `codex/updater-smoke-diagnostics` in the managed worktree at `C:/Users/steve/.codex/worktrees/updater-smoke-diagnostics/discord-time-app`.
- Runner implementation commit: `3d1545f3214cd7d925dcf79e328695f7a1e1f5ef`, based on `64430992ef645d50159b0fe760e8f96b6652d7e2`. A subsequent documentation-only checkpoint records this run packet; it does not change the runner. No commit has been pushed.
- Corrected runner/handoff regression commit: `a04b420ae2a9bcea96e88832a98c770d938ac90d`, the production runner used by the corrected attempt.
- Attempted runner file SHA-256: `202592ED03CD6F9E4547D043855A383F694B797B12D8D77AA78CE8FA0F4BFB2D`.
- New reset-diagnostic source/fixture commit: `18e512948330b536aacba80094fce60f74d64385`; runner file SHA-256 `846A1FB9FBD09A2A607C8C4E5F10913E8C8A1938F88319337F5EB956760E9EA8`. This source has not been installed-tested.
- Frozen application/MSI stamp: `f3fd60975b718b4d8fb22193166de603789ad136`.
- Frozen checkout: `D:/bench/discord-time-app/.claude/worktrees/awesome-swirles-2408a1`.
- Earlier diagnosis and artifact hashes remain in that checkout's `docs/handoffs/2026-11-05-updater-smoke-diagnosis.md`.
- Review-correction diagnostic fixture: `C:/Users/steve/AppData/Local/Temp/updater-diagnostics-test-f58ea4616c96452aaf570fb5e5a659f7`.
- Actual serialized HTTP fixture: `C:/Users/steve/AppData/Local/Temp/updater-http-test-4004c8f19b534dbda7dbb32742559b9a`.
- Successful actual-handoff fixture: `C:/Users/steve/AppData/Local/Temp/updater-handoff-test-a43901580b9b42078329931f99cd62a9`.
- Latest handoff/stderr regression fixture: `C:/Users/steve/AppData/Local/Temp/updater-handoff-test-0119b651812644e291e241cad1cf895e`. Its two positive children reach preflight despite stderr; its negative child's stderr and nonzero exit remain observable.
- Reset-error fixture: `C:/Users/steve/AppData/Local/Temp/updater-reset-test-55f69da2cdd7472b9e30c4687aafd142`.
- Cleanup/report integration fixture after reset caller update: `C:/Users/steve/AppData/Local/Temp/updater-diagnostics-test-bc89eb7863e9488dbfde05b3c6716a41`.
- Fresh scratch directory: `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261105-01a1a8be`.
- Copy inventory: `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261105-01a1a8be/artifact-copy.json`, including source/copy SHA-256 values for seven files. This is file identity evidence, not new cryptographic signature verification or installed acceptance.
- Corrected-attempt evidence directory: `C:/Users/steve/.codex/worktrees/updater-smoke-diagnostics/discord-time-app/api/reports/temporal-ml/updater-smoke-diagnostic-20261105-handoff-fixed`. It contains the finalized `updater-smoke-auto.json`, `updater-smoke-auto-before-cleanup.json`, collected log snapshots, `updater-smoke-run.log` and `terminal-summary.json`. No manifest or installer log was created in the scratch during this attempt.
- Corrected-attempt runner head: `e73eb09205c74a307a5c16664e53813e92e8165a`; runner script SHA-256 remained `202592ED03CD6F9E4547D043855A383F694B797B12D8D77AA78CE8FA0F4BFB2D`.

Preparation performed no remote post, push, merge, BuildOnly, MSI rebuild, signing, install, elevation or relaunch. Two separately approved single elevated attempts are recorded above: the first failed its child-mode guard, the corrected one failed reset before installation or app launch. No approval was reused. The previously rejected status message to Steward was not retried.
