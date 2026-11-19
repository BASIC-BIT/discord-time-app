# Luna fallback qualification, November 19

The complete run at **57cc336 passed 202/202 required cases and 5/5 diagnostics**, with the original required catalog unchanged. The [passing case-level report](2026-11-19-luna-qualified.json) includes source hashes, all 207 outcomes, references, latency, and token counts. This closes the required correctness gate for that parser source. Installed-MSI acceptance and the five-second latency target are separate and remain open.

All runs use `gpt-6-luna`, low reasoning. The selected hybrid keeps `planIr=true,deterministicPreflight=true,discordReferenceRouting=true`. No required input, reference instant, timezone, expected answer, or category changed from main at `d14afbab826d74b13fd16551c71c5470accfa36a`. A structural comparison of all 202 required rows passed; their normalized SHA-256 is `a689b0e20fc1bed448ce8868fcbc752479081ba5a1a3426a93ed3a628599960a`.

The qualified source also fixes contextual timezone words, multi-zone choice loops, partial usage on errors, and per-identity daily fairness. The earlier complete passing report at 70b68dd remains available in commit 16bd7e2.

The newer 71199dc review fixes reached 201/202 required and 5/5 diagnostics. Its recursive-relative failure returned a day early and passed independent validation. The last passing report still applies to 57cc336, not that newer source. Calendar-day offset facts and explicit inside-out modifier validation passed a two-case live probe; full qualification of this follow-up is pending.

The 2cd9ce6 follow-up passed the recursive case but reached 199/202 overall. It exposed missing shared boundary conventions (first-of-month and hour-after-next) and a safely rejected AM/PM plan shape. All failures are preserved. Shared boundary instructions and actionable clock-contract feedback pass a four-case live probe; the next complete run is pending. Case categories are available in the pinned catalog rather than duplicated in each passing measurement row.

The 6309695 hybrid reached 201/202 and again accepted a recursive answer one day early: the validator omitted an outer modifier. The same parser with deterministic preflight disabled reached 196/202 without a resolved mismatch. That comparison exposed six interpretation/response-contract failures, which are preserved. Shared literal/boundary conventions, tool-based noon arithmetic, and correct OpenAI question-only handling pass their focused checks. A complete follow-up will evaluate the existing Plan-IR-first permutation before any default promotion. Measurement rows inherit `caseDefaults`, with every difference stored per row; a hydration self-check preserves all outcomes, references, latency, and token counts.

## Complete measurements

| Source or experiment | Required | Diagnostics |
| --- | ---: | ---: |
| Initial hybrid, f02fe387 | 148/202 | 4/5 |
| Deterministic comparison | 125/202 | 1/5 |
| Model-only comparison | 131/202 | 4/5 |
| First repaired hybrid | 200/202 | 5/5 |
| Display-contract revision | 197/202 | 4/5 |
| Product-contract head 8ecdbf1 | 200/202 | 4/5 |
| Bounded repair, 356c5d7 | 199/202 | 5/5 |
| Guard repair and timezone timestamp choices, 4330fd1 | 199/202 | 5/5 |
| Calendar contract and timezone UI, 042a250 | 201/202 | 5/5 |
| Explicit compound anchors, 70b68dd | 202/202 | 5/5 |
| Reviewed timezone context and usage, 57cc336 | 202/202 | 5/5 |
| Atomic admission and lazy sign-in, 71199dc | 201/202 | 5/5 |
| Factual relative offsets, 2cd9ce6 | 199/202 | 5/5 |
| Shared boundaries, 6309695 hybrid | 201/202 | 5/5 |
| 6309695 Plan-IR-first comparison | **196/202** | **5/5** |

The [initial case-level evidence](2026-11-19-luna-qualification.json) preserves the first 54 required failures. The [research evidence](2026-11-19-luna-research.json) preserves later scores, failed cases, and source hashes. Intermediate snapshots are distinct implementations, not an unchanged-build passing streak. Partial probes stopped after an edit assertion or offline regression failure are not qualification results.

The initial failures included 12 resolved mismatches: nine display formats and three answers that should have failed or requested clarification. Calendar-only and model-only lanes are comparisons, not accepted alternatives or a paired comparison of the final implementation. Deterministic preflight remains enabled.

## Latest failure and repair

`day aftr next satturday at 13:37` should resolve to epoch `1780249020`. The 042a250 run returned `1780853820`, one week late, and independent validation accepted it. Its plan sent the whole compound offset to `resolve_calendar_query`, whose opaque parse selected a different week.

The repaired instruction resolves only the normalized weekday anchor and applies the outer offset with `shift_datetime`. Validation must check that composition instead of assuming an opaque compound query used the same anchor week. The unchanged typo case and its clean counterpart passed the targeted run, followed by the complete 202/202 run. The failed snapshot remains preserved.

Other repairs address output-type contracts, year preservation, calendar facts, display-format ownership, range clocks, schema-required nulls, and alternative-plan counts. No deterministic typo dictionary or phrase-specific timestamp override was added. The CST contract remains a question with no timestamp alternatives; the overlay's explicit zone buttons clarify the input before a new parse.

A guard-rejected or unexecutable plan can receive one error-guided repair. Independent final-validation rejection, provider errors, and no-plan remain terminal. Both attempts and their usage stay in diagnostics. The relay's 30-second abort is unchanged. Repair reserves at least 15 seconds, or twice the observed planner latency if larger; the previous complete run's single planner/validator rounds had P95 11,765 ms and maximum 13,742 ms. An insufficient budget returns the original failure without another model call.

## Limits and remaining acceptance

All offline suites, 53 related frontend/relay tests, API/frontend/Convex strict typechecks, and the production frontend build pass. Admission uses a shared token bucket refilling at 100 requests/day with capacity 100, plus a per-user 10/minute bucket with burst three. There is no additional per-user daily cap. Failed or timed-out admitted attempts still consume quota; rejected admissions roll back every debit.

The passing run had median final latency 3,050 ms, P95 13,281 ms, and maximum 24,878 ms with four workers. Of 207 cases, 78 exceeded five seconds and none exceeded thirty seconds. This misses the five-second product SLO. Correctness evals do not impose the relay deadline; latency and deadline behaviour are separate measurements. Dollar cost estimates are unconfigured. Earlier snapshots omitted deterministic-validation token usage; current accounting includes accepted/rejected validation and repair, but provider usage may be unavailable on errors. Token totals are not a billing ledger, and daily enforcement does not depend on them.

Exact installed-MSI authentication acceptance and real-account refresh after restart remain open. A previous isolated review install was canceled. The currently installed routing-smoke binary has a different hash from the current candidate; the reused 0.1.0 label does not prove acceptance. Component previews and successful backend calls do not establish installed-app or native browser-flow proof. No release or merge has been made.

## Reproduce

From `api/`, with an authorized `OPENAI_API_KEY` available:

```powershell
$env:TEMPORAL_EVAL_MODELS = 'gpt-6-luna:low'
$env:TEMPORAL_EVAL_EXPERIMENTS = 'qualification:planIr=true,deterministicPreflight=true,discordReferenceRouting=true'
$env:TEMPORAL_EVAL_REQUIRE_OPENAI = '1'
$env:TEMPORAL_EVAL_PROGRESS_EVERY = '10'
$env:TEMPORAL_EVAL_OUTPUT = '../.cache/luna-required-eval.json'
$env:LANGFUSE_ENABLED = 'false'
npm run eval:temporal
```
