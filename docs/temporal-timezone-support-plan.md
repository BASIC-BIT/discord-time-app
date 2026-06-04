# Temporal Timezone Support Plan

The current parser uses `calendarContext.timeZone` as the default when input text does not specify a timezone. Explicit timezone support should become a first-class Plan-IR/executor capability, not a pile of runtime synonym patches.

## Product Semantics

- If the user input does not specify a timezone, use the configured/request timezone.
- If the user input clearly specifies a timezone, resolve the event in that timezone and return the resulting instant.
- Final Discord output still renders from the resolved instant; Discord handles viewer-local display.
- Ambiguous timezone abbreviations should clarify or fail closed unless the context makes them safe.

## Deterministic Boundary

Deterministic code can mechanically validate and normalize explicit timezone tokens after a model or parser has identified them.

Reasonable deterministic resolver inputs:

- Exact IANA names: `America/New_York`, `Europe/Paris`, `Asia/Tokyo`.
- UTC/Z forms: `UTC`, `Z`, `+00:00`, `-05:00`.
- Product-approved unambiguous labels only when the mapping is documented and DST behavior is explicit.

Avoid deterministic semantic guessing for broad natural language such as `JP time`, `eastern`, or `pacific` unless the model emits a resolved timezone candidate and deterministic code can validate or ask clarification.

## Plan-IR Changes

Add timezone support to Plan-IR in a way that keeps math deterministic.

Candidate options:

- Add a `resolve_timezone` step that returns one or more timezone candidates.
- Allow calendar resolution steps to accept a resolved timezone reference.
- Allow `set_clock_time` and `shift_datetime` to preserve or override timezone explicitly.
- Include timezone provenance in candidate assumptions and validation output.

The SLM should decide that the text contains a timezone phrase. The executor should validate the resolved timezone and perform calendar math.

## Evaluation Coverage

Required eval families:

- No explicit timezone uses request timezone.
- Explicit IANA timezone.
- Explicit UTC/Z/offset timezone.
- User timezone differs from event timezone.
- DST transition boundary for the event timezone.
- Abbreviation requiring clarification, such as `EST` versus `EDT` when context is insufficient.
- Common event prose with timezone suffix.
- Relative phrase anchored in an explicit timezone.

Examples to include after semantics are finalized:

- `may 29 7pm America/New_York`
- `may 29 7pm UTC`
- `may 29 7pm +09:00`
- `tomorrow 8pm Europe/Paris`
- `event starts at 8pm ET`
- `friday 9pm PT`

## Implementation Sequence

1. Extend Plan-IR schema with timezone resolution primitives.
2. Add deterministic timezone validation helpers for IANA and offset forms.
3. Add executor support for timezone-bearing anchor and clock steps.
4. Add hand-written evals for the families above.
5. Add synthetic data rows and tagged timezone coverage.
6. Retrain/evaluate the SLM only after the executor semantics are stable.
7. Update UI/settings docs for configured default timezone.

## Open Questions

- Should `ET`, `PT`, and similar abbreviations produce clarification by default, or map to a region when the date disambiguates standard/daylight time?
- Should offset-only inputs preserve a fixed offset candidate, or normalize to UTC after resolving the instant?
- How should the UI present that a timezone was explicitly supplied versus defaulted?
- Should API clients be able to force clarification for all abbreviation inputs?
