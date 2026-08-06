# Temporal local-runtime snafu retrospective — 2026-07-27

This records the repeated failures while trying to make explicit Discord timestamp references such as `<t:1785643200:t> 1 day earlier` use the semantic Temporal Plan-IR/model path in the local desktop app.

The latest verified result, refreshed on 2026-07-29, was:

- routing-smoke API: `http://127.0.0.1:8858`
- Temporal SLM endpoint: `http://127.0.0.1:8771/v1`
- model: `qwen-temporal-ir-qwen35-08b-bf16-chat-discord-reference-v7`
- proof input: `<t:1785643200:t> 1 day ebefore`
- proof output epoch: `1785556800`
- proof method: `agent+plan`
- proof duration: `1765ms`
- live contrast: bare token stayed deterministic; `1 day later`, `1 day earlier`,
  and `1 day ebefore` used `agent+plan` and preserved Discord format `:t`
- reference-routing endpoint eval: `23/23`, with zero false-fast-path and zero false-model-path cases
- broad required eval: v7 preserved the exact v5 pass/fail map (`154/172`) while
  correcting the `ebefore` epoch direction

## Snafu 1: meaningful language was silently discarded

The original fast path extracted the Discord timestamp and returned it while ignoring `1 hour later`. That was a false-fast-path bug: syntactically valid timestamp extraction was treated as sufficient even when nearby text materially transformed the result.

The correct boundary is semantic intent and complete consumption, not word count:

- exact standalone timestamp: deterministic formatting
- affirmative copied prose with an incidental timestamp: narrow deterministic extraction
- timestamp plus a transformation, comparison, timezone conversion, or scheduling relationship: model/Plan-IR
- ambiguous or unsupported relationships: clarify or fail closed

Prevention:

- Keep false-fast-path cases in the required routing eval.
- Require explicit route telemetry showing classifier version, route, reason, residue signals, and model eligibility.
- Never treat “found one valid timestamp” as proof that surrounding language is irrelevant.

## Snafu 2: patching examples deterministically contaminated the experiment

An intermediate build introduced a `typed_shift` deterministic path for compact modifiers. Logs later showed results such as:

```text
route: typed_shift
reason: fully_consumed_duration_shift
model: typed-discord-reference-v1
```

That made individual phrases fast, but violated the active product experiment: semantic interpretation, typo recovery, shorthand, and arbitrary natural-language relationships were supposed to exercise the SLM. It also risked creating an expanding phrase grammar merely to make screenshots pass.

Prevention:

- Do not add deterministic semantic shims in response to one failing phrase.
- Preserve deterministic code for explicit stable syntax, validation, calendar/timezone arithmetic, formatting, and execution of model-emitted Plan-IR.
- Classify SLM misses as data/eval/model failures first.
- Keep deterministic-only, SLM-only, LLM-only, and cascade permutations comparable.

## Snafu 3: debounce suppressed UI updates but did not cancel work

The UI originally generated semantic parse requests on effectively every keystroke. An `AbortController` existed, but the native Tauri bridge only checked the signal before and after `invoke`; it did not cancel:

- the Rust TCP request
- the Fastify parse
- the graph/model fetch
- a request waiting on the single-GPU lock
- active Transformers generation

The implemented cancellation path now uses:

- a unique request ID per UI parse
- 300ms debounce
- Tauri `cancel_time_parse`
- API `POST /parse/cancel`
- an active-request `AbortController` registry
- propagated graph and hosted-model abort signals
- `x-request-id` plus `POST /v1/cancel` for the local SLM
- interruptible GPU-lock waiting
- Transformers `StoppingCriteria` for active generation
- cancellation telemetry reported as `cancelled`, not parser failure

Proof included a live v5 request where cancellation was acknowledged and generation returned HTTP 499.

Prevention:

- Do not describe stale-result suppression as backend cancellation.
- Verify queued and active-generation cancellation separately.
- Require one live cancellation probe in addition to unit/fake-server tests.

## Snafu 4: v4 learned “later” but failed directionality for “earlier”

`1 day later` worked while `1 day earlier` still failed or produced the wrong direction. The v4 adapter returned the future epoch `1785729600` where the expected earlier epoch was `1785556800`.

The miss was preserved as training/eval evidence. The v5 adapter was retrained asynchronously with the corrected example and then passed the full 22-case endpoint routing eval.

Prevention:

- Every relative transformation family needs inverse-direction pairs: before/after, earlier/later, plus/minus.
- Required evals must assert exact epoch, not merely resolved status.
- Do not promote an adapter because one screenshot phrase works.
- Record model identity and endpoint in every live eval.

## Snafu 5: build success was confused with installed/runtime success

Frontend, API, Rust, and Python builds passed, and the release executable existed. That did not mean the installed or routing-smoke app was using those artifacts.

Additional failures:

- WiX `light.exe` failed while packaging the MSI even though the no-bundle executable built.
- The canonical Docker bind on port 8765 repeatedly failed with “Only one usage of each socket address” despite no visible listener, container binding, or excluded-port range.
- v5 therefore ran temporarily and successfully on 8771.
- The old installed API remained alive on 8857 while the routing-smoke API used 8858, creating two plausible local runtimes.

Prevention:

- Report executable build, MSI packaging, installation, process launch, API health, and installed-app smoke as separate gates.
- Stop exact stale app/API processes before a runtime smoke.
- Identify the tested runtime by executable path, PID, API port, entrypoint, start time, endpoint, and model.
- Do not release or claim installed-app success until the installed MSI path is smoke-tested.

## Snafu 6: settings were pushed onto the user, then “configured” without verification

The user was initially told to edit the Local SLM menu. That was unnecessary operator burden for a configuration the agent could manage.

Worse, settings JSON was placed directly into presumed Tauri store locations and the app was declared configured without checking the live API. The routing-smoke app did not consume that edit. Its actual port-8858 `/health` response showed:

```text
PlanIr: false
Endpoint: null
Model: qwen-temporal-ir
```

The user’s screenshot failed almost instantly because the request never reached the model.

The durable smoke fix was to make `routing-smoke` feature defaults explicitly enable the local SLM and point to v5 on 8771. This avoids relying on an external settings-store mutation for the isolated smoke build.

Prevention:

- Never claim settings took effect from a file write alone.
- Verify the running API’s `/health` response after every configuration change.
- Required live fields: Plan-IR enabled, Discord reference routing enabled, exact endpoint URL, exact model, port, and entrypoint.
- Keep temporary smoke defaults feature-scoped; do not silently change production defaults.

## Snafu 7: the final proof initially used a stale API key

The first direct port-8858 proof request returned 401 because the persisted key files did not match the supervised API’s current key. This was correctly treated as a test-fixture/authentication problem, not as parser evidence.

The final proof restarted only the smoke app with a process-scoped random `HAMMEROVERLAY_API_KEY`, inherited by Tauri and its sidecar. The exact failing phrase then resolved through port 8858 using `agent+plan` in 3620ms.

Prevention:

- Do not weaken or bypass API authentication for smoke tests.
- Use a process-scoped ephemeral key shared by the app and sidecar.
- Distinguish 401 fixture failures from parser/model failures.

## Snafu 8: typo recovery produced a confident answer in the wrong direction

The v5 adapter handled `<t:1785643200:t> 1 day earlier`, but interpreted the
misspelled `<t:1785643200:t> 1 day ebefore` as a positive one-day shift. The
raw Plan-IR contained `shift_datetime` with `days: 1`, so the deterministic
executor correctly returned the model's wrong future answer. Internal
arithmetic validation passed because it could prove that the executor followed
the plan; it could not prove that the plan matched the user's language.

The exact miss and balanced before/after typo variants were added to training
and eval data. The v6 focused endpoint routing gate passed 23/23, including the
exact miss, but the broad required suite exposed a separate explicit-date
range regression. v6 was therefore not promoted. The next training replay
includes that range case plus distinct validation and holdout variants.

Prevention:

- A resolved status is not enough; directionality evals must assert the exact epoch.
- Semantic validation must not be confused with executor consistency checks.
- Compare every candidate adapter case-by-case against the deployed baseline.
- Do not promote an aggregate tie when the candidate trades one required pass
  for another; preserve both behaviors in replay data and rerun the gates.
- Keep typo interpretation in the SLM experiment lane rather than adding a
  deterministic fuzzy spelling rule.

## Snafu 9: one clock-composition phrase exposed a missing combinatorial family

The v7 adapter could transform a Discord timestamp with relative shifts, but
`<t:1785643200:t> day at 12 pm` failed because the training data did not cover
the broader operation: preserve the referenced timestamp's local calendar date
and replace its clock time. The existing Plan-IR already supported the correct
three-step composition (`resolve_calendar_query`, `resolve_clock_time`,
`combine_date_time`), so this was a data/generalization gap rather than a DSL
or executor gap.

The first candidate, v8, learned the resolved examples but failed the negative
boundary: `<t:1785643200:t> day at 12` should ask whether the user means 12 AM
or 12 PM. v8 was not promoted. v9 added crossed ambiguity examples alongside
multiple Discord styles, clocks, word orders, held-out paraphrases, and
spring-forward/fall-back dates.

Promotion evidence for v9:

- Focused live routing gate: 30/30, zero false fast paths, zero false model
  paths, and 2503ms worst-case latency.
- Broad required Plan-IR gate: 162/179 versus v7's 154/172.
- Case-by-case comparison: zero v7 pass-to-v9-fail regressions, one existing
  case improvement, and all seven new clock-composition cases passing.
- Rebuilt routing-smoke sidecar on port 8858 reported Plan-IR and Discord
  reference routing enabled, endpoint `http://127.0.0.1:8771/v1`, and model
  `qwen-temporal-ir-qwen35-08b-bf16-chat-discord-reference-v9`.
- Direct desktop-sidecar probes preserved the standalone deterministic fast
  path, resolved both the original and held-out composition wording through
  `agent+plan`, and returned an AM/PM clarification for the ambiguous form.

Prevention:

- Train semantic operations as crossed families, not screenshot strings:
  operands, word order, styles, clock forms, DST boundaries, and ambiguity.
- Keep genuinely ambiguous 1-12 clocks as clarification cases; do not weaken
  validation or add a deterministic phrase shim to make a candidate pass.
- Hold out structurally different paraphrases and require exact epoch checks.
- Promote only after focused routing/style gates and a case-by-case broad
  baseline comparison.

## Required local verification sequence

Before asking a human to retry the UI:

1. Confirm the intended model server is healthy and record its model identity.
2. Stop stale desktop/API processes on competing ports.
3. Build the API, frontend, and no-bundle desktop executable.
4. Launch the exact executable under test.
5. Query its API `/health`.
6. Assert Plan-IR is enabled and the endpoint/model are exact.
7. Submit the failing phrase directly through that same API.
8. Assert the exact epoch and semantic method.
9. Inspect telemetry for a model call and nonzero agent duration.
10. Only then ask the user for the visual/manual overlay check.

## Ownership correction

The agent should own deployment configuration, process cleanup, health checks, direct API proof, and log inspection. The human should only be asked to perform the genuinely human portion requested here: visual/manual installed-app behavior verification.

## Snafu 10: a current MSI build was confused by host validation and elevation boundaries

The current routing-smoke build compiled the frontend, API sidecar, Rust
executable, WiX source, and WiX object, then failed in `light.exe` because the
host's optional ICE actions could not access Windows Installer. The decisive
errors were `LGHT0217` for ICE01 through ICE07 followed by `LGHT0216` at ICE09.
This was not a model, parser, application-link, or source-schema failure.

The already-generated current WiX object was linked separately with
`light.exe -sval`, which suppresses only MSI/MSM ICE validation. That produced
a distinct July 30 candidate instead of overwriting or reusing the stale July
27 MSI. Its SHA-256 is
`9FC320CADF6A3C7B1D7578DEF2802A4719039AB94A77B9BB73862E22D52F01E1`.

The first silent install then failed with MSI 1603 because replacing the
existing machine-wide Routing Smoke product requires an Administrator token.
Running outside the workspace sandbox was not the same thing as Windows UAC
elevation. A subsequent UAC request was declined, so no installed-app success
was claimed and the installed path was not used as evidence.

The owner later approved UAC. The July 30 MSI installed successfully, and the
installed verifier proved exact executable and sidecar hashes, installed
process paths, V9 `/health` configuration, ten semantic/cancellation probes,
and a warmed model-path p95 of `2821ms`. The first verification attempt also
correctly failed closed when Docker Desktop and port 8771 were unavailable;
after the canonical V9 container was restored and prewarmed, the same verifier
passed without reinstalling.

The first manual handoff still opened the wrong overlay because production
HammerOverlay and Routing Smoke were both running with `Ctrl+Shift+H`;
production had registered the shortcut first. Restarting only Routing Smoke
was insufficient once the verifier-launched sidecar remained alive with its
process-scoped API key. The final isolated smoke stopped the exact production,
Routing Smoke, and installed sidecar paths, then reran the installed verifier
so one desktop/sidecar pair shared one ephemeral key and owned the shortcut.

The verifier now detects a running production executable and refuses to call
the system manual-ready unless `-StopProductionForManualSmoke` is explicitly
provided. This preserves production by default and makes isolated hotkey
ownership an intentional, observable test condition.

The owner subsequently observed the installed Routing Smoke overlay ask
whether a bare `2:39` reference-clock composition meant AM or PM and accepted
the behavior as the V9 stopping point. The question-only presentation is
recorded as a nonblocking interactive-clarification UX follow-up, not as a
wrong-timestamp or false-fast-path success.

Prevention:

- Capture the verbose WiX error before changing packaging inputs.
- Treat `-sval` as an explicit local-candidate workaround, not proof that ICE
  validation passed.
- Give every candidate a new filename, timestamp, size, and SHA-256 so stale
  installers cannot masquerade as current.
- Distinguish sandbox approval from a Windows Administrator token.
- Do not repeatedly prompt after UAC is declined; finish non-admin evidence
  and leave the exact installed-app gate open.
- Never substitute a workspace executable, old MSI, registry entry, or
  successful API test for installed-path proof.
