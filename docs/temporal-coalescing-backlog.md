# Temporal Coalescing Backlog

This captures follow-up ideas without bloating the v1 implementation.

## Product Surfaces

- Keep HammerOverlay focused on the existing hotkey UI and Discord timestamp output.
- Add a distinct multi-time output mode for pasted text with several explicit times: return a newline-delimited list in the selected Discord format, likely in a small right-side wing/panel. Keep this separate from the current single timestamp output and from clarification alternatives.
- Expose the temporal coalescing engine as a thin API endpoint once stable.
- Consider a Discord bot surface for direct timestamp coalescing in chat.
- Consider an MCP/tool surface so other agents can call the entire temporal agent as one tool.
- Consider a reusable OpenCode skill that describes the temporal coalescing pattern in words for agents with different capabilities.

## Cross-Project Reuse

- VRDex event ingest should reuse the temporal core for pasted event text, Discord posts, posters, OCR output, and screenshots.
- Keep Discord formatting as a surface-level concern, not part of the temporal core.
- Treat the core as fuzzy time matching and temporal coalescing, not as a Discord timestamp library.

## Timezone Resolution Track

- Active plan: `docs/temporal-timezone-support-plan.md`.
- Add explicit timezone resolution as a first-class parser/executor capability, not a synonym-only runtime patch. The current core uses the request `calendarContext.timeZone` when text does not specify a timezone.
- Preserve the user's current/configured timezone as the default for unspecified inputs, with settings support to force a different default timezone.
- Extend Plan-IR execution so a resolved timezone field can override the request timezone for the relevant anchor or clock phrase while final Discord output still renders from the resolved instant.
- Support high-value event text forms: `Eastern`, `Central`, `Pacific`, `EST`, `EDT`, `PST`, `UTC`, `Z`, `+00:00`, `JP time`, `AEST`, and full IANA names.
- Treat ambiguous abbreviations as clarification or no-plan unless context resolves them safely. Avoid fixed-offset assumptions for DST-sensitive abbreviations such as `EST`/`EDT`/`PST`.
- Add eval lanes for no explicit timezone, explicit timezone, offset forms, DST boundaries, user configured timezone different from event timezone, and chained relative offsets around timezone-bearing anchors.

## Chronote Integration

- Chronote may be a good future host for the capability because it already interfaces with Discord.
- Avoid pulling Chronote into the HammerOverlay implementation path until the temporal loop is reliable in this app.
- Revisit once the engine is API-shaped and billing/auth requirements are clearer.

## Billing And API Keys

- If this becomes a public API, it needs API keys, quotas, rate limits, and abuse protection.
- Explore low-effort billing/API-key platforms before building billing from scratch.
- Possible product idea: low monthly subscription for generous or unlimited use.
- Keep this out of v1; it is infrastructure and product scope, not parsing reliability.

## Observability

- Generation ledger plan: `docs/temporal-generation-ledger.md`.
- Add PostHog after publication for privacy-safe product analytics: parser availability, latency buckets, status/method, clarification shown/chosen, error classes, and retention. Do not collect raw user text by default.
- Productize Langfuse for LLM evaluation, prompt/version tracking, trace sampling, and eval-set curation once privacy and retention boundaries are explicit.
- Trace model calls, tool calls, candidate proposals, finalization, validation warnings, latency, and cost.
- Add a generated parse/generation ID to every parser response so later UI actions can refer back to the exact suggestion set without resending raw text.
- Add an API endpoint for passive outcome tracking from the desktop app, for example accepted by hitting Enter/clicking a time, copied but not inserted, dismissed with Escape, edited before copy, or timed out. Keep the payload privacy-safe: generation ID, selected candidate/format ID, method/model/version, latency/status metadata, and consented coarse client/app version fields.
- Add a first-class feedback endpoint and UI affordance for active feedback. Start simple: thumbs up/down, wrong date, wrong time, should have clarified, should have parsed, and optional text only behind an explicit consent boundary.
- Use accepted/dismissed/feedback outcomes to curate future evals and training rows. Separate product analytics from raw training ingestion; raw text should require explicit retention and anonymization policy.

## Future Model Training

- Investigate a small trained model that maps user text to the temporal Plan-IR, not directly to timestamps.
- Keep deterministic execution as the source of truth: the model proposes IR, then calendar math, validation, and formatting remain deterministic and inspectable.
- Consider adding a supervised `preferredDisplayFormat` output to the SLM training target, derived from prior LLM heuristics and privacy-safe ledger outcomes. Keep this separate from semantic Plan-IR correctness: the model may rank the Discord display style, but deterministic execution still owns the timestamp and the UI should keep learning from copied/selected format outcomes.
- Use analytics, clarification outcomes, and Langfuse/eval traces only after explicit privacy, consent, retention, and anonymization boundaries are in place.
- Benchmark against the current LLM Plan-IR path on first-correct-display latency, required eval pass rate, and invalid-IR rejection rate before considering it for production.

## Experimentation And Feature Flags

- Parser cascade contract: `docs/temporal-parser-cascade-architecture.md`.
- Keep the current agent/tool path runnable as the baseline while experimenting with a structured temporal-plan IR.
- Gate new parser strategies with explicit flags, for example `TEMPORAL_FEATURE_PLAN_IR`, `TEMPORAL_FAST_SINGLE_CALL_ENABLED`, and `TEMPORAL_SKIP_FINAL_VALIDATION_ENABLED`.
- Include the feature-flag set, model, reasoning effort, status, first-correct-display latency, final latency, LLM turns, tool calls, candidate count, failure class, and expected-vs-actual result in eval output.
- Run eval matrices before promoting a parser strategy: baseline only, one feature at a time, and selected feature permutations.
- Use `npm --prefix api run eval:temporal:autoresearch` for the local matrix wrapper. By default it writes JSON, summary JSON, and HTML into `api/reports/temporal-autoresearch/`.
- The current default matrix compares `baseline:planIr=false` against `candidate:planIr=true` and includes the deterministic runner plus `gpt-5.5:low` when `OPENAI_API_KEY` is configured.
- `TEMPORAL_FEATURE_PLAN_IR=true` enables the experimental structured plan/action-list path: one LLM call creates candidate plans, then deterministic operations execute those plans and alternatives in parallel before validation.
- For a deterministic smoke without spending model calls, run with `TEMPORAL_EVAL_MODELS=" "`, `TEMPORAL_EVAL_BASELINES=deterministic`, and optionally `TEMPORAL_EVAL_LIMIT=1`.
- Treat the LLM's job as semantic decomposition into a plan; keep deterministic code focused on executing calendar operations, validation, and formatting.
- Remove or demote losing flags after the decision is recorded so experimental paths do not become permanent complexity.

## Desktop App Follow-Ups

- Investigate start-on-login for HammerOverlay.
- Continue hardening the bundled temporal API sidecar so users do not have to start a separate local service after reboot.
- Add visible service status, restart/backoff controls, and logs reachable from settings.
- Preserve the existing fast hotkey UX; the app is already useful and should not be destabilized by the temporal engine work.

## Overlay UX Follow-Ups

- Add provenance-aware display metadata so the UI can distinguish date/time parts that were directly present in the user's text from parts inferred by the agent or defaulted by deterministic validation.
- Keep that provenance model LLM/tool-backed; do not add ad hoc regex highlighting for arbitrary natural-language examples.
- Explore stable-order format ranking: keep the seven Discord formats in the learned order, but visually emphasize formats that preserve the user's likely intent, especially short date, short date/time, long date/time, and relative time.
- Treat short time and long time as lower priority when the parsed candidate includes a meaningful date unless the user explicitly asked for time-only output.
- Add a clipboard-intake setting: allow disabling clipboard prefill, and eventually use a small model/classifier to decide whether clipboard text plausibly contains a date/time before auto-filling it.
- For low-plausibility clipboard text, show an optional "Use clipboard text" action instead of silently parsing copybuffer garbage.
- For numeric slash inputs like `4/5` and `5/5`, fail closed or ask for clarification when surrounding prose suggests ratings/reviews rather than date intent.
