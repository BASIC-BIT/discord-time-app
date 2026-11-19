# Luna fallback qualification

The model-first parser at `ead86924f52eb5f22ee577d855482e315e5bf0a2` passed 202/202 required cases and 5/5 diagnostics with `gpt-6-luna`, low reasoning, Plan-IR enabled, deterministic preflight disabled, and Discord reference routing enabled. No release or merge has been made.

The repairs supply computed local-clock facts, separate month anchors from supplied clocks, and fail closed on incomplete plan execution. The existing single bounded repair handles malformed plans. The qualified source includes the lowercase date-plus-timezone fix. No expected answers were changed.

The requalification on `226c8ac` stopped after 182 recorded cases. For `1 year ago`, Luna emitted a positive year shift and independent validation rejected the future timestamp. The planner now documents signed deltas, and an explicit validator contradiction can use the existing single repair if the deadline has room. The corrected plan still receives independent validation. All three live signed-offset probes passed. The complete follow-up run passed 202/202 required and 5/5 diagnostic cases.

After restoring the warm RunPod executor's prior behavior, the new Luna run on `4515325` stopped after 122 recorded cases. Luna asked which year for a yearless ordinal weekday in a named month, despite the calendar tool's existing next-occurrence convention. The planner and validator now share that rule explicitly. The four-case live probe passed, including the rollover, same-year control, relative month control, and signed year offset. The follow-up run passed the rollover and stopped after 127 cases on a different issue: a correct timestamp displayed as relative because arithmetic treated an explicitly set noon as the date-only default. Luna plan execution now keeps the explicit clock precision through the shift, without changing the timestamp or the warm RunPod executor.

## Evidence

All 202 required inputs, references, timezones, categories, and expected answers are unchanged from main. Structural SHA-256: `a689b0e20fc1bed448ce8868fcbc752479081ba5a1a3426a93ed3a628599960a`.

- `2026-11-19-luna-qualification.json`: original 148/202 result.
- `2026-11-19-luna-research.json`: failed and incomplete snapshots, source hashes, flags, and provider-overload evidence. Historical baseline failure lists use the exact commit and path in `failuresArchive`. Reconstruction checks preserve all archived rows. Failure input text joins case IDs to its pinned catalog, with differing inputs retained explicitly.
- `2026-11-19-luna-qualified.json`: `ead8692` model-first result, 202/202 required and 5/5 diagnostics, with deterministic preflight disabled. Rows inherit `caseDefaults` and join input text to the pinned catalog. Hydration self-checks preserve every outcome, reference, latency, and token count.

Development Convex `effervescent-oyster-428` runs this model-first parser. A request without authentication returned `sign_in_required`. No deterministic typo dictionary or phrase-specific timestamp override was added. The punctuation repair only extends the separator in the existing explicit duration-and-rounding grammar. Ambiguous offline prose continues to fail safely rather than discard temporal signals.

## Checks and limits

61 related frontend/relay tests pass. Temporal, warmup, strict API/frontend/Convex, and native checks have passed on their recorded sources; native validation includes 65 Rust tests and clippy. Current-head CI and every feedback surface must finish and be refreshed before a merge-ready claim.

The latest complete run had median 6,848 ms, P95 12,601 ms, and max 30,629 ms. Of 207 cases, 159 exceeded five seconds and one exceeded thirty seconds. This misses the five-second SLO. Direct evals have a 120-second safety bound, distinct from the live relay's 30-second deadline. Dollar estimates are unconfigured; token totals are not a billing ledger. Per-case `.partial.jsonl` checkpoints retain completed measurements during provider outages.

Exact installed-MSI authentication and refresh after restart remain NOT RUN for the current source. Windows canceled the earlier installer attempt. The isolated review MSI is rebuilt after changes to the Windows app. Its installation and sign-in smoke are pending. Current native/browser sign-in screenshots remain unavailable. Linux/component previews and API calls do not prove installed Windows behavior. See `docs/linux-desktop-testing.md` for the preserved intermittent native stall and later diagnostic runs.

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
