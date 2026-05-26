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
$env:TEMPORAL_EVAL_MODELS = "gpt-5.4-mini,gpt-5.5,gpt-5.4-nano"
$env:TEMPORAL_EVAL_BASELINES = "deterministic,single-call:gpt-5.4-mini"
$env:OPENAI_API_KEY = "..."
$env:TEMPORAL_EVAL_OUTPUT = "reports/temporal-eval.json"
npm run eval:temporal
$env:TEMPORAL_EVAL_INPUT = $env:TEMPORAL_EVAL_OUTPUT
npm run eval:temporal:report
```

Useful options:

- `TEMPORAL_EVAL_MODELS`: comma-separated model list; entries can specify reasoning effort as `model:effort`.
- `TEMPORAL_EVAL_BASELINES`: comma-separated baseline runners. Supported values are `deterministic` and `single-call:model[:effort]`.
- `TEMPORAL_EVAL_BLOCKING_RUNNERS`: comma-separated runner names whose required failures should fail the process. Defaults to `agent`, so baseline failures stay comparative.
- `TEMPORAL_EVAL_OUTPUT`: write full JSON results to a path.
- `TEMPORAL_EVAL_LIMIT`: run the first N eval cases for quick iteration.
- `TEMPORAL_EVAL_REPEATS`: repeat each model/case N times to measure stochastic reliability.
- `TEMPORAL_EVAL_INPUT`: JSON file consumed by the HTML report generator.
- `TEMPORAL_EVAL_REPORT`: HTML report path, defaulting to `reports/temporal-eval.html`.
- `TEMPORAL_EVAL_SUMMARY`: optional machine-readable summary JSON path.
- `TEMPORAL_EVAL_REQUIRE_OPENAI=1`: fail instead of skipping when credentials or model list are missing.
- `TEMPORAL_EVAL_NOW` and `TEMPORAL_EVAL_TZ`: override the fixed eval clock and timezone.

The eval output tracks pass/fail, end-to-end latency, graph timing, first model response latency, first candidate latency, final response latency, LLM/tool/final-validation duration, tool call counts, tool sequences, tool pass count, agent attempt count, and prompt character counts from graph trace metadata.

These fields are API analytics-ready, but they are not true token-level TTFT. Exact TTFT requires streaming model callbacks, which should be added behind an instrumentation flag once the non-streaming router baseline is stable.

Baseline runners are eval-only. `deterministic` measures the existing local parser without model calls. `single-call:model` measures a non-agentic structured model call with no tools so we can compare raw model latency/accuracy against the LangGraph tool chain.

Some cases are diagnostic rather than required. For example, `next saturday 10pm` from a Sunday currently records whether the model asks for clarification between the coming Saturday and the Saturday after that, without failing the whole eval suite. Flip diagnostic cases to required only after the product semantics are chosen.

## Routing Strategy

- Keep `gpt-5.5` as the production default until cheaper candidates show repeated reliability on required evals. Treat `gpt-5.4-mini` as the leading cost/latency candidate and `gpt-5.4-nano` as experimental until it passes baseline cases.
- Prefer routing by workflow step only after eval data shows a stable split, such as a faster planner model plus a stronger final validator.
- Keep deterministic code focused on calendar arithmetic, validation, and formatting; use model routing for fuzzy interpretation rather than adding phrase tables.
- Optimize time-to-first-use before optimizing total graph sophistication: fewer LLM passes, smaller prompts, smaller tool outputs, and fewer final validation calls matter more than provider abstraction right now.

## Autoresearcher-Style Loop

Karpathy's AutoResearch pattern is a useful north star for parser optimization: define an eval suite, let an agent propose one small change, run the leaderboard, keep the change only if required pass rate holds and latency improves. For this repo, keep that loop constrained to prompt/tool-output/router changes and require the static eval report as the artifact for every accepted experiment.
