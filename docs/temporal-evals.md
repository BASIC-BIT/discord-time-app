# Temporal Eval And Benchmark Notes

## Current Default

- Production default model: `gpt-5.5`.
- Production default reasoning effort: `low`.
- Do not switch defaults based on one prompt or one manual run. Use the eval harness first.

## Persistent Test Lanes

- `api npm test` runs deterministic smoke coverage and should stay PR-safe.
- `api npm run test:temporal:live` runs a small live smoke suite when `OPENAI_API_KEY` or `TEMPORAL_LIVE_API_URL` is configured.
- `api npm run eval:temporal` runs multi-model live evals when `TEMPORAL_EVAL_MODELS` is configured.

## Multi-Model Eval

Run from `api/`:

```powershell
$env:TEMPORAL_EVAL_MODELS = "gpt-5.5,gpt-5.4-mini,gpt-5.4-nano"
$env:OPENAI_API_KEY = "..."
npm run eval:temporal
```

Useful options:

- `TEMPORAL_EVAL_MODELS`: comma-separated model list; entries can specify reasoning effort as `model:effort`.
- `TEMPORAL_EVAL_OUTPUT`: write full JSON results to a path.
- `TEMPORAL_EVAL_LIMIT`: run the first N eval cases for quick iteration.
- `TEMPORAL_EVAL_REQUIRE_OPENAI=1`: fail instead of skipping when credentials or model list are missing.
- `TEMPORAL_EVAL_NOW` and `TEMPORAL_EVAL_TZ`: override the fixed eval clock and timezone.

The eval output tracks pass/fail, end-to-end latency, graph timing, LLM/tool/final-validation duration, tool pass count, agent attempt count, and prompt character counts from graph trace metadata.

## Routing Strategy

- Treat `gpt-5.4-mini` and `gpt-5.4-nano` as eval candidates, not production defaults, until they pass the same hard cases with materially lower latency.
- Prefer routing by workflow step only after eval data shows a stable split, such as a faster planner model plus a stronger final validator.
- Keep deterministic code focused on calendar arithmetic, validation, and formatting; use model routing for fuzzy interpretation rather than adding phrase tables.
- Optimize time-to-first-use before optimizing total graph sophistication: fewer LLM passes, smaller prompts, smaller tool outputs, and fewer final validation calls matter more than provider abstraction right now.
