# Luna fallback qualification

The latest parser is not qualified. No release or merge has been made.

## Current evidence

- User-selected model: `gpt-6-luna`, low reasoning.
- The 202 required inputs, reference times, timezones, categories, and expected answers are unchanged from main. Structural SHA-256: `a689b0e20fc1bed448ce8868fcbc752479081ba5a1a3426a93ed3a628599960a`.
- Historical source `57cc336` passed 202/202 required and 5/5 diagnostics with deterministic preflight enabled. Its complete measurements remain in `2026-11-19-luna-qualified.json`, using `caseDefaults` plus per-row overrides, with input text joined by case ID to the pinned catalog. Hydration self-checks preserve all outcomes, references, latency, and token counts.
- Latest completed model-first run, `3a234e6`, passed 201/202 required and 4/5 diagnostics. A DST gap returned clarification instead of failure; `5pms` was rejected because validation invented a next-occurrence rule. These failures remain in `2026-11-19-luna-research.json`.
- Source `d33a0ef` adds shared DST-gap and conventional-clock contracts. Its focused run passed three required cases and the `5pms` diagnostic. Its full run was stopped after repeated provider `503 server_is_overloaded`: one shard completed 51/51, three shards had no final report. This is incomplete, not a passing catalog run. Parser source is unchanged in `82c66fc`. A later checkpointed model-first run stopped after 34 cases with two required date-format mismatches. The shared default-noon and default-presentation repair passed all six focused date-only and explicit-clock regressions; its full qualification remains pending. The complete a27ae6f run passed 201/202 required and 5/5 diagnostics; validation rejected a correct reference composition solely for its permitted display style. Scoping the ordinary-date rule and sharing the existing reference-format contract passed all five focused reference/ordinary-date checks.
- The eval harness now records each completed case in an adjacent `.partial.jsonl` file and bounds direct agent requests at 120 seconds. This research safety bound is separate from the live relay's 30-second deadline and the five-second product SLO.

All complete failed snapshots and the incomplete-run receipt are preserved in `2026-11-19-luna-research.json`. Failure input text joins case IDs to the pinned catalog, with differing text retained as overrides; a hydration self-check preserved all 189 failed measurements. Expected answers were not changed. No deterministic typo dictionary or phrase-specific timestamp override was added. Ambiguous offline prose fails safely rather than discarding temporal signals.

## Current routing and limits

The deployed development relay still uses the historical qualified parser with deterministic preflight enabled. Model-first fallback has not been promoted. When qualification resumes, evaluate `planIr=true,deterministicPreflight=false,discordReferenceRouting=true` on the current graph, then promote only after the full required catalog passes.

The source uses a shared token bucket refilling at 100 requests/day with capacity 100, plus a per-user 10/minute bucket with burst three. There is no extra per-user daily cap. Failed admitted attempts consume quota; rejected admissions roll back all debits. Superseded results are ignored by the client, but already incurred provider work remains counted.

## Validation and remaining gates

The offline suite passed. Current related frontend/relay tests: 53 passing. Strict frontend and Convex checks passed; native validation passed 65 Rust tests and clippy. Both platform checks passed for `d33a0ef`; newer head checks and all feedback must be refreshed before any merge-ready claim.

Historical qualified latency was median 3,050 ms, P95 13,281 ms, max 24,878 ms; 78/207 exceeded five seconds. The incomplete provider-overload run also had requests above thirty seconds. Direct parser evals do not include the relay deadline or authentication overhead. These results miss the five-second SLO. Dollar cost estimates are unconfigured, and token totals are not a billing ledger.

Exact installed-MSI authentication and real-account refresh after restart remain NOT RUN for the current source. Windows canceled the previous installer attempt. The old installed review executable has a different hash; its reused version label proves nothing about the current build. Native Windows browser-flow screenshots remain unavailable. Component previews and successful API calls do not establish installed-app acceptance.

## Reproduce

From `api/`, with an authorized `OPENAI_API_KEY`:

```powershell
$env:TEMPORAL_EVAL_MODELS = 'gpt-6-luna:low'
$env:TEMPORAL_EVAL_EXPERIMENTS = 'qualification:planIr=true,deterministicPreflight=false,discordReferenceRouting=true'
$env:TEMPORAL_EVAL_REQUIRE_OPENAI = '1'
$env:TEMPORAL_EVAL_PROGRESS_EVERY = '10'
$env:TEMPORAL_EVAL_OUTPUT = '../.cache/luna-required-eval.json'
$env:LANGFUSE_ENABLED = 'false'
npm run eval:temporal
```
