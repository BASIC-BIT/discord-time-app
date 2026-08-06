# Discord Timestamp Reference Routing Plan

Status: implemented locally on 2026-07-27 behind independent routing and shadow flags. Not committed, released, or enabled in production. Live-model promotion, installed-MSI smoke, canarying, and release remain owner-gated.

Owner correction (2026-07-27): deterministic code may recognize explicit Discord timestamp syntax and execute validated Plan-IR, but it must not interpret transformation language such as “1 hour later.” All meaningful transformations route to model interpretation and fail closed when that path is unavailable.

Execution evidence (2026-07-27):

- Routing Smoke now has a compile-time isolated parser port (8858) and single-instance identity; production remains on 8857.
- The installed `time-range-2687` adapter was staged on port 8770 and scored 3/13 on the focused reference matrix. Arithmetic variants generally anchored on the reference instant (“now”) instead of the explicit Discord token; transformed range failed closed.
- Model plans for semantic timestamp-reference routes are now rejected unless they preserve every exact reference operand and derive a transformation step from one of those operands.
- The synthetic dataset now matches inference by including classifier context and adds varied reference shifts/ranges. Detached bf16/chat retraining was launched as `qwen-temporal-ir-qwen35-08b-bf16-chat-discord-reference-v2-lora`.
- Copied affirmative prose is an explicit deterministic reference fast path even when global deterministic preflight is disabled.

## Local Implementation Record

The smallest coherent slice described below is now present in this worktree:

- one shared, versioned client/server classifier with canonical timestamp grammar, bounded input, reference spans, semantic-residue detection, and fail-closed routes;
- direct deterministic handling only for fully consumed standalone instants, exact ranges, and narrow affirmative copied prose;
- model interpretation into existing Plan-IR for all meaningful transformations, with deterministic execution of model-emitted arithmetic;
- no bare-anchor fallback on model unavailability, timeout, invalid plan, or validation failure;
- privacy-safe HMAC telemetry, raw legacy-log redaction, 30-day retention, route/latency/model/token/cost fields, and client/server legacy-decision comparison;
- independent `DISCORD_REFERENCE_ROUTING_ENABLED` and `DISCORD_REFERENCE_SHADOW` controls;
- classifier, API, migration/privacy, routing-eval, desktop-build, and packaged-sidecar verification lanes.

The offline routing matrix currently passes 21/21 cases with zero observed false-fast-path or false-model-path classifications and no model calls. This proves the deterministic and fail-closed slice, not live model reliability. A promoted model endpoint still requires the model-generation matrix, real cold/warm latency distribution, observed route share, configured provider prices, and a projected monthly spend below the $50 cap.

## Problem

Input such as:

```text
<t:1785643200:t> 1 hour later
```

currently resolves to the unmodified epoch `1785643200`, displaying Sunday, August 2, 2026 at 12:00 AM in America/Indiana/Indianapolis. The intended transformed answer is epoch `1785646800`, one hour later.

The failure happens before model interpretation:

- `src/components/Overlay.tsx` uses an unanchored Discord timestamp regex. Clipboard load and subsequent edits accept the first matching token anywhere in the input and skip the API.
- `api/src/temporal/deterministic.ts` independently checks another unanchored explicit-timestamp regex before other parsing.
- `api/src/temporal/graph.ts` only bypasses a successful deterministic short circuit for top-level `next <weekday>` interpretation, not for meaningful residue around an explicit timestamp.

Direct checkout execution confirmed that a standalone token, suffix or prefix arithmetic, incidental prose, two unrelated timestamp tokens, URL-like text, and inline-code text all resolve deterministically to the first epoch. Existing smoke tests pass but do not cover timestamp-reference composition.

## Central Safety Invariant

Deterministic acceptance requires complete semantic consumption.

No route may return a timestamp or range while silently discarding meaningful residue. If a modifier, relationship, correction, negation, condition, uncertainty, or unsupported action remains unaccounted for, the route must continue to a capable parser, ask for clarification, or fail safely. It must never fall back to the bare timestamp anchor.

Routing must be based on recognized semantic intent and confidence, not raw word count.

## Recommended Architecture

Add one bounded, versioned Discord timestamp reference classifier shared by the overlay and backend. It should:

- recognize canonical timestamp references and retain their spans, epochs, and Discord style suffixes;
- classify malformed timestamp-like syntax;
- identify quoted, code, URL, and prose contexts;
- classify remaining text into fully consumed presentation text, meaningful transformation residue, operative or ambiguous residue, and unsupported intent;
- emit an explicit route and reason code;
- use identical conformance vectors in the client and backend.

The backend remains authoritative whenever it is called. Client and server classifier versions should be recorded so installed-client drift is observable.

## Routing Decision Table

| Input class | Route | Acceptance condition |
| --- | --- | --- |
| No valid timestamp reference | Existing temporal cascade | Unchanged |
| One standalone timestamp, optionally harmlessly wrapped | Direct deterministic instant | Entire input consumed |
| One timestamp in affirmative copied event prose | Deterministic extraction | Strict allowlisted presentation grammar; no negation, correction, condition, uncertainty, other temporal entity, or operative residue |
| One timestamp plus any meaningful transformation | Plan-IR model path | Model interprets the operation; executor and final validation accept |
| Exact two-timestamp range | Direct deterministic range | Entire input consumed; any remaining modifier overrides the range fast path |
| Multiple timestamps without an explicit relationship | Clarification | Never choose the first token |
| Relationship representable as an instant or time range | Model Plan-IR | Full meaning represented and validated |
| Comparison, scheduling action, or unresolved timezone presentation | Clarification as unsupported | Until the product result contract represents the request |
| Malformed, conflicting, unsafe, or over-limit input | Clarification or failure | Never reinterpret a partial token or silently truncate |
| Model unavailable, timed out, or emitted an invalid plan | Safe failure or clarification | Never return the unmodified anchor as fallback |

Rule precedence is explicit: conflicting or partially consumed residue overrides every deterministic fast path, including exact-range recognition.

## Timestamp Plus Arithmetic

The current Plan-IR already has the necessary operations:

1. `resolve_calendar_query` resolves the exact Discord timestamp token.
2. `shift_datetime` applies timezone-aware duration arithmetic using `baseStep`.
3. `finalStep` selects the shifted candidate.
4. Existing deterministic validation verifies and formats the result.

A manually executed plan for the reported case returned epoch `1785646800` and passed validation. A new arithmetic operator is not required.

For syntax such as:

- `<t:...> 1 hour later`
- `1 hour after <t:...>`
- `<t:...> 30 minutes earlier`
- `2 days before <t:...>`

the classifier must only identify the explicit timestamp anchor and meaningful residue. It must not decide the direction, amount, unit, or target. The model-backed Plan-IR path interprets that language and emits operations; deterministic code executes and validates the plan. This path must remain feature-flagged until repeated model-generation evals pass. A hand-authored executor proof demonstrates capability, not model reliability.

Only add an explicit operation such as `resolve_timestamp_reference(referenceId)` if evals show that the model copies the wrong epoch, attaches a modifier to the wrong reference, or otherwise handles the generic `resolve_calendar_query` anchor unreliably. The classifier could then supply structured reference facts without asking the model to reproduce the timestamp text.

## Incidental Copied Prose

Do not force the model merely because other words exist, but do not treat the absence of known keywords as proof that prose is irrelevant.

A deterministic copied-prose extraction route should be deliberately narrow. It may accept a single timestamp in an affirmative presentation grammar such as an event announcement only when:

- the timestamp is the only temporal entity;
- the sentence does not negate, correct, compare, condition, defer, question, or express uncertainty about it;
- no duration, timezone, scheduling, or relationship signal remains;
- all remaining text is consumed by the approved presentation grammar;
- malformed markup or conflicting syntax is absent.

For example, `The event starts at <t:...>; bring a friend` may qualify. `Don't use <t:...>; the organizer posted the wrong time` must not.

This route should initially run in shadow mode against the model/classifier evidence so false-fast-path risk is measured before broad promotion.

## Multiple References And Unsupported Intents

- Preserve the existing deterministic range win only for a fully consumed exact range.
- `<t:A> to <t:B>, but move the end one hour later` is not an exact-range fast path; the modifier must be represented.
- Multiple references without a relationship should clarify instead of selecting the first.
- Comparison is not currently representable as an instant or time-range response.
- Scheduling language may describe a timestamp calculation, but the app does not perform an external scheduling action.
- Timezone conversion of an absolute instant does not change its epoch, while Discord renders timestamps in each viewer's local timezone. Treat timezone-presentation requests as unsupported/clarify until the desired preview and output contract is decided.

## Discord Style And Numeric Contract

Define one canonical grammar and numeric domain shared by the overlay and backend. The current implementations disagree:

- the overlay requires a style suffix while the backend accepts suffixless tags;
- the overlay rejects epoch zero and applies an upper bound below `2147483647`;
- backend and eval paths support a broader explicit-epoch domain.

The contract should define:

- allowed style codes and whether omission is valid;
- epoch sign, digit count, leading-zero, safe-integer, Temporal, JavaScript `Date`, and Discord-client limits;
- overflow-safe parsing;
- malformed brackets, Unicode lookalikes, and embedded-token behavior;
- cross-platform conformance vectors.

Style preservation after transformation also needs an explicit rule. Time-bearing styles can often be preserved. Preserving `:d` or `:D` after a sub-day shift can visually hide the change, so the output may need promotion to a date/time style. Relative style `:R` and any explicit user format request need product-level expectations.

## Quoted Text, Code, URLs, And Long Input

Use a small shared context grammar with identical escaping, nesting, malformed-markup, and URL-encoding tests.

- A sole timestamp in an approved harmless wrapper may remain explicit.
- A timestamp buried in a URL or larger code block should not silently become an instruction.
- Ambiguous or malformed contexts should clarify.
- Model-bound text must have an explicit byte/code-point and cost limit.
- Over-limit input must not be silently truncated because the removed portion may carry the operative modifier.
- Limits should reflect worst-case UI responsiveness, security, model context, and cost, not clipboard percentiles alone.
- Large-paste scanning should be debounced or incremental so repeated edits do not produce quadratic user-visible work.

## Failure And Latency Policy

The product target remains a user-visible result within five seconds, but five seconds is an SLO rather than an automatic correctness cutoff.

- Standalone timestamps, exact ranges, and approved copied prose should remain local and model-free.
- At the SLO boundary, the UI should show a safe working/unavailable state rather than a speculative timestamp.
- Cancellation, endpoint unavailability, timeout, and invalid-plan outcomes must be distinguishable.
- Automatic retry should be bounded and must not extend into an unreported long wait.
- Strong-model escalation must receive the failed route/plan evidence and remain subject to latency and cost gates.
- No failure mode may return the bare anchor after meaningful residue was detected.

The promoted warmed local endpoint was last documented at first-correct median `1306ms`, first-correct p95 `3605ms`, final median `1536ms`, and final p95 `4466ms`, with an approximately `29s` prewarm. This leaves limited p95 margin for classifier, IPC, UI, and fallback overhead. Cold/warm end-to-end distributions must be measured before promotion.

The hosted temporal-model budget remains an absolute maximum of `$50/month`. Compatibility with that budget is not established by warm endpoint measurements alone. Promotion requires observed route frequency, traffic, cold-start behavior, token distributions, provider pricing, and a monthly projection.

## Required Eval Matrix

| Case family | Required examples | Expected behavior |
| --- | --- | --- |
| Standalone | `<t:1785643200:t>` | Direct deterministic; epoch unchanged; no model |
| Suffix arithmetic | `<t:1785643200:t> 1 hour later` | Model Plan-IR; epoch `1785646800` |
| Prefix/infix arithmetic | `1 hour after <t:...>`; `one hour later than <t:...>` | Model Plan-IR |
| Incidental copied prose | Long affirmative event sentence with one timestamp | Approved deterministic extraction |
| Negation/correction | `Don't use <t:...>; that time is wrong` | Clarify/model; never direct extraction |
| Material transformation | `<t:...> two hours before` | Model-emitted shift |
| Timezone request | `<t:...> in Pacific` | Clarify until presentation semantics are defined |
| Comparison | `Compare <t:A> with <t:B>` | Clarify until comparison output exists |
| Exact range | `<t:A> - <t:B>` | Direct deterministic range |
| Unrelated multiples | `<t:A> and <t:B>` | Clarify |
| Transformed range | `<t:A> to <t:B>, end one hour later` | Model transformation; never bare range |
| DST | Hour and day shifts across spring-forward and fall-back | Explicit elapsed/calendar expectations |
| Timestamp grammar | Optional/invalid styles, missing brackets, zero, overflow, huge integers, Unicode lookalikes | Canonical cross-platform result |
| Context | Quotes, inline/fenced code, URLs, encoded URLs, malformed markup | Shared classifier result |
| Adversarial length | Large prose, repeated tokens, injection-like text | Bounded safe response without truncation |
| Regressions | Existing deterministic fast paths and representative model paths | No accuracy, latency, or cost regression |

Every case records:

- expected and actual classifier route and reason;
- status, epoch, range, or clarification alternatives;
- client/server classifier agreement;
- false-fast-path, false-model-path, and safe-failure classification;
- first-correct and final latency;
- model calls, tokens, and estimated cost;
- executor and final-validation outcome.

Promotion gates must cover every supported result type, clarification correctness, route agreement, false-failure rate, latency, cost, and regression coverage. Required cases permit zero wrong singular answers and zero wrong ranges.

## Telemetry And Privacy

Record:

- classifier and flow versions;
- client/server versions;
- route and reason codes;
- reference and malformed-token counts;
- wrapper/context and semantic-signal classes;
- input-length bucket;
- parser/model selected;
- Plan-IR operations;
- executor, validation, fallback, and user-visible outcomes;
- first-correct and final latency;
- model identity, token count, and cost estimate;
- bounded user feedback attribution.

Do not retain raw surrounding prose merely to evaluate routing. Avoid plain hashes for predictable input if recurrence detection is needed; prefer aggregate fingerprints or a keyed, rotated HMAC with a documented retention period.

Privacy cleanup is a release prerequisite, not optional follow-up:

- the temporal generation ledger hashes input and declares it unretained;
- API request logging and the legacy successful-usage table currently retain raw input text;
- current overlay fast paths have no generation ID, so their outcomes are not linked to parser telemetry.

These retention declarations and paths must agree before semantic inputs that currently remain in the overlay are routed to the parser service.

## Rollout And Rollback

1. Add the classifier and conformance tests behind a feature flag.
2. Shadow old and new decisions without changing user-visible behavior.
3. Inspect false-fast-path cases and route-distribution changes.
4. Route all meaningful transformations to model Plan-IR and fail closed when that path is unavailable.
5. Enable model routing only after its generation, latency, and cost gates pass.
6. Canary installed builds and monitor route share, safe failures, p95/p99 latency, and projected spend.
7. Keep an immediate rollback switch for classifier and model routing independently.
8. Smoke-test the installed MSI path before opening, merging, or releasing the desktop/runtime change.

## Smallest Implementation Slice

1. Add the shared classifier, canonical timestamp grammar, route-reason enum, and client/server conformance tests.
2. Replace both unanchored first-match fast-path claims.
3. Make backend explicit parsing require classifier-approved deterministic acceptance.
4. Pass structured timestamp-reference facts to the model without interpreting surrounding language deterministically.
5. Route all meaningful residue to model Plan-IR behind a feature flag and promotion gate.
6. Ensure Plan-IR or infrastructure failure cannot return a deterministic anchor candidate that ignored residue.
7. Add the required eval cases, privacy-safe route telemetry, and raw-retention cleanup.
8. Shadow, canary, verify the installed MSI, and stop for explicit release approval.

## Decisions Encoded In The Local Slice

- Canonical references are `<t:EPOCH>` or `<t:EPOCH:STYLE>`, where style is one of `t`, `T`, `d`, `D`, `f`, `F`, or `R`; epoch is an unsigned integer from `0` through `253402300799`.
- Affirmative copied prose is deliberately narrow and is rejected when negation, correction, uncertainty, duration, timezone, comparison, scheduling, another temporal entity, or ambiguous quote/code/URL context is detected.
- Model-emitted minute/hour shifts use the executor's elapsed-time semantics; model-emitted day/week/month/year shifts use its calendar arithmetic in the request timezone.
- Timestamp style is preserved where it remains informative; date-only output is promoted when a sub-day shift would otherwise be hidden.
- Timezone presentation, comparison, and external scheduling remain explicit clarifications because the current result contract does not represent them.
- A sole harmlessly wrapped reference may remain direct; larger quoted/code/URL contexts clarify.
- Total input is capped at 16,384 UTF-16 code units and model-bound input at 4,096; over-limit text is rejected without truncation.
- Promotion thresholds, canary population, real provider-price configuration, and rollback triggers remain owner decisions because they require live evidence.

## Behavior That A Broad Change Would Harm

Routing every timestamp-containing sentence to a model would increase latency, privacy exposure, offline dependence, and cost while losing the current copied-announcement fast win.

Keeping broad first-token extraction would continue returning confident but wrong singular answers whenever surrounding language changes, rejects, compares, or relates the timestamp.

The recommended boundary preserves deterministic wins only where the classifier can prove there is no semantic transformation, uses model-emitted Plan-IR for arithmetic and relationships, and fails closed when interpretation is unavailable or invalid.

## Local Implementation And Experiment Evidence (2026-07-27)

This work remains uncommitted, unreleased, and uninstalled in the production desktop app.

- The shared classifier and fail-closed Plan-IR anchor checks are implemented locally. Exact standalone references, exact ranges, and narrowly affirmative copied prose can use the deterministic path; semantic residue routes to the model.
- The model path does not contain a deterministic `"1 hour later"` grammar. The model must emit `resolve_calendar_query` for the exact Discord reference and a dependent `shift_datetime`; deterministic code validates and executes that plan.
- The first focused run against the previously installed adapter passed only `3/13`; shifts were commonly anchored to `now` or otherwise malformed.
- Retraining initially appeared ineffective because training included `discordTimestampRouting` while runtime prompt serialization silently omitted it. Runtime and eval prompt serialization now share the structured routing payload and stable key ordering, with a temporal smoke assertion covering its presence.
- V3 and V4 both passed the integrated routed reference gate: `21/21`, zero false-fast-path routes, zero false-model-path routes, eight model calls, preserved `:t` style, and maximum observed latency below `3s`. The reported case `<t:1785643200:t> 1 hour later` resolved to epoch `1785646800`.
- The raw model-only gate is no longer authoritative for classifier-owned reference categories because it deliberately bypasses the router. Those categories are gated by the integrated 21-case suite.
- V4 did **not** pass the separate legacy model gate after classifier-owned categories were excluded: `149/153` required and `1/1` diagnostic. The remaining failures were named-timezone range, fixed-offset range, IANA-timezone range, and unsupported schedule-block rejection. Several passing range cases also exceeded the 5-second product SLO.
- Therefore V4 is an experimental adapter, not the promoted global local-SLM replacement. No further hill-climbing was performed, no production defaults were changed, and the isolated evaluation services were stopped.
- The current Routing Smoke executable compiled successfully, but two WiX attempts to produce a current MSI failed in `light.exe` without a diagnostic. The MSI already present in the bundle directory predates the final prompt-plumbing fix and must not be treated as the current build. No installer was launched.

The smallest credible next decision is an owner choice between:

1. continue model-family/data work until one adapter passes both the routed reference gate and the legacy gate;
2. investigate a measured single-base multi-adapter serving design that selects a reference adapter only for classifier-approved model routes, without adding a second always-warm GPU service; or
3. keep the current production adapter and ship only the fail-closed routing safety work after installed-app smoke testing, accepting safe failure for transformed Discord references until the model gate passes.

## V9 Evaluation Boundary And Recommended Next Work (2026-07-30)

### Decision

Do not start another training run merely to raise the aggregate `162/179`
number. First replace that mixed score with separate product-routing and
model-capability gates.

V9 is suitable for continued experimental use in the isolated Routing Smoke
app. It is not a globally correct model, an installed-app proof, or a
production-release candidate.

The next implementation slice should run the complete required temporal matrix
through the same classifier, deterministic routes, model routes, executor, and
validation path used by the desktop sidecar. That result becomes the
user-visible release gate. The existing direct Plan-IR evaluation remains a
diagnostic measurement of model capability and fallback resilience.

### Current Evidence

V9 added a crossed Discord-reference clock-composition family covering:

- multiple reference styles and epochs;
- clock replacement using noon, midnight, AM/PM, and unambiguous 24-hour time;
- prefix, infix, and suffix wording;
- spring-forward and fall-back dates;
- structurally held-out paraphrases;
- ambiguous bare 1-12 clocks that require AM/PM clarification.

Observed results:

- focused live production-routed gate: `30/30`;
- false fast paths: `0`;
- false model paths: `0`;
- focused worst-case latency: `2503ms`;
- broad direct Plan-IR gate: `162/179`;
- V7 broad baseline: `154/172`;
- V7 pass-to-V9-fail transitions: `0`;
- existing broad cases improved by V9: `1`;
- new clock-composition cases passing: `7/7`.

The rebuilt Routing Smoke desktop sidecar on port `8858` reported Plan-IR and
Discord-reference routing enabled, endpoint `http://127.0.0.1:8771/v1`, and
model `qwen-temporal-ir-qwen35-08b-bf16-chat-discord-reference-v9`. Direct
sidecar probes confirmed:

- standalone reference: deterministic, unchanged epoch;
- `<t:1785643200:t> day at 12 pm`: `agent+plan`, epoch `1785686400`;
- held-out “keep the reference's date and use noon” wording: `agent+plan`,
  epoch `1785686400`;
- prefix same-day clock wording: correct epoch through `agent+plan`;
- ambiguous `<t:1785643200:t> day at 12`: AM/PM clarification.

This is strong evidence for the newly requested family. It is not evidence that
all 179 direct-model cases are correct.

### Why `162/179` Is Not A Coherent Release Score

The current broad runner sends every case through the endpoint Plan-IR model.
That answers:

> Can this adapter independently interpret and represent this input?

The product classifier intentionally answers a different question first:

> Which parser is safest, cheapest, and semantically complete for this input?

As a result, the broad suite forces the model to solve inputs that production
deliberately assigns to:

- `direct_instant`;
- `direct_range`;
- narrow `copied_prose`;
- deterministic or classifier-owned clarification;
- malformed-input rejection.

For example, the exact range
`<t:1785643200:t> to <t:1785646800:F>` is correctly handled by the
`direct_range` route in the focused integrated gate. When forced through the
model-only runner, V9 produced an incorrect range end. That is a real model
fallback weakness, but not a failure of the intended product route.

Conversely, a perfect model-only score would not prove that the client and
server classifiers agree, that the overlay chose the right route, that
deterministic shortcuts consumed the full input, or that the desktop stayed
within its latency target.

One aggregate score therefore hides both kinds of risk:

- it can block a safe product route because the wrong parser was forced;
- it can make model improvements obscure a classifier or integration
  regression.

### Inventory Of The Seventeen Broad Failures

The remaining V9 broad failures divide into three classes:

1. Ten format/style failures. The semantic epoch is correct, but the model
   emits short date/time style `:f` instead of preserving the reference's
   `:t` or `:F` style. These include ordinary shifts, typo variants,
   copied-prose extraction, and DST shifts.
2. Six clarification-quality failures. Negated references, unrelated multiple
   references, comparisons, timezone-presentation requests, reversed ranges,
   and inline-code context fail generically where the expected product
   behavior is a useful clarification.
3. One incorrect exact range when the exact range is forced through the model.
   This is the highest-severity model-only failure, although the intended
   product route handles it deterministically.

These cases must remain visible in the diagnostic report. Reclassifying the
report must not delete, hide, or relabel wrong answers as successes.

### Proposed Gate Taxonomy

#### Gate A: Production-Routed Correctness

Run every required case through the real shared classifier and authoritative
backend flow.

Record and assert:

- expected and actual route;
- route reason and classifier version;
- client/server classifier agreement;
- final status, epoch, range, style, or clarification;
- parser method and model identity;
- reference preservation and Plan-IR validation;
- model call count;
- first-correct and final latency;
- cancellation and fallback outcome.

Release requirements:

- zero wrong singular epochs;
- zero wrong ranges;
- zero silently discarded meaningful residue;
- zero false fast paths;
- zero client/server route disagreement;
- all classifier-owned ambiguity cases produce the required clarification or
  safe rejection;
- every model-routed required case passes;
- warmed user-visible p95 remains within the five-second product SLO;
- cost projection remains within the `$50/month` absolute hosted-model cap.

This gate should expand the current 30-case integrated suite until all relevant
cases from the 179-case matrix have a production-route expectation.

#### Gate B: Model-Routed Semantic Capability

Select only inputs whose expected production route is `model`. Exercise them
through endpoint Plan-IR, deterministic execution, and final validation.

This is a blocking gate for changing the model used on those routes. It must
require exact semantic results, not merely valid JSON or resolved status.

Required assertions include:

- exact reference operands preserved;
- correct operation, direction, amount, unit, and dependency;
- correct final step;
- exact epoch or range;
- appropriate clarification for unresolved semantic ambiguity;
- no fallback to the bare timestamp anchor;
- no validation bypass.

#### Gate C: Model-Only Resilience Diagnostics

Continue forcing classifier-owned cases through the model to measure fallback
and future capability:

- exact tokens and exact ranges;
- copied prose;
- classifier-owned clarification;
- quote/code/URL contexts;
- malformed syntax and unsupported actions.

This report is non-blocking for the current routed product unless one of those
cases can actually reach the model in production. It becomes blocking if a
future routing change expands the model's responsibility.

Diagnostics still retain severity:

- wrong epoch or range;
- correct semantics but wrong style;
- generic failure instead of clarification;
- latency or cost excess;
- invalid Plan-IR.

#### Gate D: Installed Desktop Verification

Passing API and Routing Smoke gates is not installed-app proof.

Before release:

- build the current MSI successfully;
- install that exact artifact;
- verify launcher/runtime discovery from the installed path;
- verify `/health` reports the intended port, endpoint, model, and flags;
- exercise the manual overlay matrix;
- verify debounce and active cancellation behavior;
- capture exact build identity and installed executable path.

### Combinatorial Training Strategy

Future training data should be generated from semantic operations and crossed
dimensions rather than accumulated screenshot phrases.

Core operands:

- one reference instant;
- two related reference instants;
- two unrelated reference instants;
- explicit date or clock plus a reference;
- reference plus timezone;
- reference plus duration;
- reference embedded in approved prose or ambiguous context.

Operations:

- elapsed shift;
- calendar shift;
- replace clock while preserving local date;
- replace date while preserving local clock;
- construct or transform a range;
- compare or calculate a difference;
- timezone interpretation or presentation;
- snap to a boundary;
- request clarification or reject unsupported intent.

Language dimensions:

- prefix, infix, and suffix order;
- terse commands and full sentences;
- active and passive wording;
- before/after and earlier/later inverse pairs;
- singular, plural, numeric, and word-number quantities;
- common typos and spacing variation;
- negation, correction, uncertainty, and questions;
- irrelevant copied context before and after the operative phrase.

Temporal dimensions:

- all Discord style suffixes;
- no suffix where allowed by the canonical grammar;
- noon, midnight, AM/PM, and 24-hour clocks;
- ambiguous bare 1-12 clocks;
- minute-bearing clocks;
- spring-forward gap and fall-back overlap;
- month/year boundaries and leap days;
- positive, zero, upper-bound, malformed, and overflowing epochs;
- IANA zones, fixed offsets, named zones, and ambiguous abbreviations.

Context and adversarial dimensions:

- harmless wrappers;
- inline and fenced code;
- quotes;
- URLs and encoded URLs;
- multiple references;
- malformed brackets and Unicode lookalikes;
- long irrelevant prose;
- repeated-token and injection-like text;
- over-limit input without silent truncation.

Dataset partitions must be structural:

- training templates cover representative combinations;
- validation templates use different wording at known semantic structure;
- holdout templates change word order or construction, not just synonyms;
- regression replay preserves every previously corrected failure and its
  inverse/neighbor cases.

Do not enumerate the full Cartesian product blindly. Use pairwise or
constraint-based coverage, then add targeted higher-order combinations where
interactions are known to matter: multiple references plus ranges, clock
replacement across DST, timezone plus date arithmetic, and ambiguity inside
quoted or copied context.

### Deterministic And Model Responsibility

Deterministic code should continue to own:

- canonical timestamp syntax and numeric validation;
- complete-consumption routing for exact instants and exact ranges;
- narrow copied-prose recognition;
- context, length, and malformed-input safety checks;
- stable style propagation rules;
- timezone/calendar arithmetic emitted by Plan-IR;
- Plan-IR execution and final validation;
- cancellation delivery and telemetry.

The model should own:

- interpreting arbitrary transformation language;
- selecting the intended semantic operation;
- associating modifiers with the correct reference;
- typo and shorthand recovery;
- multi-step composition;
- determining when semantic ambiguity requires a question.

Do not add deterministic mappings for phrases such as “day at,” “earlier,” or
“ebefore” merely to make individual evals pass. Stable structural style
preservation and exact syntax are deterministic product rules; natural-language
meaning is not.

### Prioritized Roadmap

#### Phase 1: Correct The Measurement

1. Add a production-routed runner over the complete required case catalog.
2. Give every case an explicit expected route and ownership classification.
3. Emit separate Gate A, B, and C summaries from one canonical case source.
4. Compare candidate and baseline case-by-case.
5. Fail the run on any pass-to-fail transition, wrong epoch/range, false fast
   path, or model-route miss.

Stopping condition: every case has one documented product route and cannot be
counted differently merely because a different runner was selected.

#### Phase 2: Close Genuine Product Gaps

Use Gate A to identify failures that occur on their intended production route.
Fix classifier, integration, DSL, data, or validation issues according to
ownership. Do not use Gate C failures as justification for unrelated runtime
complexity.

Stopping condition: Gate A passes completely with the required latency and
cost evidence.

#### Phase 3: Expand Model Composition Deliberately

The next useful model experiment should target multi-reference relationships,
range transformation, comparison/difference, and timezone composition. Add a
result type or Plan-IR operation only when the product contract can represent
the answer and evals demonstrate that existing operations are insufficient.

Candidate progression:

1. two-reference range construction and endpoint transformation;
2. relationship/difference semantics with a defined user-visible result;
3. timezone-plus-clock/date composition;
4. higher-order chained operations.

Stopping condition: each newly model-owned family passes Gate B, preserves the
Gate A baseline, and has held-out generalization evidence.

#### Phase 4: Productize And Release

1. Preserve V9 and its reports as a runnable baseline.
2. Build and install the exact desktop candidate.
3. Run automated installed-sidecar probes and manual visual overlay checks.
4. Measure cold and warm latency, cancellation, route share, and projected
   cost.
5. Canary behind independent classifier and model-routing flags.
6. Stop for explicit owner release approval.

### Immediate Smallest Implementation Slice

The next code change should not be V10 training. It should:

1. extract or reuse one canonical required-case catalog;
2. run that catalog through production routing;
3. tag each case as classifier-owned, model-owned, or diagnostic fallback;
4. produce separate Gate A/B/C totals and case lists;
5. compare V9 against the current baseline by case ID;
6. make wrong singular timestamps, wrong ranges, false fast paths, and
   model-owned failures blocking;
7. retain style and clarification failures as explicit named results;
8. document which remaining failures are product-visible.

Only after this slice identifies a real model-owned capability gap should the
next training generator and adapter be selected.

### Behaviors This Plan Protects

- Standalone timestamps remain effectively instant and offline.
- Exact ranges do not pay model latency or risk model arithmetic.
- Long copied announcements are not forced through a model merely because they
  contain prose.
- Meaningful modifiers are never silently discarded.
- Ambiguity does not become a confident singular answer.
- Local or hosted inference stays bounded by latency and cost constraints.
- Diagnostic model weakness remains visible without being confused with
  shipped behavior.
- A better aggregate model score cannot hide a regression in an existing
  product route.

### Implementation And Verification Record (2026-07-30)

The immediate measurement slice is implemented:

- the broad temporal matrix and focused Discord-reference route checks now
  share the canonical catalog exported by
  `api/scripts/temporal-model-eval.ts`;
- every required case has explicit classifier or model ownership, with
  expected Discord routes and reasons where the shared classifier applies;
- `routed_endpoint` exercises the Routing Smoke production profile through the
  backend graph, while `endpoint_plan` remains the direct-model diagnostic;
- the boundary report emits blocking Gates A and B, nonblocking Gate C,
  client/server classifier agreement, first-correct median and p95 latency,
  model-call enforcement, cost posture, and case-by-case baseline changes;
- `scripts/run-temporal-evaluation-boundary.ps1` refuses to run against a
  mismatched served model and records the current local deployment as having no
  hosted inference spend.

The final full V9 run produced these product-path results:

- Gate A routed correctness: `184/184`;
- Gate B model-owned correctness: `146/146`;
- Gate C direct-model resilience diagnostics: `26/40`;
- client/server classifier agreement for routed reference cases: `32/32`;
- first-correct median: `1169ms`;
- first-correct p95: `2956ms`;
- compatible routed baseline regressions: `0`;
- compatible routed baseline improvements: `negative-epoch-rejected`;
- deployment mode: local, projected hosted inference spend `$0`, within the
  `$50/month` cap;
- direct-model Gate C weaknesses remained visible rather than being promoted
  into product failures.

The report
`api/reports/temporal-ml/discord-reference-v9-evaluation-boundary-final.json`
has boundary status `PASS` with no blockers. An earlier run exposed one missing
classifier-ownership tag; correcting that metadata moved the case to its
intended non-model ownership without changing its result.

One genuine production-route bug was found and fixed during the run: the stable
numeric input `-1` was being mistaken for a trailing bare one-o'clock mention
before the model/rejection path could run. The graph now excludes a trailing
clock token immediately preceded by `-` or `+`, and the deterministic smoke
suite preserves `-1` as a failed invalid epoch. This is numeric syntax
disambiguation, not a phrase-specific natural-language shim.

No V10 training was started. After ownership was corrected, Gate B contained
no remaining model-owned product failure, so another run would have
hill-climbed the nonblocking direct-model diagnostic instead of closing a
shipped behavior gap.

Desktop packaging reached a current routing-smoke executable and WiX object.
The host's optional WiX ICE validation could not access Windows Installer
(`LGHT0217`/`LGHT0216`), so the same current WiX object was linked with
`light.exe -sval`, skipping only that unavailable host validation pass. The
resulting candidate is:

- path:
  `src-tauri/target/release/bundle/msi/HammerOverlay Routing Smoke_0.1.0_x64_en-US.current.msi`;
- size: `81,154,536` bytes;
- build timestamp: `2026-07-30T05:11:21.5400000-04:00`;
- SHA-256:
  `9FC320CADF6A3C7B1D7578DEF2802A4719039AB94A77B9BB73862E22D52F01E1`.

Installed-path automation passed after the owner approved Windows UAC:

- registry install date: `20260730`;
- MSI SHA-256:
  `9FC320CADF6A3C7B1D7578DEF2802A4719039AB94A77B9BB73862E22D52F01E1`;
- installed executable SHA-256:
  `0661E4DF08C5A381680692F4DA39349E48BF066ECDDB04FE6C8E5DC92056C920`,
  exactly matching the current release executable;
- desktop path:
  `C:\Program Files\HammerOverlay Routing Smoke\hammer-overlay.exe`;
- sidecar runtime path:
  `C:\Program Files\HammerOverlay Routing Smoke\api\bin\node.exe`;
- installed `/health`: healthy on port `8858`, Plan-IR and Discord-reference
  routing enabled, shadow disabled, endpoint
  `http://127.0.0.1:8771/v1`, exact V9 model, chat API and chat prompt format;
- installed semantic probes: `10/10`, covering standalone references,
  clock composition, held-out wording, prefix composition, typo direction,
  long copied prose, ambiguity, exact ranges, invalid negative epochs, and
  active cancellation;
- active cancellation: acknowledged and returned HTTP `499`;
- warmed installed model-path p95: `2821ms`, within the five-second target.

The sanitized evidence report is
`api/reports/temporal-ml/discord-reference-v9-installed-routing-smoke.json`.
The owner then exercised the installed overlay through the isolated
Routing Smoke hotkey and observed the held-out input
`<t:1785643200:t> at 2:39` safely ask whether `2:39 AM` or `2:39 PM` was
intended. The owner accepted the installed behavior as a good stopping point.
This closes the human-visible Gate D check for the V9 evaluation boundary.

That held-out result is a semantic safety pass but a presentation limitation:
V9 returned a question-only clarification without executable alternatives, so
the overlay displayed the question as ordinary text rather than clickable
choices. Interactive choice generation remains a nonblocking UX/model
follow-up; it does not permit a singular timestamp and does not invalidate the
safe-routing gate.

Release remains stopped. All V9 evaluation-boundary implementation and
installed verification work is complete; publishing, merging, or changing the
production parser still requires separate explicit owner approval.

Without `-Install`, the same command is a non-admin repeatable verification of
an already-installed candidate. It writes a sanitized local report to
`api/reports/temporal-ml/discord-reference-v9-installed-routing-smoke.json` and
never records the process-scoped API key.

Production HammerOverlay and Routing Smoke currently use the same
`Ctrl+Shift+H` global shortcut. The verifier now refuses the manual-ready
handoff if the production executable is running. For an intentional isolated
visual smoke, use `-StopProductionForManualSmoke`; it stops only the exact
`C:\Program Files\HammerOverlay\hammer-overlay.exe` process before launching
Routing Smoke. Restart production after the smoke if desired.
