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
- `TEMPORAL_EVAL_BASELINES`: comma-separated baseline runners. Supported values are `deterministic`, `single-call:model[:effort]`, `trained-plan`, and `endpoint-plan`.
- `TEMPORAL_EVAL_BLOCKING_RUNNERS`: comma-separated runner names whose required failures should fail the process. Defaults to `agent`, so baseline failures stay comparative.
- `TEMPORAL_EVAL_OUTPUT`: write full JSON results to a path.
- `TEMPORAL_EVAL_LIMIT`: run the first N eval cases for quick iteration.
- `TEMPORAL_EVAL_REPEATS`: repeat each model/case N times to measure stochastic reliability.
- `TEMPORAL_EVAL_INPUT`: JSON file consumed by the HTML report generator.
- `TEMPORAL_EVAL_REPORT`: HTML report path, defaulting to `reports/temporal-eval.html`.
- `TEMPORAL_EVAL_SUMMARY`: optional machine-readable summary JSON path.
- `TEMPORAL_EVAL_REQUIRE_OPENAI=1`: fail instead of skipping when credentials or model list are missing.
- `TEMPORAL_EVAL_NOW` and `TEMPORAL_EVAL_TZ`: override the fixed eval clock and timezone.

The eval output tracks pass/fail, first-correct-display latency, end-to-end final latency, graph timing, first model response latency, first candidate latency, final response latency, LLM/tool/final-validation duration, tool call counts, tool sequences, tool pass count, agent attempt count, and prompt character counts from graph trace metadata.

First-correct-display latency measures the first UI-visible state that matches product semantics: a resolved case must show the expected epoch, while a clarification case must show the expected alternative set. A singular answer does not count as correct for an expected clarification, even if it is one of the alternatives.

These fields are API analytics-ready, but they are not true token-level TTFT. Exact TTFT requires streaming model callbacks, which should be added behind an instrumentation flag once the non-streaming router baseline is stable.

Baseline runners are eval-only. `deterministic` measures the existing local parser without model calls. `single-call:model` measures a non-agentic structured model call with no tools so we can compare raw model latency/accuracy against the LangGraph tool chain. `trained-plan` replays JSONL Plan-IR predictions through the deterministic executor. `endpoint-plan` calls a local or hosted OpenAI-compatible endpoint, parses compact Temporal Plan-IR, and runs the same executor-backed scoring.

## OpenAI-Compatible Plan-IR Endpoint Eval

Use this lane for vLLM, SGLang, hosted OpenAI-compatible SLM endpoints, or RunPod queue workers that wrap OpenAI-compatible payloads. The runner sends the same compact Temporal Plan-IR prompt shape used by the Python prediction scripts, then executes valid output through the TypeScript deterministic executor.

Hosted endpoint experiments must report two latency profiles: submit-only and hotkey-prewarm. The product SLO is that the model is already warm by the time the user finishes typing after opening the overlay, and the visible result usually arrives within 5 seconds. Treat this as an architecture target and measured SLO, not a blanket hard timeout.

```powershell
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://localhost:8000/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-lora"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_API = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT = "json_schema"
$env:TEMPORAL_EVAL_ENDPOINT_EXTRA_BODY = '{"chat_template_kwargs":{"enable_thinking":false}}'
$env:TEMPORAL_EVAL_LIMIT = "5"
npm run eval:temporal
```

Endpoint-specific options:

- `TEMPORAL_EVAL_ENDPOINT_BASE_URL`: endpoint base URL with or without `/v1`.
- `TEMPORAL_EVAL_ENDPOINT_MODEL`: served model or adapter name.
- `TEMPORAL_EVAL_ENDPOINT_API`: `chat` or `completions`, default `chat`.
- `TEMPORAL_EVAL_ENDPOINT_API_KEY`: optional bearer token for hosted endpoints.
- `TEMPORAL_EVAL_ENDPOINT_PROVIDER`: label for reports, default `openai-compatible`.
- `TEMPORAL_EVAL_ENDPOINT_TRANSPORT`: `openai` or `runpod_queue`; defaults to `runpod_queue` for providers containing `runpod-peft` or `runpod-queue`, otherwise `openai`.
- `TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET`: `minimal` or `detailed`, default `minimal`.
- `TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT`: `json_schema`, `structured_outputs_json`, or `none`, default `json_schema`.
- `TEMPORAL_EVAL_ENDPOINT_EXTRA_BODY`: optional JSON object merged into the request body, useful for `chat_template_kwargs`, `top_k`, or backend-specific settings.
- `TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS`, `TEMPORAL_EVAL_ENDPOINT_TEMPERATURE`, and `TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS`: generation and request controls.

RunPod queue workers use the endpoint root as `TEMPORAL_EVAL_ENDPOINT_BASE_URL` and submit jobs to `/runsync`:

```powershell
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "https://api.runpod.ai/v2/<endpoint-id>"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir"
$env:TEMPORAL_EVAL_ENDPOINT_PROVIDER = "runpod-peft-bnb"
$env:TEMPORAL_EVAL_ENDPOINT_TRANSPORT = "runpod_queue"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_API = "completions"
$env:TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT = "none"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = "600000"
npm run eval:temporal
```

For hosted serving comparisons, keep provider-specific notes in `docs/agentic/ingest/hosted-temporal-slm-serving-2026-05-30.md`. Initial candidates are RunPod Serverless Flex plus FlashBoot, Modal Memory Snapshots with scale-to-zero, Baseten autoscaling, Replicate fast-booting fine-tunes if supported, and Hugging Face Inference Endpoints as a simple baseline. Always-warm workers are diagnostic-only under the `$50/month` cap.

The durable setup workflow is `docs/temporal-hosted-model-deployment.md`. Use it before creating paid endpoints or changing defaults.

## Router-IR Dataset Lane

Use this lane to turn executor-backed eval reports into small Router-IR training rows. This is measurement and possible future training scaffolding, not a committed production architecture. The default product candidate remains deterministic preflight plus one Plan-IR model plus executor validation plus strong fallback.

```powershell
$env:TEMPORAL_EVAL_BASELINES = "deterministic"
$env:TEMPORAL_EVAL_OUTPUT = "reports/temporal-ml/temporal-deterministic-eval.json"
npm run eval:temporal

$env:TEMPORAL_ROUTER_EVAL_INPUTS = "reports/temporal-ml/temporal-deterministic-eval.json,reports/temporal-ml/temporal-trained-expanded-bounded-minimal-current-repeat-1-eval.json"
$env:TEMPORAL_ROUTER_OUTPUT = "reports/temporal-ml/temporal-router-ir-rows.jsonl"
npm run ml:temporal:router
```

Router-specific options:

- `TEMPORAL_ROUTER_EVAL_INPUTS`: comma-separated eval JSON reports. Include deterministic and local Plan-IR reports when available.
- `TEMPORAL_ROUTER_OUTPUT`: JSONL output path for Router-IR training rows.
- `TEMPORAL_ROUTER_LOCAL_RUNNERS`: comma-separated local model runner names, defaulting to `trained_plan,endpoint_plan`.
- `TEMPORAL_ROUTER_DETERMINISTIC_RUNNER`: deterministic runner name, defaulting to `deterministic`.

Route labels are derived from pass/fail and status evidence. Stable deterministic passes become `deterministic_only`, stable local Plan-IR passes become `local_plan`, executor-backed clarification outcomes become `clarify`, and failed/mixed/missing local results become `escalate_llm`.

## OpenAI Fine-Tune Export Lane

OpenAI supervised fine-tuning may be unavailable for new users because OpenAI documentation says the platform is being wound down. This lane only prepares a local JSONL file; it does not upload data or create a paid job.

```powershell
$env:TEMPORAL_OPENAI_FINETUNE_INPUT = "reports/temporal-ml/temporal-ir-expanded.jsonl"
$env:TEMPORAL_OPENAI_FINETUNE_OUTPUT = "reports/temporal-ml/temporal-openai-finetune.jsonl"
$env:TEMPORAL_OPENAI_FINETUNE_SPLITS = "train,validation"
npm run ml:temporal:openai-export
```

If fine-tuning access exists, start with `gpt-4.1-nano-2025-04-14` and evaluate the resulting `ft:...` model through the same executor-backed eval lane before drawing conclusions. If access does not exist, run base hosted `gpt-4.1-nano`/mini structured-output evals instead of adding more local architecture.

## Cascade Eval Lane

Use this lane to score product-shaped routing instead of forcing one parser to handle every case. It consumes eval reports plus Router-IR labels or predictions, selects the routed path, and reports known accuracy, assumed escalation accuracy, local accepted precision, escalation rate, clarification rate, wrong-singular risk, and route latency.

```powershell
$env:TEMPORAL_CASCADE_EVAL_INPUTS = "reports/temporal-ml/temporal-deterministic-expanded-eval.json,reports/temporal-ml/temporal-trained-expanded-bounded-minimal-current-repeat-1-eval.json"
$env:TEMPORAL_CASCADE_ROUTER_ROWS = "reports/temporal-ml/temporal-router-ir-current-rows.jsonl"
$env:TEMPORAL_CASCADE_ROUTE_SOURCE = "labels"
$env:TEMPORAL_CASCADE_OUTPUT = "reports/temporal-ml/temporal-cascade-current-eval.json"
npm run eval:temporal:cascade
```

Cascade-specific options:

- `TEMPORAL_CASCADE_EVAL_INPUTS`: comma-separated eval JSON reports for deterministic, local, and optionally strong LLM runners.
- `TEMPORAL_CASCADE_ROUTER_ROWS`: Router-IR label JSONL path for `labels` route source and route-decision accuracy comparisons.
- `TEMPORAL_CASCADE_ROUTER_PREDICTIONS`: Router-IR prediction JSONL path for `predictions` route source.
- `TEMPORAL_CASCADE_ROUTE_SOURCE`: `labels`, `predictions`, or `oracle`. `oracle` derives the best available route from eval evidence.
- `TEMPORAL_CASCADE_ASSUME_MISSING_ESCALATION_PASS`: default `1`; keeps a separate assumed product score when no strong-runner report is available for an escalation.
- `TEMPORAL_CASCADE_LOCAL_RUNNERS`, `TEMPORAL_CASCADE_STRONG_RUNNERS`, and `TEMPORAL_CASCADE_DETERMINISTIC_RUNNER`: runner grouping controls.

Do not confuse assumed escalation accuracy with a measured strong-model result. If escalation is part of the production path, add an `agent` or `single_call` report to `TEMPORAL_CASCADE_EVAL_INPUTS` before making deployment claims.

Diagnostic cases should stay rare and temporary. Once product semantics are chosen, promote them to required evals so regressions fail the matrix instead of hiding in comparison-only output.

Known ambiguity policy checks, such as pasted event text with one explicit date plus multiple explicit times, run as separate graph policies before deterministic short-circuiting. For fuzzy semantic choices like whether `next <weekday>` is materially ambiguous, deterministic code should only route the syntax around short-circuiting; the LLM/Plan-IR layer should interpret and generate alternatives.

## Routing Strategy

- Keep `gpt-5.5` as the production default until cheaper candidates show repeated reliability on required evals. Treat `gpt-5.4-mini` as the leading cost/latency candidate and `gpt-5.4-nano` as experimental until it passes baseline cases.
- Prefer routing by workflow step only after eval data shows a stable split, such as a faster planner model plus a stronger final validator.
- Keep deterministic code focused on calendar arithmetic, validation, and formatting; use model routing for fuzzy interpretation rather than adding phrase tables.
- Optimize time-to-first-use before optimizing total graph sophistication: fewer LLM passes, smaller prompts, smaller tool outputs, and fewer final validation calls matter more than provider abstraction right now.

## Autoresearcher-Style Loop

Karpathy's AutoResearch pattern is a useful north star for parser optimization: define an eval suite, let an agent propose one small change, run the leaderboard, keep the change only if required pass rate holds and latency improves. For this repo, keep that loop constrained to prompt/tool-output/router changes and require the static eval report as the artifact for every accepted experiment.
