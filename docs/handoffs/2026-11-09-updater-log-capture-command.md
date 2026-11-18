# Prepared log-path and stderr capture

Historical command packet: this destination was consumed by the successful November 13 `auto` run. Do not run the command below again. See [current acceptance](2026-11-13-updater-acceptance.md) and use fresh scratch/output paths for any subsequent authorized attempt.

The runner now captures the relaunched smoke process's actual open log paths and stderr destination, rather than relying only on profile guesses. It also saves stderr from each app launch performed by the runner. The frozen application and MSI files are unchanged.

This is prepared and fixture-tested, **not an installed test result**. The command below has not been executed. Review the capture limitations before approving another single `auto` attempt. Preparation did not authorize or start one.

## What the next diagnostic will preserve

| Evidence | Report/file |
|---|---|
| Files actually open in the smoke process, ending in `.log` | `processEvidence.nativeCapture.LogPaths`, plus `openLogFiles` with PID, path, raw snapshot and any read error |
| One unambiguous observed log path | `processEvidence.resolvedLogPath`; remains null if none or multiple are observed |
| Actual native stderr destination | `stderrCapture.kind/path/snapshot/error` and the native metadata |
| Harness-launched app stderr | `smoke-launch-N.stderr.log`, with originating PID in `launchOutput` |
| Existing profile candidates | The original `logFiles` fields, kept distinct from observed handles |
| Capture helper identity | `captureHelperSha256`, alongside runner/application provenance |

The existing checkpoints before/after the final assertion and before cleanup preserve these observations. A failed log snapshot does not skip stderr capture, and vice versa. Snapshot errors remain visible and fail the diagnostic result. Raw file bytes are copied without changing their encoding. The original up-to-date assertion, timeout, reset checks, artifact checks and stop-on-failure behavior remain unchanged. Newly captured paths are diagnostic evidence, not an automatic replacement for the original assertion's input.

## Important limits

- This metadata probe is for native **x64 Windows**. It was calibrated with a real ordinary Windows PowerShell fixture process. It uses bounded native handle snapshots and reads only the pointer metadata needed to identify stderr. It does not write target memory, inject code, close target handles or consume pipe/console output.
- If stderr is a regular file, the runner resolves and snapshots it. If it is a pipe, console, absent or inaccessible, the report says so; it cannot retroactively redirect a process or invent missing output. The initial launch's redirected stream is recorded separately and is not automatically attributed to the MSI-launched replacement.
- Redirecting initial-launch stderr changes its startup handle environment and may affect descendant handle inheritance. If the failure disappears under capture, that is an instrumented result to investigate, not proof that the original uninstrumented path was fixed. Stdout and updater behavior were not changed.
- Native layout/permission failures remain explicit errors or UNKNOWN. Access to a High-integrity process and the actual MSI relaunch are still unverified by these non-elevated fixtures.
- A standalone shell removes the dependency on Codex's process lifetime. It does not prove that Windows Restart Manager can never close that shell.

## One standalone command, not executed

Open **Windows PowerShell yourself**, normally rather than as administrator, using the Start menu or Windows Terminal. Do not launch this command through Codex. Keep that window open until the command finishes.

Only after approving a new installed attempt, paste:

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\steve\.codex\worktrees\updater-smoke-diagnostics\discord-time-app\scripts\verify-installed-updater-smoke.ps1' -Leg auto -SkipBuild -KeepArtifacts -ApplicationCommit f3fd60975b718b4d8fb22193166de603789ad136 -WorkDir 'C:\Users\steve\AppData\Local\Temp\hammer-updater-diagnostic-20261109-native' -Output 'C:\Users\steve\.codex\worktrees\updater-smoke-diagnostics\discord-time-app\api\reports\temporal-ml\updater-smoke-diagnostic-20261109-native'
```

The script requests one native UAC approval for the isolated smoke product. BASIC handles it. There is no tray click in `auto`. Its existing MSI-exit-1618 retries remain part of the attempt. Do not rerun after failure or reuse its output directory. No other leg, rebuild, signing, merge or release is included.

All seven artifact files are already copied into the new scratch directory and hash-compared with the retained source. The new evidence destination is unused. No `-AllowStaleArtifacts` or internal elevation flags are needed. A successful run would finalize `updater-smoke-auto.json`; a failure should leave its checkpoints, raw snapshots, stderr files and transcript for diagnosis. Never replace an incomplete report with a fabricated pass.

## Validation and source references

Passed in Windows PowerShell 5.1:

- `scripts/test-updater-process-capture.ps1`: real fixture-owned log handle, actual native stderr file and contents, absent stderr, runner wrapper metadata despite unavailable owner query, and redirected-launch argument/provenance checks. The finite fixture exits normally without process termination.
- `scripts/test-updater-smoke-diagnostics.ps1`: raw observed-log/stderr snapshots, independent failures for each, checkpoint survival, cleanup failure, no next leg, UNKNOWN values and separate provenance.
- `scripts/test-updater-smoke-handoff.ps1`: both actual parent command paths still reach read-only child preflight and preserve required flags.

No application, MSI, elevation, real profile reset or broad build/test loop was run during preparation. No new dependency or driver was installed. The Windows metadata layout is documented by [NtQueryInformationProcess](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess) and the primary [phnt process](https://github.com/winsiderss/phnt/blob/master/ntpsapi.h) and [runtime structure](https://github.com/winsiderss/phnt/blob/master/ntrtl.h) definitions. Native internals can change, which is why the x64 guard and actual fixture calibration remain necessary.

## Evidence appendix

- Capture source commit: `9d5da98e2fbc9219beec456a0b7be98226bd6c74`, on local branch `codex/updater-log-path-capture`. Later documentation-only checkpoints do not change that source.
- Runner SHA-256: `09984B12407B2E529B95FD79102B272E1A62DF4A81378C08C6AB0D79A9E4612A`.
- Native helper SHA-256: `253552967D09BDE12D2F8C5E93FAEBEEE50788EE76E0A58D15241ED64B882013`.
- Frozen application: `f3fd60975b718b4d8fb22193166de603789ad136`.
- Scratch/copy inventory: `C:/Users/steve/AppData/Local/Temp/hammer-updater-diagnostic-20261109-native/artifact-copy.json`.
- New evidence directory: `api/reports/temporal-ml/updater-smoke-diagnostic-20261109-native` in this worktree.
- Latest native calibration: `C:/Users/steve/AppData/Local/Temp/updater-capture-test-df9b90224eb940ca833ea57ba43efc54`.
- Snapshot/cleanup regression fixture: `C:/Users/steve/AppData/Local/Temp/updater-diagnostics-test-91573e08bbe2412e897a8500e8dad2cd`.
- Handoff regression fixture: `C:/Users/steve/AppData/Local/Temp/updater-handoff-test-151cbfa751e14379a072328bfa063517`.
- Prior findings and unchanged failed-run evidence: [saved-evidence investigation](2026-11-09-updater-saved-evidence-findings.md).
