# Hosted V22 standalone clock failure

BASIC reported `5pm` failing in installed private HammerOverlay 0.1.7 on November 18. RunPod connectivity worked; the generated plan did not validate. This remains an open model-quality issue, separate from the overlay corner fix.

The original generation was `tp_6cc6278f-1564-40d8-8d35-34eabef615d0`, reference `2026-11-18T21:18:11.689Z`, timezone `America/Indianapolis`. The intended timestamp is November 18 at 17:00 local, epoch `1795039200`. The app recorded one V22 call, 3200 ms, method `agent+plan`, operations `resolve_calendar_query,shift_datetime`, failed validation and no fallback. A request with the original reference reproduced the failure as `tp_cb0ad418-503a-4ff2-abc2-9e53990f200d`. The HTTP error response does not retain the raw plan or detailed validation checks.

`diagnostic-standalone-5pm-installed-runpod` preserves this exact example in the maintained eval runner as a nonblocking diagnostic. Its deterministic baseline passed. This does not validate V22 or justify a default change.

Next experiment: capture the hosted raw plan through the endpoint eval runner, then compare a small standalone-clock family with the existing dated-clock baseline. If this is semantic plan generation, reinforce neighboring standalone clock examples and evaluate a retrained adapter while retaining this phrase as holdout. Do not introduce an input-specific runtime override. No retraining, serving-stack change, provider reconfiguration or parser-default change is included here.
