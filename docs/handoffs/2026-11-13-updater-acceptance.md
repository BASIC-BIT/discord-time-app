# PR #29 installed acceptance

The November 13 standalone `auto` attempt passed all 15 checks and finalized cleanup. The frozen application remains unchanged. This closes the repeated final-log-check blocker for this instrumented attempt, without establishing the cause of earlier failures.

Four installed scenarios now pass. The operator-assisted `click` scenario timed out without a recorded tray action, so PR #29 remains in validation until that scenario passes and the final pushed head's CI and feedback are reviewed. Merge and release are separate actions; neither is authorized here.

## Installed results

| Scenario | Current evidence | Outcome |
|---|---|---|
| Launch auto-install, unreachable endpoint and no loop | November 13 standalone run | Passed 15/15; 0.0.2 relaunched in 229.4 seconds; healthy 0.0.2 sidecar and one listener |
| Visible-window deferral, then next-launch install | November 13 standalone run, runner `c12fc8e` | Passed 17/17; ready in 7.1 seconds; next-launch relaunch in 232.6 seconds; finalized cleanup |
| Old-client upgrade with orphaned sidecar | November 13 standalone run, runner `c12fc8e` | Passed 14/14; MSI exit 0; Restart Manager closed the orphan; fresh 0.0.2 sidecar; finalized cleanup |
| Replace a sidecar reporting the wrong version | November 13 standalone run, runner `c12fc8e` | Passed 13/13; app replaced the 0.0.9 sidecar with a different process reporting 0.0.2; finalized cleanup |
| Actual tray-menu restart click | November 13 standalone run, runner `c12fc8e` | Failed: no click recorded within 180.1 seconds; report finalized, cleanup succeeded; not accepted yet |

The `auto` final log contains `Application version: 0.0.2` and `Up to date (0.0.2)`. Native open-handle capture independently resolved `LocalAppData/com.hammer-overlay.updater-smoke/logs/HammerOverlay Updater Smoke.log`, with no native errors or snapshot errors. The relaunched process had no stderr handle. The two harness-launch stderr files were empty. These are distinct observations, not inferred file destinations.

Sanitized reports for [auto](../evidence/updater-2026-11-13/auto.json), [tray](../evidence/updater-2026-11-13/tray.json), [oldhop](../evidence/updater-2026-11-13/oldhop.json), [kill](../evidence/updater-2026-11-13/kill.json) and the preserved [click timeout](../evidence/updater-2026-11-13/click-timeout.json) include source-report hashes. The three new passing reports have no diagnostic or cleanup errors and unchanged real-app PIDs. `kill` also captured the harness-launched installed app's actual regular-file stderr destination without native errors.

The remaining-scenarios run finished at 3:07:29 AM Eastern on November 13. The final click assertion failed before any recorded restart action; it does not establish that the tray handler is broken or working. The old prompt can be dismissed. A click-only retry requires fresh scratch/output paths and an available operator; it must preserve this failed attempt. An extra screenshot request during the timed step was withdrawn so that the actual click takes priority.

The final report has `status=passed`, `incomplete=false`, `stage=complete`, no diagnostic or cleanup error, and `realHammerOverlayPidsUnchanged=true`. Windows Installer independently recorded removal success status 0 at 1:55:11 AM Eastern, November 13. The smoke installation directory was absent afterward, the standalone runner exited and its transcript closed normally.

Both the app and sidecar ran at High integrity, inherited from the smoke harness's RunAs child. This does not establish the token obtained by an ordinary user update or exercise declining the app installer's UAC prompt. The initial stderr redirection can alter handle inheritance. This pass is not proof of the earlier missing-log mechanism or why Codex stopped on November 9.

## Maintained runner and review disposition

Retain the scoped provenance checks, fail-closed reset, actual parent-handoff coverage, raw log/stderr snapshots, response completion records, and checkpoints that survive cleanup interruption. These diagnose installer and runtime failures without changing the application. The native helper is guarded for x64 Windows and records unavailable metadata explicitly. Native metadata completeness must be assessed separately from smoke status.

The five harmless PowerShell fixture suites now run in Windows CI. Local Windows PowerShell 5.1 runs passed for diagnostics, actual serialized HTTP, parent handoff, reset and real process metadata capture. The HTTP fixture failed to construct `HttpListener` inside the restricted network sandbox, then passed outside that sandbox. The sandbox failure is retained as an environment limitation, not an application failure.

The first CI run found that the handoff fixture hardcoded a historical application commit missing from GitHub's shallow checkout. A fresh depth-one local clone reproduced the failure. The fixture now takes its checkout's own `HEAD` as the artifact baseline; shallow and full-checkout fixtures both pass, including the negative missing-`SkipBuild` case. Production provenance checks and the frozen application were unchanged.

Independent standards review found no blocking defect in the diagnostic delta. Independent spec review identified the remaining installed scenarios and the bounded window issue below. Neither review ran or substitutes for installed tests.

The diagnostic fixture also checks that the configured tray icon ID matches the Rust `TRAY_ID` used to attach its menu. An injected mismatch in a disposable checkout fails before smoke setup; the real configuration passes. This guards the string coupling identified by the PR review without changing the frozen application.

The `tray` run exposed a runner-only reporting bug: its nested next-launch dictionary lacked a leg name, so the helper saved unnamed checkpoint files. Nested capture errors could also be missed by the parent's finalization. The named tray report still finalized with 17 passing checks, no parent or nested diagnostic error, successful cleanup and unchanged real-app PIDs. Original files remain preserved, including the unnamed snapshots.

A separate checkout reproduced the checkpoint naming failure before the fix. The launch helper now accepts the parent checkpoint dictionary when called from `tray`, while keeping its default for direct `auto` calls. The regression exercises the real helper and leg orchestration: named parent snapshots, no anonymous report, successful continuation, and an injected nested capture failure that must fail the parent and stop the next leg. All five fixture suites pass; independent review found no blocker. This source correction did not drive the installed run, which remains attributed to `c12fc8e` and its recorded runner hash.

The prior four P2 items stay in #30: on-demand probe cost, blocking startup probe, `AlreadyReady` race and replacement-download memory. The additional update-window issue also belongs there: during a background manifest check, a cached update remains installable from the tray but the window temporarily shows a disabled check button. The check is bounded at 60 seconds. This limitation must remain disclosed until fixed; the frozen MSI does not include that future fix.

Signing-key custody outside GitHub remains an owner check before release. This validation does not inspect or copy private signing material, change signing, publish a release or deploy anything.

## Evidence appendix

- Frozen application: `f3fd60975b718b4d8fb22193166de603789ad136`.
- Successful `auto` runner: `c90b91288da4853166dd3e8976ce003b3529c227`, runner SHA-256 `09984B12407B2E529B95FD79102B272E1A62DF4A81378C08C6AB0D79A9E4612A`.
- Final `auto` report: `C:/Users/steve/.codex/worktrees/updater-smoke-diagnostics/discord-time-app/api/reports/temporal-ml/updater-smoke-diagnostic-20261109-native/updater-smoke-auto.json`.
- Before-cleanup native log snapshot: the same directory's `updater-smoke-auto-before-cleanup-open-log-0.log`.
- Native helper SHA-256 in that run: `51128C6673848A6E43A526126459C3A3AEF4EE97A0A9A6FBD6E8195434CE7A69`. The earlier packet's `253552...` hash is the same Git content with LF line endings; normalized content and the committed blob match. No helper source drift was found.
- MSI SHA-256, new 0.0.1: `1ECF5A3B18F873536E40B41ADF4C5ED871F97929A48FC201B11A78450F6E11B3`.
- MSI SHA-256, new 0.0.2: `F8DC02D8CC63188ECB34BA65E4EF3C02FA920314E8DB8064354002648A228F5D`.
- MSI SHA-256, old 0.0.1: `250706949A2D42F1ECA9FE5B640B9D7D7445554004B90C512C44C6221647A78B`.
- Earlier failures remain preserved in [the saved-evidence investigation](2026-11-09-updater-saved-evidence-findings.md). They are not retroactively marked passed.
