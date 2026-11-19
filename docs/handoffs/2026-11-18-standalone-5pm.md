# Hosted V22 standalone clock failure

BASIC reported `5pm` failing in installed private HammerOverlay 0.1.7 on November 18. RunPod connectivity worked; the generated plan did not validate. This remains an open model-quality issue, separate from the overlay corner fix.

The original generation was `tp_6cc6278f-1564-40d8-8d35-34eabef615d0`, reference `2026-11-18T21:18:11.689Z`, timezone `America/Indianapolis`. The intended timestamp is November 18 at 17:00 local, epoch `1795039200`. The app recorded one V22 call, 3200 ms, method `agent+plan`, operations `resolve_calendar_query,shift_datetime`, failed validation and no fallback. A request with the original reference reproduced the failure as `tp_cb0ad418-503a-4ff2-abc2-9e53990f200d`. The HTTP error response does not retain the raw plan or detailed validation checks.

`diagnostic-standalone-5pm-installed-runpod` preserves this exact example in the maintained eval runner as a nonblocking diagnostic. Its deterministic baseline passed. This does not validate V22 or justify a default change.

No retraining, serving-stack change, provider reconfiguration, input-specific runtime override or parser-default change is included here.

## Captured trace

[Diagnostic run 44402855165](https://github.com/BASIC-BIT/discord-time-app/actions/runs/44402855165) captured the model output. It resolves calendar query `5pm` to the correct local 17:00, then emits `shift_datetime` with `delta.hours=17`. That produces November 19 at 10:00 local. Validation rejects it with `Input mentioned 17:00, but candidate time is 10:00.` The model also emits `finalStep=2` for a two-step plan and a rationale claiming a one-hour shift. The executor correctly rejects the wrong timestamp.

This runner used its default `responseFormat=json_schema`; the installed runtime uses unconstrained output. Its trace is evidence of the reproduced model-plan failure, not the original request's raw output. Both installed requests recorded the same operation sequence and 81 completion tokens, but their raw plans were not retained. The diagnostic remains nonblocking and does not establish a serving-default fix. Next work is a matched-runtime diagnostic family and standalone-clock training coverage, then eval-gated model comparison or retraining.

## November 19: local Luna fallback investigation

The user's local screenshot contained `5pms` while the test profile simulated RunPod warmup. The relay usage table contained only the earlier synthetic acceptance request, so that attempt had not reached Luna. The signed-out client returned null and displayed the deterministic error. It now throws a `sign_in_required` error, and the overlay offers a Sign in action leading to Settings. The rebuilt local executable is running on Ctrl+Shift+Alt+J. Actual native sign-in remains unverified and awaits the user. Desktop control helpers failed to start with the Windows sandbox process error.

Separate forced Luna-only diagnostics showed that Luna understood both strings as 17:00, including explicit typo correction for `5pms`. Its plan ended on `resolve_clock_time`, which produces clock data rather than a dated timestamp candidate. The executor rejected that incomplete plan correctly.

The general planner instructions now distinguish clock/zone values from dated candidates and explain that a standalone clock can use `resolve_calendar_query` to apply the existing calendar context. No deterministic typo rule or output override was added. Six Luna-only cases passed with deterministic preflight disabled and independent validation enabled: `5pm`, `5pms`, `7pms`, `17:00`, `tomorrow at 5pm`, and `tmrw at seventeen hundred`. Their measured durations were approximately 6.3-10.6 seconds. Negative controls returned clarification for `5` and failure for `banana submarine`.

The development Convex relay was updated. A genuine Clerk JWT for the previously approved synthetic user resolved `5pms` to epoch `1795125600`, with validation passing, at reference `2026-11-19T18:00:00Z` in America/Indianapolis. That test session was revoked. This is backend acceptance, not native signed-in-user proof. The full offline regression suite passed. No installer or release was made, and the V22 RunPod adapter was not changed or qualified by these Luna results.

The maintained nonblocking diagnostic `diagnostic-luna-standalone-clock-typo` preserves the new input. To compare it with the original standalone-clock case through the existing eval runner:

```powershell
$env:TEMPORAL_EVAL_MODELS = 'gpt-6-luna:low'
$env:TEMPORAL_EVAL_EXPERIMENTS = 'plan-ir:planIr=true,deterministicPreflight=false'
$env:TEMPORAL_EVAL_CASE_IDS = 'diagnostic-standalone-5pm-installed-runpod,diagnostic-luna-standalone-clock-typo'
npm --prefix api run eval:temporal
```

## Installed corner fix

The separate CSS fix rounds the outer one-pixel color layer at 8px and its inner panel at 7px. Private MSI 0.1.8 from [build 44401288345](https://github.com/BASIC-BIT/discord-time-app/actions/runs/44401288345), packaging head `f20e0528d329d3a22babf59b87810d46eb682149`, SHA-256 `5A0C2F39E4499A0FEE88985690A03807AF014B3CDA6CC865E0996A5F9F66BB09`, installed successfully with exit 0. Native Windows screenshots delivered directly to BASIC show continuous blue verifying and red error borders around the corners. The installed parser reports appVersion 0.1.8 and the existing RunPod endpoint. A synthetic dated-clock request still resolved through V22; `5pm` still failed. The frontend build, offline test suite, and deterministic diagnostic passed. No public release was published. Future automatic updates for this private installation need a version greater than 0.1.8.
