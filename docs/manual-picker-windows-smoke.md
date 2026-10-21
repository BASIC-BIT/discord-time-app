# Installed Windows manual picker smoke record

**Result: NOT RUN — Windows access/tooling is unavailable in this cloud task.**
No MSI was built or installed here, and no Windows screenshots/video exist.
Linux evidence does not establish WebView2 or installed-app behavior. Under
`AGENTS.md`, desktop/runtime PR, merge, and release remain blocked until the
installed MSI path is smoke-tested. The existing Windows build job is retained;
its successful build alone cannot satisfy this record.

## Record to complete on the Windows test machine

| Field | Current value |
| --- | --- |
| Tested source commit / dirty state | NOT RUN (Linux source baseline: `d1d7b32`) |
| Build command / time / exit | NOT RUN |
| MSI absolute path / version / SHA-256 | NOT RUN |
| Installed EXE path / file version / SHA-256 | NOT RUN |
| Windows version / WebView2 runtime version | NOT RUN |
| Device IANA timezone / Windows timezone | NOT RUN |
| Desktop resolution / scaling / monitor arrangement | NOT RUN |
| Parser/API availability and provider mode | NOT RUN |
| Tester / test time | NOT RUN |
| Screenshot and finalized video directory | NOT RUN |
| Overall picker result / outstanding defects | NOT RUN |
| Separate installed routing smoke | NOT RUN — Windows/runtime prerequisites unavailable |

Record PASS, FAIL, or BLOCKED for each checklist row and attach exact clipboard
text, screenshot filenames, and video timestamps. Do not replace a failed row
with a later pass; retain both and identify the change tested.

## Build and install the exact MSI

Use the intended commit in a clean Windows checkout with Node 24, Rust and the
usual Tauri/MSVC/WebView2 prerequisites. In PowerShell at the checkout root:

```powershell
git rev-parse HEAD
git status --short
npm ci
npm --prefix api ci
npm run tauri:build -- --config src-tauri/tauri.ci.conf.json
Get-ChildItem src-tauri\target\release\bundle\msi\*.msi
```

Stop if any command fails. Select the newly built MSI by its exact absolute path
(do not silently choose a stale installer). Record and install it:

```powershell
$pickerMsi = 'C:\absolute\path\to\the-newly-built.msi'
Get-FileHash -Algorithm SHA256 -LiteralPath $pickerMsi
$pickerInstall = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $pickerMsi + '"'), '/passive', '/norestart') -Wait -PassThru
$pickerInstall.ExitCode # Record 0 or 3010; handle a required reboot before testing.
```

Launch from the installed Start menu entry, with dev/source instances stopped.
Record the actual process executable path, its file version and SHA-256; verify
that it belongs to this installation, not `src-tauri\target`. Retain the build
and installer logs. Do not copy API keys, `.env` files, or authentication headers
into evidence. Use offline parsing for these picker checks; no model is needed.

## Exact fixtures in the actual device timezone

Do not silently change the machine timezone to match Linux's UTC fixtures. Obtain
the IANA zone from the app's editor and compare it with the Node Intl zone below;
record both and stop if they disagree. Record `Get-TimeZone` as well. Use Intl to
derive local date/time fields for these known instants (the displayed date may
differ from UTC):

```powershell
Get-TimeZone
@'
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  timeZoneName: 'longOffset'
});
for (const epoch of [1781101800, 1780000000, 1780000060]) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(epoch * 1000)).map(x => [x.type, x.value]));
  console.log(JSON.stringify({zone, epoch, date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`, offset: p.timeZoneName}));
}
'@ | node
```

If one of these local wall times repeats in that timezone, select the recorded
offset explicitly. Inputs represent the local calendar/time shown above; exact
expected output remains the epoch below. Preserve seconds, including `40` in
the parsed/adjusted pair. Use an editor outside the app to inspect pasted
clipboard contents after each explicit copy.

## Picker acceptance checklist

Every row is **NOT RUN** until the Windows tester records an outcome.

| Check | Procedure and exact expected behavior | Result |
| --- | --- | --- |
| New manual timestamp | Put `fixture` in the clipboard, open via Ctrl+Shift+H, open calendar; Date receives focus, seconds initially `00`, original input disabled, copy rows hidden. Enter fields derived from epoch `1781101800`; Apply produces seven previews, Manual provenance and selected `<t:1781101800:f>`. Apply leaves clipboard and overlay unchanged. A separate Enter copies that exact code and hides. | NOT RUN |
| Adjust parsed timestamp | Put `<t:1780000000:F>` in clipboard and reopen; confirm seven previews and `F` selected. Activate the single result edit button; fields equal the Intl conversion with seconds `40`. Change to the fields for `1780000060`, Apply; `F` remains selected, clipboard unchanged and overlay visible. Separate Enter copies exactly `<t:1780000060:F>` and hides. | NOT RUN |
| Cancel and opener focus | Reopen a known single result, edit fields and Cancel. Original epoch/format remain; focus returns to the result opener. Repeat via calendar opener and Escape reaching the inline editor; focus returns to calendar without copying or hiding. Escape after editor closes dismisses normally. | NOT RUN |
| Return to text | Apply a different manual instant while retaining `<t:1780000000:F>` text. Use text reparses to `1780000000` and removes Manual provenance. Editing text also resumes parsing. | NOT RUN |
| Clipboard replacement | Reopen imported `<t:1780000000:F>`, Ctrl+A and paste `<t:1780000000:t> - <t:1780003600:t>`; full text replaces import and five range rows appear. Reopen original token for each selected-all typing, partial format typing, insertion, deletion; edits must persist. | NOT RUN |
| Field and popup keys | With editor open, use arrows, Tab/Shift+Tab in native date/time fields and their popup. Selection/copy shortcuts must not fire. Native popup Escape may close the popup first; a subsequent Escape reaching the editor cancels, without dismissing the overlay. Enter in the editor applies only, never copies; deliberate subsequent Enter on result copies. | NOT RUN |
| Button and row keys | Tab reaches calendar/result/Use text actions and Enter/Space activates each. Apply focuses selected row; Tab can leave the format group. Focus a different result row and Space copies that row's exact code. | NOT RUN |
| Invalid fields | Clear Date or Time; incomplete input shows associated validation, Apply cannot commit, and clipboard stays unchanged. Restore valid fields and verify error clears. | NOT RUN |
| Draft lifetime and range | With a draft open, Escape cancels and another Escape dismisses; reopen imports current clipboard without stale draft. From a range, Cancel preserves it; Apply deliberately creates one manual timestamp with `f`. | NOT RUN |
| Short/edge desktop | Record resolution/scaling. Test the 480px overlay near each edge and on a short usable desktop. Open calendar/time popups, navigate by keyboard, reach Apply/Cancel and all seven result rows by scrolling. No clipped essential control, accidental copy/dismissal or focus loss. Capture static screenshots and transitions. | NOT RUN |
| API unavailable | In a separately recorded installed-app session where its parser API is verifiably unavailable, open calendar, choose a known instant, Apply and copy exact output. Record how API absence was established; do not substitute a dev instance or kill unrelated services. | NOT RUN |
| Pending parse | During an actually pending parse, open editor and Cancel; unchanged text work resumes. On a separate pending parse, apply manual time and verify any later completion cannot overwrite epoch, format, error or provenance. If no pending work can be observed offline, record this row BLOCKED; do not provision a model for it. Controlled Linux race evidence is separate. | NOT RUN |

## DST checks with explicit fixture constraints

For exact DST fixtures below, the test device/browser must report
`America/New_York`. Use a separately provisioned device/session with that zone,
or explicitly obtain and record approval for a temporary timezone change and
restore it afterward. If unavailable, mark these rows BLOCKED and record the
actual device zone; an ordinary-zone test is not DST proof.

| Check (America/New_York only) | Exact expected result | Result |
| --- | --- | --- |
| Gap `2026-03-08 02:30:00` | Validation error and no Apply; must not silently advance to 03:30. | NOT RUN |
| Fold `2026-11-01 01:30:00`, new draft | Require explicit choice between UTC−04:00 and UTC−05:00; first maps to `1793511000`, second to `1793514600`. | NOT RUN |
| Existing fold instant | Import each `<t:1793511000:F>` and `<t:1793514600:F>`, open edit, confirm actual offset preselected, Apply unchanged and copy exact original code. | NOT RUN |
| Changed fold wall time | Change date/time after an offset choice; previous choice is invalidated and a repeated time again needs an explicit choice. | NOT RUN |

## Separate installed routing smoke

`npm run verify:installed:routing-smoke` is a separate installed Routing Smoke
build/runtime check; it does **not** exercise the picker. Read
[`scripts/verify-installed-routing-smoke.ps1`](../scripts/verify-installed-routing-smoke.ps1)
before invoking it. It expects an exact Routing Smoke MSI/hash and installation
root, its isolated API at `127.0.0.1:8858`, and the configured model served at
`http://127.0.0.1:8771/v1` with the expected model identity and chat settings.
The script has historical MSI/hash defaults; explicitly pass the actual intended
values rather than using those defaults for a newer build. The standard picker
MSI above is not a replacement for its special build.

When that already-authorized runtime and Windows prerequisites are available,
record the command with `-MsiPath`, `-ExpectedMsiSha256`, `-InstallRoot`,
`-ModelBaseUrl`, `-ExpectedModel` and `-Output` as appropriate, using
`npm run verify:installed:routing-smoke -- ...`. Save the generated report and
exit status separately from this checklist. Current result: **NOT RUN**, no
Windows access or model runtime verification performed. Do not provision/train
models merely to fill this record.
