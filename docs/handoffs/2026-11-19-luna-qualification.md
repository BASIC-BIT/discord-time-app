# Luna fallback qualification

The model-first parser at `a3e4e4510557b37b23bcad08646ba483c9db48ee` passed 202/202 required cases and 5/5 diagnostics with `gpt-6-luna`, low reasoning, Plan-IR enabled, deterministic preflight disabled, and Discord reference routing enabled. No release or merge has been made.

The repairs supply computed local-clock facts, separate month anchors from supplied clocks, and fail closed on incomplete plan execution. The existing single bounded repair handles malformed plans. Review then found a lowercase date-plus-timezone regression; that fix requires a fresh complete qualification before deployment. No expected answers were changed.

The requalification on `226c8ac` stopped after 182 recorded cases. For `1 year ago`, Luna emitted a positive year shift and independent validation rejected the future timestamp. The planner now documents signed deltas, and an explicit validator contradiction can use the existing single repair if the deadline has room. The corrected plan still receives independent validation. All three live signed-offset probes passed. The full run on this change is pending.

## Evidence

All 202 required inputs, references, timezones, categories, and expected answers are unchanged from main. Structural SHA-256: `a689b0e20fc1bed448ce8868fcbc752479081ba5a1a3426a93ed3a628599960a`.

- `2026-11-19-luna-qualification.json`: original 148/202 result.
- `2026-11-19-luna-research.json`: failed and incomplete snapshots, source hashes, flags, and provider-overload evidence. The first two historical baseline failure lists are archived at the exact commit and path recorded in `failuresArchive`; reconstruction checks preserve all 153 rows. Failure input text joins case IDs to its pinned catalog, with differing inputs retained explicitly.
- `2026-11-19-luna-qualified.json`: `a3e4e45` model-first result, 202/202 required and 5/5 diagnostics, with deterministic preflight disabled. Rows inherit `caseDefaults` and join input text to the pinned catalog. Hydration self-checks preserve every outcome, reference, latency, and token count.

The deployed development relay still uses the historical qualified configuration. Model-first fallback has not been promoted. No deterministic typo dictionary or phrase-specific timestamp override was added. The punctuation repair only extends the separator in the existing explicit duration-and-rounding grammar. Ambiguous offline prose continues to fail safely rather than discard temporal signals.

## Checks and limits

60 related frontend/relay tests pass. Temporal, warmup, strict API/frontend/Convex, and native checks have passed on their recorded sources; native validation includes 65 Rust tests and clippy. Current-head CI and every feedback surface must finish and be refreshed before a merge-ready claim.

The latest complete run had median 8,015 ms, P95 14,734 ms, and max 35,104 ms; 160/207 exceeded five seconds and one exceeded thirty seconds. This misses the five-second SLO. Direct evals have a 120-second safety bound, distinct from the live relay's 30-second deadline. Dollar estimates are unconfigured; token totals are not a billing ledger. Per-case `.partial.jsonl` checkpoints retain completed measurements during provider outages.

Exact installed-MSI authentication and refresh after restart remain NOT RUN for the current source. Windows canceled the earlier installer attempt. The old installed review executable has a different hash; its version label is not acceptance evidence. Current native/browser sign-in screenshots remain unavailable. Linux/component previews and API calls do not prove installed Windows behavior. See `docs/linux-desktop-testing.md` for the preserved intermittent native stall and later diagnostic runs.

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
