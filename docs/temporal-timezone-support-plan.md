# Temporal Timezone Support Plan

The current parser uses `calendarContext.timeZone` as the default when input text does not specify a timezone. Explicit timezone support should become a first-class Plan-IR/executor capability, not a pile of runtime synonym patches.

## Product Semantics

- If the user input does not specify a timezone, use the configured/request timezone.
- If the user input clearly specifies a timezone, resolve the event in that timezone and return the resulting instant.
- Final Discord output still renders from the resolved instant; Discord handles viewer-local display.
- Ambiguous timezone abbreviations should clarify or fail closed unless the context makes them safe.
- Prefer the user's likely civil-time intent over a brittle literal abbreviation when the evidence is strong. Example: `EST` in July in a US event post often means Eastern Time, not the fixed standard-time offset `UTC-05:00`; the parser should either normalize to `America/New_York` with a visible assumption or ask for clarification.

## Source Data

Use authoritative/generated data instead of a hand-maintained giant timezone table.

- IANA tz database: source of truth for region IDs and civil-time rules. IANA explicitly notes that identifiers are usually `Area/Location`, represent rulesets rather than simple current offsets, and that abbreviations such as `CST` and `IST` are ambiguous in practice.
- Runtime ICU/ECMAScript support: `Intl.supportedValuesOf('timeZone')` currently reports `418` supported zones in this Node runtime, grouped as `America=144`, `Asia=82`, `Europe=58`, `Africa=52`, `Pacific=38`, `Australia=11`, plus smaller areas. Use a generated snapshot/test from runtime support rather than committing a manually typed list.
- Unicode CLDR: source for localized display names, metazones such as Eastern Time or Central European Time, and Windows timezone mappings.
- RFC 3339 / ISO 8601 profile: source for unambiguous `Z` and numeric offset forms such as `-04:00`; these identify an offset instant relationship but do not carry regional DST rules.

References:

- IANA theory: `https://data.iana.org/time-zones/theory.html`
- CLDR time zone names: `https://unicode-org.github.io/cldr/ldml/tr35-dates.html#Time_Zone_Names`
- RFC 3339: `https://www.rfc-editor.org/rfc/rfc3339`

## Representation Taxonomy

The SLM and eval corpus should cover timezone representations far beyond exact IANA IDs.

- Exact IANA IDs: `America/New_York`, `America/Los_Angeles`, `Europe/London`, `Europe/Paris`, `Asia/Tokyo`, `Australia/Sydney`, including slash, underscore, casing, and pasted bracket forms such as `[America/New_York]`.
- Backward-compatible or runtime aliases: legacy forms such as `US/Eastern`, `US/Pacific`, `Asia/Calcutta`, `Asia/Katmandu`, and names that runtime APIs accept even when the modern spelling differs.
- UTC forms: `UTC`, `UT`, `GMT`, `Z`, `Zulu`, `Etc/UTC`, `Etc/GMT`, `UTC time`, `GMT time`.
- Numeric offsets: `+09:00`, `-04:00`, `+0900`, `-0400`, `UTC+9`, `GMT-5`, `UTC + 09`, `GMT+05:30`, `+05:45`, and uncommon quarter-hour offsets.
- RFC/ISO-like timestamps: `2026-05-29T19:00:00Z`, `2026-05-29 19:00 -04:00`, `20260529T190000Z`, and pasted strings that combine date, time, offset, and zone ID.
- Regional family names: `Eastern`, `Central`, `Mountain`, `Pacific`, `Atlantic`, `Alaska`, `Hawaii`, `UK time`, `Irish time`, `Western Europe`, `Central Europe`, `Japan time`, `Tokyo time`, `JP time`, `Sydney time`, `Melbourne time`, `Brisbane time`, `Perth time`.
- Abbreviations and paired DST names: `EST`/`EDT`, `CST`/`CDT`, `MST`/`MDT`, `PST`/`PDT`, `AKST`/`AKDT`, `HST`, `GMT`/`BST`, `CET`/`CEST`, `WET`/`WEST`, `EET`/`EEST`, `JST`, `KST`, `AEST`/`AEDT`, `ACST`/`ACDT`, `AWST`, `NZST`/`NZDT`.
- Highly ambiguous abbreviations: `IST` can mean India, Irish, or Israel; `CST` can mean North American Central, China, or Cuba; `BST` can mean British Summer or Bangladesh; `PST` can mean Pacific or Philippine in historical/IANA abbreviation contexts. These should clarify unless surrounding text strongly disambiguates.
- Colloquial location phrases: `east coast`, `west coast`, `New York time`, `NYC time`, `LA time`, `California time`, `Japan`, `Tokyo`, `Australia eastern`, `Sydney/Melbourne`, `Europe time`, `UK`, `London`.
- Misrepresented and typo forms: `easternn`, `pacfic`, `japn time`, `tokoyo time`, `AESTD`, `EDST`, missing spaces like `7pmET`, punctuation like `7pm (ET)`, casing variants like `est`, and copied event suffixes like `Doors 8PM ET / 5PM PT`.

## Deterministic Boundary

Deterministic code can mechanically validate and normalize explicit timezone tokens after a model or parser has identified them.

Reasonable deterministic resolver inputs:

- Exact IANA names: `America/New_York`, `Europe/Paris`, `Asia/Tokyo`.
- UTC/Z forms: `UTC`, `Z`, `+00:00`, `-05:00`.
- Product-approved unambiguous labels only when the mapping is documented and DST behavior is explicit.

Avoid deterministic semantic guessing for broad natural language such as `JP time`, `eastern`, or `pacific` unless the model emits a resolved timezone candidate and deterministic code can validate or ask clarification.

The deterministic resolver should return structured candidates, not just a string. Candidate metadata should include `kind` (`iana`, `fixed_offset`, `alias`, `abbreviation`, `ambiguous`), `ianaZone`, `fixedOffsetMinutes`, `sourceText`, `normalizedLabel`, `isDstSensitive`, `ambiguityGroup`, and `assumptions`.

## DST And Intent Policy

Daylight saving time affects both the actual offset and what users type. The parser should model both.

- IANA zones are rulesets, not offsets. `America/New_York` can be `UTC-05:00` or `UTC-04:00` depending on the event date.
- Numeric offsets are literal. `7pm -05:00` means fixed offset `-05:00`, even if New York would be on daylight time that day.
- Generic regional terms should use the event date's correct offset. `7pm Eastern` in July should resolve through a region such as `America/New_York` and produce an EDT-offset instant.
- Standard/daylight abbreviation mismatch should be treated as likely colloquial region intent when context is strong. `7pm EST` in July in a US event post should not silently use fixed `UTC-05:00`; it should either interpret as Eastern Time with an assumption or ask whether the user meant fixed EST or US Eastern local time.
- Abbreviation-only forms with global ambiguity should clarify. `7pm CST` without region context should offer at least North American Central, China, and Cuba if the product supports them, or ask for a region.
- Nonexistent local times during spring-forward transitions should not roll forward silently. Example: `2:30am America/New_York` on DST start day should ask for clarification or fail closed.
- Ambiguous repeated local times during fall-back transitions should clarify first occurrence versus second occurrence unless the input includes a fixed offset or additional context.
- Zones without DST, such as `Asia/Tokyo`, `Australia/Brisbane`, `Australia/Perth`, `America/Phoenix`, and `Pacific/Honolulu`, need explicit coverage so the model does not assume every regional label has standard/daylight pairs.

## Plan-IR Changes

Add timezone support to Plan-IR in a way that keeps math deterministic.

Candidate options:

- Add a `resolve_timezone` step that returns one or more timezone candidates.
- Allow calendar resolution steps to accept a resolved timezone reference.
- Allow `set_clock_time` and `shift_datetime` to preserve or override timezone explicitly.
- Include timezone provenance in candidate assumptions and validation output.
- Add explicit candidate fields such as `timeZone`, `timeZoneSource`, `timeZoneAssumption`, and `fixedOffsetMinutes` where appropriate.
- Allow `ask_clarification` plans to present timezone alternatives without losing the already-resolved date and clock.

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
- Abbreviation mismatch by season, such as `EST` in July and `EDT` in January.
- DST gap and fold local times.
- No-DST regional zones, such as Phoenix, Honolulu, Tokyo, Brisbane, Perth.
- Multiple timezone mentions in one event post, such as `8pm ET / 5pm PT`.
- Typo/noise wrappers around timezone text.

Examples to include after semantics are finalized:

- `may 29 7pm America/New_York`
- `may 29 7pm UTC`
- `may 29 7pm +09:00`
- `tomorrow 8pm Europe/Paris`
- `event starts at 8pm ET`
- `friday 9pm PT`
- `july 12 7pm EST`
- `jan 12 7pm EDT`
- `march 8 2026 2:30am America/New_York`
- `nov 1 2026 1:30am America/New_York`
- `doors at 8pm ET / 5pm PT`

## Training Distribution

Timezone rows should be weighted by product likelihood, not uniformly over all zones.

- High weight: United States and Canada event zones: Eastern, Central, Mountain, Pacific, Alaska, Hawaii, Arizona/Phoenix, major city phrases, and `ET`/`PT` style abbreviations.
- High weight: Japan: `Asia/Tokyo`, `JST`, `Japan time`, `Tokyo time`, `JP time`, typo variants, and no-DST counterexamples.
- High weight: Australia: `AEST`/`AEDT`, `ACST`/`ACDT`, `AWST`, Sydney, Melbourne, Brisbane, Perth, Adelaide, Darwin, and the fact that Brisbane and Perth do not follow Sydney/Melbourne DST behavior.
- High weight: Western Europe: London/UK/GMT/BST, Dublin/Irish time, Paris/Berlin/Madrid/Rome/Amsterdam/CET/CEST, Lisbon/WET/WEST.
- Medium weight: India, Korea, China, Singapore, New Zealand, Brazil, Mexico, South Africa, and common global business/event zones.
- Long-tail sweep: stratified examples from every runtime-supported IANA area, including unusual offsets (`Asia/Katmandu`/`Asia/Kathmandu`, `Australia/Eucla`, `Pacific/Chatham`), date-line zones, and legacy aliases.
- Holdouts: reserve some zones, aliases, abbreviation-season mismatches, and DST transitions from training so evals measure generalization instead of memorization.
- Balance: keep timezone rows mixed with clean no-timezone examples so the model does not hallucinate timezone assumptions when none are present.

## Implementation Sequence

1. Extend Plan-IR schema with timezone resolution primitives.
2. Generate a timezone registry from runtime IANA support plus curated aliases and ambiguity groups.
3. Add deterministic timezone validation helpers for IANA, aliases, abbreviations, and offset forms.
4. Add executor support for timezone-bearing anchor and clock steps.
5. Add hand-written evals for the families above.
6. Add synthetic data rows and tagged timezone coverage with weighted region sampling.
7. Retrain/evaluate the SLM only after the executor semantics are stable.
8. Update UI/settings docs for configured default timezone and explicit-timezone provenance.

## Open Questions

- Should `ET`, `PT`, and similar abbreviations produce clarification by default, or map to a region when the date disambiguates standard/daylight time?
- Should offset-only inputs preserve a fixed offset candidate, or normalize to UTC after resolving the instant?
- How should the UI present that a timezone was explicitly supplied versus defaulted?
- Should API clients be able to force clarification for all abbreviation inputs?
