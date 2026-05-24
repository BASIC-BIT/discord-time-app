# Temporal Coalescing Backlog

This captures follow-up ideas without bloating the v1 implementation.

## Product Surfaces

- Keep HammerOverlay focused on the existing hotkey UI and Discord timestamp output.
- Expose the temporal coalescing engine as a thin API endpoint once stable.
- Consider a Discord bot surface for direct timestamp coalescing in chat.
- Consider an MCP/tool surface so other agents can call the entire temporal agent as one tool.
- Consider a reusable OpenCode skill that describes the temporal coalescing pattern in words for agents with different capabilities.

## Cross-Project Reuse

- VRDex event ingest should reuse the temporal core for pasted event text, Discord posts, posters, OCR output, and screenshots.
- Keep Discord formatting as a surface-level concern, not part of the temporal core.
- Treat the core as fuzzy time matching and temporal coalescing, not as a Discord timestamp library.

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

- Add Langfuse when the LangGraph loop is wired in.
- Trace model calls, tool calls, candidate proposals, finalization, validation warnings, latency, and cost.
- PostHog can come later for product analytics.

## Desktop App Follow-Ups

- Investigate start-on-login for HammerOverlay.
- Preserve the existing fast hotkey UX; the app is already useful and should not be destabilized by the temporal engine work.

## Overlay UX Follow-Ups

- Add provenance-aware display metadata so the UI can distinguish date/time parts that were directly present in the user's text from parts inferred by the agent or defaulted by deterministic validation.
- Keep that provenance model LLM/tool-backed; do not add ad hoc regex highlighting for arbitrary natural-language examples.
- Explore stable-order format ranking: keep the seven Discord formats in the learned order, but visually emphasize formats that preserve the user's likely intent, especially short date, short date/time, long date/time, and relative time.
- Treat short time and long time as lower priority when the parsed candidate includes a meaningful date unless the user explicitly asked for time-only output.
- Add a clipboard-intake setting: allow disabling clipboard prefill, and eventually use a small model/classifier to decide whether clipboard text plausibly contains a date/time before auto-filling it.
- For low-plausibility clipboard text, show an optional "Use clipboard text" action instead of silently parsing copybuffer garbage.
- For numeric slash inputs like `4/5` and `5/5`, fail closed or ask for clarification when surrounding prose suggests ratings/reviews rather than date intent.
