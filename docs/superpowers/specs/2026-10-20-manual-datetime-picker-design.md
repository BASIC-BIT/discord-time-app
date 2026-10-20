# Manual date/time picker

Status: proposed design for review before the combined implementation plan.

## Intent and scope

Support two equally important journeys in the desktop overlay: choose an exact date/time from scratch, and adjust an existing parsed timestamp. Reuse the existing seven Discord previews, format selection, and copy action. Keep the collapsed overlay compact and preserve the current natural-language workflow.

Use an inline editor with native HTML date and time controls, opened by a calendar button beside the text input. Make the existing single-timestamp result card an accessible edit button that opens the same editor. Native controls provide calendar/time input without a date-picker library or a separate application window. Device timezone is the only timezone in v1; display its name and the selected date's UTC offset. Range endpoint editing and timezone selection are outside this change.

## Interaction

Opening the editor creates a draft. For a resolved single timestamp, populate it from that instant in the device timezone and preserve its seconds. Otherwise, initialize it to today's date and the current local minute, with seconds set to zero. Freeze that initial value; do not advance the fields with the clock. Existing ranges remain intact until an explicit apply; their result cards do not become endpoint editors.

Show labeled Date and Time fields, including seconds, followed by **Use date/time** and **Cancel**. Hide copyable result rows while editing so a draft cannot accidentally copy an older result. Keep the original text intact but disable text editing until the draft is applied or cancelled.

**Use date/time** validates the draft, commits one epoch, collapses the editor, and renders the usual format rows. It never copies or closes the overlay. Preserve the selected format when adjusting a single timestamp; for a new manual timestamp, select Short Date/Time, `:f`. Applying from a range creates a single timestamp explicitly rather than silently editing one endpoint.

Mark the committed result as **Manual** so retained natural-language text cannot be mistaken for its source. Editing the text returns to normal parsing and removes that manual override. Provide a small **Use text** action beside the manual result to reparse the unchanged original text. Clicking the manual result reopens the same editor with its current value.

**Cancel** discards the draft and restores the previous result/text flow. If opening cancelled an unresolved parse, resume parsing the unchanged text on cancel. Do not restart a completed parse unnecessarily. Closing the overlay discards an uncommitted draft; reopening retains the app's existing clipboard-import behavior.

## Keyboard, focus, and sizing

Opening focuses the date field. Native fields own their arrow keys and Tab navigation; the overlay's format shortcuts must not intercept them. Enter in the editor applies a valid draft only. Stop that event from also reaching the overlay's copy handler. Escape reaching the inline editor cancels it; Escape with the editor closed keeps the current overlay-dismissal behavior. Native date/time popups retain their own keyboard behavior.

Cancel restores focus to the opener. Apply moves focus to the selected result so a subsequent deliberate Enter can copy normally. Give buttons accessible names, expose expanded state on the calendar button, associate validation errors with fields, and update the footer hint while editing.

Keep the existing 480px width. Include editor visibility and validation changes in content-driven native resizing, ensure controls/popups remain usable near screen edges, and keep result content scrollable if it exceeds the available desktop height. Verify native popup, focus, and Escape behavior in Linux and the installed Windows app.

## Correctness and ownership

Resolve local calendar fields to an instant deterministically in the frontend; manual selection works without a parser API or model. Use the Temporal polyfill already used by the API, declared directly as a frontend dependency, through a small conversion helper. Do not import server modules or create a shared parsing framework.

Reject invalid dates, incomplete fields, and epochs outside the existing shared timestamp-routing bounds. A daylight-saving gap must show an error instead of silently advancing the time. If a local time occurs twice, show the two UTC-offset choices and require an explicit selection. When editing an existing instant in that repeated hour, preselect its actual offset so applying an unchanged draft preserves the epoch. Changing the date/time invalidates an earlier offset choice.

Opening the editor suspends text parsing and cancels outstanding parse/verification work and progress timers. Applying a manual result makes it authoritative until the user returns to text input. Guard every asynchronous result, error, progress update, and finalizer against the active input revision; aborting requests alone is insufficient. Late parser work must not overwrite the manual epoch, format selection, error state, or provenance. Clear the old generation association so a manual copy is not reported as acceptance of the model's answer.

Keep responsibilities small: an editor component owns field presentation, draft validation, and apply/cancel events; a conversion helper owns calendar/instant arithmetic; `Overlay` owns the committed result, parsing lifecycle, selected format, and existing copy actions. Represent draft visibility and text/manual ownership explicitly. Do not refactor unrelated settings, statistics, or parser architecture.

## Acceptance and combined delivery

Add these scenarios to the cloud desktop runner from the companion Linux design:

- Open with no result, choose a known date/time, apply, and copy the exact expected epoch/format.
- Parse a known timestamp, open its result, adjust it, preserve format selection, and copy the changed epoch.
- Cancel an edit without changing a completed result; cancel an edit opened during parsing and resume the text flow.
- Use arrows/Tab/Enter/Escape in fields without changing result selection, copying, or dismissing the overlay unexpectedly.
- Return from a manual override to the retained text, and close/reopen without retaining a stale draft.
- Exercise invalid input, native resizing, focus restoration, and calendar popup placement with screenshots and desktop video.

Use focused deterministic tests for exact epoch conversion, seconds preservation, bounds, daylight-saving gaps/repeated times, and a late parser response after a manual commit. The timing regression may control a pending response; the native end-to-end journeys still use the actual application and sidecar. Capture meaningful states for coding-agent visual review.

The combined implementation plan starts with a usable Linux runner, then implements the picker and adds its scenarios. The cloud design's repeat-run qualification is required before enforcing a CI gate, not before beginning picker work. Installed Windows MSI evidence remains required for the desktop changes under `AGENTS.md`.
