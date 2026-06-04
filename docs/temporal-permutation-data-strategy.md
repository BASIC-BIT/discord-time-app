# Temporal Permutation Data Strategy

## Goal

The local Temporal SLM should learn fuzzy interpretation from data while deterministic code remains responsible for timestamp arithmetic, validation, and formatting. We should prefer large, tagged training/eval datasets over app-code lookup tables for misspellings, shorthand, punctuation, casing, noisy pasted text, and other language variation.

## Core Pattern

Generate data from this shape:

```text
semantic base case + surface template + mutation axes + noise axes + split policy = row
```

The target Plan-IR should normalize fuzzy surface text into deterministic tool calls. For example, input `10pm tu` can produce a Plan-IR step that resolves normalized query `tuesday` and clock `10pm`; runtime code should not carry a hardcoded `tu -> tuesday` table.

## Mutation Axes

- Weekday typos: missing tails, extra letters, transpositions, adjacent-key mistakes, and shortened abbreviations such as `tu`, `tuee`, `wedn`, `thrs`, `frii`, `satdy`.
- Month typos: `janurary`, `febuary`, `septmber`, `novemebr`, short forms such as `sep`, `sept`, `jnu`.
- Relative-word typos: `tmrw`, `tomrw`, `tomorow`, `tomorrrow`, `tonite`, `tonigth`.
- Casing: all caps, title case, alternating case, lowercase, and mixed clock meridiem forms like `10pM`.
- Whitespace: leading/trailing whitespace, multiple spaces, tabs, newlines, and pasted multi-line event text.
- Separators: dates with `/`, `-`, `.`, spaces, mixed spaces around punctuation, and clock separators such as `10.30pm`.
- Punctuation: commas, dashes, `@`, parentheses, semicolons, ellipses, and Discord-style surrounding text.
- Timezones: no timezone specified, explicit IANA zones, offset forms such as `+00:00`, UTC/Z forms, common abbreviations such as `EST`, `EDT`, `PST`, `AEST`, regional names such as `Eastern`, `Central`, `Pacific`, and product phrases such as `JP time`.
- Direction modifiers: `this`, `next`, `last`, `previous`, and bare forms applied across weekdays, months, month boundaries, relative offsets, boundary snaps, holidays, and absolute anchors.
- Noise text: prefixes and suffixes such as `remind me`, `for discord`, `please format it`, event blurbs, venue copy, and ticket/link text.
- Ambiguity preservation: bare hours, compact times, `next <weekday>`, multiple candidate dates, and multiple event times should still return clarification rather than silent guesses.
- Unsupported forms: recurrence, vague schedule requests, negative epochs, unsupported epoch lengths, and overlong recursive modifiers should produce `no_plan` or fallback rather than wrong singular timestamps.

## Split Policy

- Training rows should include many single-axis mutations and some multi-axis combinations.
- Training rows should also include enough plain canonical examples. Do not let weird permutations crowd out boring correct patterns such as `tomorrow 4:30pm`, `0`, normal weekday clocks, and exact repeated relative modifiers.
- Use small weighted boundary blocks for product-critical rules: epoch zero is valid, negative epochs are not; `tmrw` means tomorrow, not Tuesday; repeated `day after` modifiers must preserve their count.
- Validation rows should include seen axes in new combinations.
- Holdout rows should reserve exact weird cases and multi-axis combinations the model has not seen verbatim.
- Do not train on every exact eval string. Train on nearby variants so evals measure generalization, not memorization.

## Combinatoric Composition

Temporal robustness should come from composing tagged semantic blocks instead of hand-adding individual examples. Useful blocks include:

- Absolute anchors: date-only, date-time, weekday anchor, holiday, month boundary, and explicit epoch/timestamp.
- Relative offsets: before-anchor, after-anchor, multiple offsets before an anchor, multiple offsets after an anchor, and sandwiched forms such as offset + anchor + offset.
- Directional modifiers: safe forms such as `first of next month` and `last month`, plus ambiguous forms such as top-level `next Saturday` that should clarify rather than silently pick one convention.
- Boundary operations: on the hour, nearest hour, next/previous hour, nearest 15 minutes, and similar snap-to-boundary operations.
- Timezone modifiers: no explicit timezone, explicit timezone on the anchor, explicit timezone on the clock phrase, and offset/abbreviation/name variants.
- Noise and mutation wrappers: typo, casing, punctuation, dropped/added words, and surrounding sentence/paragraph/event-copy text.

The generator should sample these axes with weights, not create an unbounded Cartesian product. Product-critical combinations should be promoted to required evals; broad coverage should remain synthetic validation/holdout so training remains balanced.

Timezone composition needs special handling. Abbreviations can be ambiguous and DST-sensitive, so deterministic execution should validate a resolved timezone against the reference instant and region rather than treating every abbreviation as a fixed offset. Inputs without an explicit timezone should use the user's configured/current timezone.

`Next` and `last` composition also needs semantic tags. Some nouns have stable product semantics (`first of next month`, `last month`, `next hour` as the next boundary). Other forms are colloquially ambiguous (`next Saturday` can mean upcoming Saturday or the Saturday after that). The generator should label these separately so the model learns when to resolve and when to produce clarification alternatives.

## Target Mix

The training split should stay within these primary buckets. `ml/temporal-ir/train_unsloth.py` enforces this before loading the GPU training stack.

- Standard: `50-65%` boring cases such as normal relative dates, weekdays, holidays, explicit timestamps, and date formats.
- Common messy: `15-30%` casing, whitespace, punctuation, typo, fuzzy-clock, and separator variants.
- Ambiguity: `10-25%` clarification cases such as bare hours, `next <weekday>`, multiple event times, and short malformed inputs.
- Hard boundary: `5-12%` unsupported, recurrence, negative/invalid epoch, recursive relative, and other product-critical boundary rows.

Adding weight is useful when it reinforces a named durable rule. Adding only exotic mutations can cause over-weighting side effects where the model starts preferring the wrong correction, such as drifting `tmrw` toward `tu`/Tuesday. Keep every mutation family balanced with clean examples, nearby counterexamples, and explicit no-plan cases.

Examples:

- Train on `tu 9pm`; hold out `10pm tu`.
- Train on `weddd 6pm`; hold out `wedn 6pm`.
- Train on `next frii at 8pm`; hold out `nextt fri 8pm`.
- Train on `May   29 2026 8pm`; hold out `MAY 29 2026 8PM`.

## Normalization Policy

Safe runtime normalization candidates:

- Trim leading/trailing whitespace.
- Collapse repeated whitespace to one regular space.
- Normalize Unicode spaces to regular spaces.

Defer broader normalization, such as lowercasing or semantic typo correction, to the SLM unless eval evidence shows a durable product-safe rule. Casing is probably irrelevant for temporal semantics, but it can carry useful signal in timezones, acronyms, pasted titles, and multilingual text.

## Reporting

Every generated row should carry tags for the axes it exercises. Eval summaries should eventually report accuracy by tag, such as:

```text
weekday-typo: 18/24
date-separator: 40/40
event-post-multi-time: 12/16
next-weekday-ambiguity: 10/10
```

This lets us decide whether the next iteration needs more data, a larger SLM, output-shape simplification, or a targeted deterministic validation primitive.

## Product Boundary

Wrong singular timestamps are worse than clarification, no-plan, or fallback. Large permutation datasets are cheap and should improve local SLM robustness, but the deterministic executor stays authoritative. If a fuzzy input cannot be resolved safely, the model should generate clarification Plan-IR or no-plan output rather than inventing a timestamp.
