# Temporal Plan-IR Audit

## Current Shape

The current Plan-IR is a small executable plan language:

- Planner output: `outcome`, `reason`, optional `clarificationQuestion`, and up to four `plans`.
- Plan: `label`, `rationale`, `assumptions`, `confidence`, optional `finalStep`, and ordered `steps`.
- Step operations: `resolve_calendar_query`, `resolve_weekday_anchor`, `resolve_holiday`, `resolve_clock_time`, `interpret_clock_phrase`, `shift_datetime`, `set_clock_time`, `combine_date_time`, and `propose_candidate`.
- Executor output: deterministic candidates, candidate sets, clarification alternatives, validation results, and debug trace.

This is intentionally not a final timestamp format. It is a semantic parse that deterministic tools can execute.

## RFC 5545/iCalendar Concepts Worth Mapping

RFC 5545 covers more than recurrence. Useful concepts for our IR include:

- Value types: `DATE`, `DATE-TIME`, `TIME`, `DURATION`, `PERIOD`, `UTC-OFFSET`, and text values.
- Timezone reference: `TZID` parameters and timezone components.
- Event anchors: `DTSTART`, `DTEND`, `DURATION`, `SUMMARY`, `DESCRIPTION`, and `LOCATION`.
- Recurrence: `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID`, `COUNT`, `UNTIL`, `INTERVAL`, `BYDAY`, `BYMONTH`, `BYMONTHDAY`, `BYSETPOS`, and related rule parts.
- Components: `VEVENT`, `VTODO`, `VJOURNAL`, `VFREEBUSY`, `VTIMEZONE`, and `VALARM`.

## Mapping Guidance

Use RFC 5545 as an interoperability/export reference, not as the full internal IR.

Good mappings:

- Plan-IR candidate `isoInstant`/`zonedDateTime` -> `DTSTART`.
- Candidate precision `date` -> `VALUE=DATE` when exporting a date-only event.
- Candidate precision `datetime` -> `DATE-TIME` with `TZID` or UTC.
- Future duration/period concepts -> `DURATION` or `PERIOD`.
- Future recurrence branch -> `RRULE` plus optional `RDATE`/`EXDATE`.
- Event-post extracted title/location metadata, if added -> `SUMMARY`/`LOCATION`.

Poor mappings:

- Ambiguity alternatives do not map cleanly to one iCalendar component.
- Assumptions/provenance/debug trace are parser metadata, not calendar-event fields.
- Fuzzy semantic operations like `interpret_clock_phrase` are internal reasoning steps, not iCalendar concepts.
- Clarification questions are UX state, not iCalendar data.

## Gaps In Current Plan-IR

- No first-class recurrence representation.
- No duration/period result type beyond relative shifts.
- No event metadata fields such as title, location, start/end distinction, or multiple event times.
- No explicit unsupported/abstain reason per plan; `no_plan` exists only at planner-output level.
- No stable schema version field.
- No locale/calendar-system field beyond request context.
- No explicit confidence or provenance per step.
- No typed ambiguity object; ambiguity is expressed through `outcome=clarification`, labels, and multiple candidates.

## Recommended Near-Term Changes

- Add a schema version before generating large training datasets.
- Keep recurrence out of the first training target except as `no_plan`/unsupported examples.
- Add a separate optional export layer later: Plan-IR result -> iCalendar-ish object or Discord timestamp output.
- Add an execution-equivalence evaluator so training outputs can differ textually but still pass if they execute to the same expected result.
- Avoid broad natural-language heuristic tables in deterministic code; route fuzzy syntax to Plan-IR and let the model choose plans.

## Potential Future Recurrence Branch

If recurrence becomes product scope, add a branch like:

```json
{
  "kind": "recurrence",
  "dtstart": "2026-06-05T17:00:00-04:00[America/New_York]",
  "duration": null,
  "rrule": "FREQ=WEEKLY;BYDAY=FR",
  "rdate": [],
  "exdate": [],
  "assumptions": [],
  "provenance": "plan_ir"
}
```

Keep recurrence expansion deterministic and library-backed. Do not ask a model to calculate future occurrences directly.

## Training Implications

- Train text -> Plan-IR, not text -> RFC 5545.
- Add an optional Plan-IR -> iCalendar export task later if we want the model/dataset to be useful outside HammerOverlay.
- Include unsupported recurrence examples in early datasets so the model learns to abstain rather than pretending every schedule is a single timestamp.
