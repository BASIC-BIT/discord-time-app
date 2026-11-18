# Why the saved updater smoke failed

The saved evidence separates two problems. The final assertion checked a log containing only the pre-update app's output; it did not establish where the relaunched app was logging. Cleanup's uninstall succeeded, but Codex stopped during that uninstall and the runner never finalized its report. The precise missing-log mechanism and the trigger for Codex's shutdown remain UNKNOWN.

Recommendation: do not repeat installation to collect the same evidence again. First prepare capture of the relaunched process's actual log destination and logging errors. Any later approved run should execute in a user-opened standalone PowerShell so its lifetime does not depend on Codex staying open. Preserve the existing assertions and failed evidence. No updater behavior change is justified by these observations alone.

## What the final log assertion actually observed

The November 9 report captured 14 passing checks out of 15. Reset succeeded, the initial installation returned 0, and version 0.0.2 relaunched in 172.9 seconds with a healthy 0.0.2 sidecar and one listener. Both app and sidecar were High integrity.

The post-relaunch manifest request completed with HTTP 200 at **11:50:39 AM Eastern**. However, every before/after/failure log snapshot still ended at **11:47:47 AM**, when the 0.0.1 app logged its installation handoff and watchdog creation. The file did not even contain the relaunched app's startup line. This is more than a missing final phrase: the collector had no demonstrated access to the new process's output.

`Get-SmokeLog` reads `LOCALAPPDATA/<smoke identifier>/logs/*.log`. `Find-LogLine` searches that collected text. The checkpoint additionally searched the owner's inferred Local/Roaming profile candidates, but `resolvedLogPath` remained null. Process owner/profile and token integrity do not prove the path actually opened by its logger.

The earlier run's historical `Application version: 0.0.2` and `Up to date (0.0.2)` lines were recovered on November 5 from a retained file. At least that earlier application did emit the result its smoke assertion missed. It is not valid to turn the November 9 HTTP response into proof of the same result: HTTP completion does not prove application parsing/state transition, and November 9's new-process output was not captured.

### Explanations checked without running the app

- **Ordinary buffering is unlikely.** The pinned `tauri-plugin-log` 2.8.0 uses fern's writer output. Fern flushes after every record, and the rotating writer writes and flushes the file in that call. Waiting another arbitrary minute is not a supported fix.
- **The smoke timer is not the production 90-second delay.** The compiled smoke feature uses five seconds; the actual post-relaunch manifest request confirms the loop ran.
- **The exact saved MSI contains the expected application.** Read-only MSI table inspection identifies HammerOverlay Updater Smoke 0.0.2. Static cabinet extraction, without executing the executable, confirms its product version/name, smoke identifier and loopback manifest strings. The startup and up-to-date log strings are compiled into it.
- **Rotation alone is not established.** The surviving file and all snapshots retain the old process's handoff output. The saved evidence does not show a new-process startup record being collected and subsequently rotated away.

What cannot be recovered is the new process's actual logger destination, open-file identity, or stderr. A different destination, file-open/write failure or inherited-output problem remains possible. Fern reports file-logging errors to stderr, which was not retained for the MSI-launched app. There is insufficient evidence to select one of those mechanisms or patch around the assertion.

## What happened during cleanup

The following times are Eastern on November 9:

| Time | Saved evidence |
|---|---|
| 11:51:51.956 AM | Last `before-cleanup` report; failed/incomplete. |
| 11:51:54.941 AM | Windows Installer starts the removal transaction. |
| 11:51:55.092 AM | Windows Restart Manager session starts for that transaction. |
| 11:52:40.816 AM | Codex desktop logs its app-server connection stopping with `cause=stop_process`; that desktop session's logs end. |
| 11:52:57.374 AM | MsiInstaller event 1034 records removal of HammerOverlay Updater Smoke 0.0.2 with status **0**; event 11724 confirms successful removal. |
| 12:04:41.920 PM | A new Codex desktop session starts its app-server connection. |
| 12:06:13.958 PM | Chat settings/permissions are updated. |

The runner's cleanup calls `Remove-SmokeInstall`, which launches msiexec and waits synchronously for it to exit before writing `finishedAt`, the real-app isolation result and the final report. Codex stopped before the uninstall transaction finished. Loss of the host-managed runner during that interval is the strongest supported explanation for the absent finalization. The uninstall itself was not abandoned: it finished successfully seventeen seconds after the host stopped, and recovery also found zero smoke product registrations and no install directory.

The exact reason Codex stopped is not recorded in the inspected logs. Restart Manager was active, but the saved events contain no named shutdown list proving that it closed Codex. A manual exit or another host shutdown cause cannot be excluded. No matching PowerShell/app crash report or audited process-exit record was found. Do not present timing overlap as proof that the installer killed Codex.

This corrects the earlier suggestion that the permission change interrupted cleanup. That change was logged more than thirteen minutes after the successful removal, so it cannot explain the earlier gap by itself. The precise runner exit time/status is still not captured. The primary report must remain incomplete; independent installer events supplement it rather than rewriting it into a pass.

## Before another installed attempt

1. Review capture of the new process's actual open log path and logger errors. Continue to distinguish observed paths from inferred profile candidates. Do not substitute HTTP 200 for the up-to-date assertion.
2. Run any separately approved future attempt from a user-opened standalone PowerShell, retaining transcript and checkpoints. A Codex restart should not own the smoke runner's lifetime.
3. Keep the MSI exit/status evidence and final cleanup result independently visible. The existing primary report remains incomplete even though the removal is now independently proven successful.

No installation, app launch, elevation, process termination or source-code change was performed during this investigation. The MSI was read and its executable extracted only for static inspection. The original report, snapshots and transcript were not edited. All approvals for prior runs remain consumed.

## Evidence appendix

- Primary evidence directory: `api/reports/temporal-ml/updater-smoke-diagnostic-20261109-reset`.
- Curated new evidence: `saved-evidence-investigation.json` in that directory, including the Windows Installer success events and source-report hashes.
- Primary report: `updater-smoke-auto.json`; transcript: `updater-smoke-run.log`; stage reports/snapshots remain beside them.
- Manifest request/response log: `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261109-reset/manifest-requests.log`.
- Static executable: `static-msi/Path` in the primary evidence directory; SHA-256 `FD1AB5D7BF9D3AC1957A6563CBA474538BA609AEC3A976D353AB4EE47EF6CC58`. It was not executed.
- Application: `f3fd60975b718b4d8fb22193166de603789ad136`; attempted runner: `84dcb06d031c4db552a2b8ac8c13d143711112c8`.
- Pinned dependency sources inspected locally: `tauri-plugin-log-2.8.0/src/lib.rs`, `fern-0.7.1/src/log_impl.rs`, and `tauri-2.11.2/src/path/desktop.rs` in the Cargo registry cache.
- Codex stop evidence: `C:/Users/steve/AppData/Local/Codex/Logs/2026/11/09/codex-desktop-bf36dbc5-3ee2-4e63-93f9-09d79e16051a-53952-t0-i1-000059-1.log`, operational event at `2026-11-09T16:52:40.816Z`.
- Codex restart evidence: `codex-desktop-bc4436d8-f5b1-4495-bff9-e6dcfe40569e-40924-t0-i1-170439-0.log` in the same log directory, start at `2026-11-09T17:04:41.920Z`.
- Own chat event history places the settings update at `2026-11-09T17:06:13.958Z`; no sensitive message content was copied into this findings document.
