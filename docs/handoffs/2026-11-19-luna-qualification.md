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
