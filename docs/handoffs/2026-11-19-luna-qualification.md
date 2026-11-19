# Luna fallback qualification, November 19

The full maintained live evaluation **failed: 148/202 required cases passed**. Four of five diagnostic cases passed, including standalone `5pm`, `5pms`, and the spelled-out clock example. This is not sufficient to promote the parser defaults or release the fallback.

The tested source was `f02fe387ba416f51808a9ceee89b3f927ee17368`, with `gpt-6-luna`, low reasoning, and `planIr=true,deterministicPreflight=true,discordReferenceRouting=true`. There were no provider exceptions. Median final latency was 2,929 ms and P95 was 13,497 ms. Cost estimates were unconfigured, so the reported zero is not a measured dollar cost.

Of 54 required mismatches, 16 returned failure, 26 returned clarification, and 12 returned a resolved answer. Nine resolved mismatches concerned the selected Discord format. Three resolved an input that should have failed or required clarification. Several failures ran through deterministic parsing plus model validation, so this result is not purely a Plan-IR planner score. It does not establish which misses predate the prompt changes.

The [case-level evidence](2026-11-19-luna-qualification.json) preserves all 54 failures and the diagnostics. The full local report is `.cache/luna-required-eval.json`. No expected answers, validation checks, deterministic semantics, or required-case designations were weakened to improve this score.

Reproduce from `api/` with an authorized `OPENAI_API_KEY` available:

```powershell
$env:TEMPORAL_EVAL_MODELS = 'gpt-6-luna:low'
$env:TEMPORAL_EVAL_EXPERIMENTS = 'plan-ir:planIr=true,deterministicPreflight=true,discordReferenceRouting=true'
$env:TEMPORAL_EVAL_REQUIRE_OPENAI = '1'
$env:TEMPORAL_EVAL_PROGRESS_EVERY = '10'
$env:TEMPORAL_EVAL_OUTPUT = '../.cache/luna-required-eval.json'
$env:LANGFUSE_ENABLED = 'false'
npm run eval:temporal
```

The next decision is whether to keep the new fallback off by default while it is qualified, or continue the parser experiment before landing it. Exact installed-MSI authentication acceptance also remains open: the isolated review MSI was built and hashed, but its UAC installation was canceled.

The user selected continued parser research. The first targeted contract repair passed 43/59 required cases sampled from all original failures plus controls, leaving 16 failures. It exposed missing calendar-default instructions, a dropped OpenAI presentation-format argument, meridiem truncation in range syntax, premature single-candidate acceptance of ranges and unexplained residue, and stopping after rejected deterministic validation instead of attempting Plan-IR repair. Repairs preserve the original expected answers and deterministic execution checks. Full qualification is still pending; the model-only and repaired-preflight lanes are being compared rather than silently changing the relay default.

The later complete hybrid experiment reached **200/202 required, 5/5 diagnostic**, then a display-contract revision regressed to **197/202 required, 4/5 diagnostic**. The latter exposed stochastic disagreements about boundary qualifiers, supported bare epochs, choice-outcome metadata, short-date ambiguity, and display style. These are distinct source snapshots, not repeated attempts at one unchanged build. Both complete reports and their source hashes are summarized in [research evidence](2026-11-19-luna-research.json). No parser default is qualified by these scores.

The model-only comparison scored 131/202 required, and deterministic-only scored 125/202. They are comparison snapshots, not a paired comparison of the final source and not accepted alternatives. Deterministic preflight remains enabled. Planner and validator contract research continues with Luna low; the required catalog and its expected answers remain unchanged.

Exact head 8ecdbf1 scored **200/202 required and 4/5 diagnostic**. The remaining required failures were `compound-typo-cultural-clock` (a midnight literal overrode a 13:37 clock dependency) and `explicit-year-holiday` (the validator rejected the configured regional holiday calendar). The full report is `.cache/luna-product-full.json`, summarized with source hashes in the research artifact. No required mismatch returned a wrong singular answer in this run.

Further targeted testing exposed an empty `propose_candidate` appended to an otherwise correct compound plan. The follow-up permits one error-guided repair of an unexecutable OpenAI plan, retains both traces and complete token counts, and independently validates the repaired result. Semantic validation rejection and no-plan do not receive this retry. Fake-provider tests prove the one-repair bound and usage accounting; the targeted live cases passed 2/2 required and 1/1 diagnostic. A new full qualification is required. Partial probes stopped after an edit assertion or offline accounting failure are not qualification results.

Exact head 356c5d7 scored **199/202 required and 5/5 diagnostic**. Its misses were one Discord presentation choice and two plans rejected before execution by existing reference/clock guards. The initial repair trigger only handled execution failures; it now covers guard-rejected plans while keeping those guards unchanged. All three targeted cases passed, and a real clock-choice case exercised successful error-guided repair in 26 seconds. The relay's deadline now prevents starting a repair without a conservative budget for another planner/validator round. Full correctness evaluation does not impose that relay deadline; latency and deadline behavior are separate measurements.

The current source also uses the existing timezone registry to provide explicit, validated zone alternatives for an otherwise resolvable expression, rather than matching clarification prose. No new timezone aliases or typo rules were added. Earlier evaluation snapshots omitted deterministic-validation token usage; current accounting includes accepted and rejected validation calls and bounded repair. Dollar cost remains unconfigured.
