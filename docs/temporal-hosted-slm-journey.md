# Temporal Hosted SLM Journey

This document records the story behind the hosted Temporal Plan-IR SLM work from 2026-05-30 through 2026-06-01. It is intentionally narrative. The operational deployment details live in `docs/temporal-hosted-model-deployment.md`, and the eval runner details live in `docs/temporal-evals.md`.

## Product Frame

The goal was not to make a model calculate timestamps directly. The safer product shape is:

- A small language model emits compact Temporal Plan-IR JSON.
- The deterministic executor calculates timestamps and applies validation.
- Wrong singular timestamp answers are worse than clarification, no-plan, or fallback.
- Hosted serving must stay inside the `$50/month` default budget.
- The 5-second visible-result target is a product SLO, not a blind request timeout.
- Parser defaults must not change until endpoint-backed evals pass.

This framing drove almost every technical decision. We optimized for measured executor-backed correctness before latency polish or app integration.

## Stage 1: Build The Plan-IR Evaluation Ground

The first useful step was to stop judging model output by whether it looked like JSON. The model needed to produce a plan that executed to the right product behavior.

We added or expanded:

- `api/src/temporal/plan-ir.ts` for Plan-IR schemas and parsing.
- `api/src/temporal/graph.ts` for executing model plans through deterministic tools.
- `api/scripts/temporal-model-eval.ts` for comparing deterministic, trained-plan, endpoint-plan, and model baselines.
- A 30-case temporal eval suite covering direct timestamps, epoch formats, ambiguous weekdays, fuzzy clocks, slash dates, holiday/year handling, event text, and recursive relative phrases.

This was the first important lesson: the production metric is execution-equivalent accuracy, not raw JSON validity.

## Stage 2: Train Local SLM Candidates

The control adapter was a Qwen2.5 0.5B LoRA trained to emit compact Temporal Plan-IR with the `minimal` instruction preset.

Best local candidate:

- Adapter path: `ml/temporal-ir/outputs/qwen-temporal-ir-expanded-bounded-minimal-lora`.
- Hugging Face repo: `sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora`.
- Local PEFT/BitsAndBytes score: `29/30`.
- Known failure: `chained-day-after-tomorrow-5` emitted a four-day shift instead of five.

We also trained a Qwen3 1.7B adapter:

- Adapter path: `ml/temporal-ir/outputs/qwen3-1p7b-temporal-ir-expanded-minimal-lora`.
- Hugging Face repo: `sjkneisler/hammer-overlay-temporal-qwen3-1p7b-lora`.
- Score: `28/30`.
- It fixed the recursive day-after case but regressed other required cases.

The 0.5B adapter remained the hosted-serving control because it had the best measured local behavior and the smallest likely cold-start footprint.

## Stage 3: Try Standard Hosted vLLM Paths

RunPod Serverless was the first provider bet because it supports scale-to-zero, FlashBoot, short idle windows, and GPU workers without committing to 24/7 spend.

We tried multiple official vLLM serving shapes:

- Merged model artifact.
- Prompt parity with the Python training/inference prompt.
- JSON schema and structured-output constraints.
- Dynamic LoRA serving.
- Chat and completions APIs.
- Startup-time QLoRA/BitsAndBytes loading.

None preserved the local adapter quality:

- Merged model endpoint scored about `20-22/30`.
- Dynamic LoRA scored `1/5` to `2/5` on first-five smoke runs.
- Startup QLoRA/BitsAndBytes scored `0/5` for both completions and chat first-five runs.
- Constrained decoding did not rescue the endpoint.

The critical isolation step was downloading the exact private Hugging Face adapter repo and testing it locally with standard PEFT plus BitsAndBytes. That scored `5/5` on the same first-five cases. The adapter upload was good; the mismatch was in the serving stack.

Decision: reject the vLLM paths for this adapter. Do not productize them or change parser defaults based on them.

## Stage 4: Build A Known-Good PEFT Runtime

We then built a custom serving path that matched local inference instead of trying to coerce vLLM:

- `ml/temporal-ir/peft_runtime.py` shared the known-good PEFT/BitsAndBytes load path.
- `ml/temporal-ir/predict_peft.py` was refactored onto that runtime.
- `ml/temporal-ir/serve_peft_openai.py` exposed a small OpenAI-compatible HTTP server for local endpoint-shaped tests.

The runtime uses:

- Adapter tokenizer.
- Normal `Qwen/Qwen2.5-0.5B-Instruct` base.
- BitsAndBytes NF4 4-bit loading.
- BF16 compute.
- Double quantization.
- Eager attention.
- PEFT adapter load.

Local endpoint eval results:

- First-five: `5/5`.
- Full 30-case eval: `29/30`.
- The only miss remained the known recursive day-after case.

This proved a custom PEFT/Transformers server could restore local adapter quality through an endpoint-shaped interface.

## Stage 5: Package For RunPod Queue Serving

The first container attempt packaged the local OpenAI-compatible HTTP server. That was the wrong endpoint contract for the existing RunPod endpoint, which is queue-based. A queue-based endpoint needs a `runpod.serverless.start(...)` handler and receives jobs through `/run` or `/runsync`.

We added:

- `ml/temporal-ir/runpod_worker_peft.py` for the RunPod queue worker.
- `ml/temporal-ir/Dockerfile.peft-server` for the image.
- `ml/temporal-ir/requirements-peft-server.txt` for runtime dependencies.
- `.dockerignore` to keep reports, venvs, model outputs, and caches out of the image context.

We also updated the TypeScript eval runner to support queue transport:

- `TEMPORAL_EVAL_ENDPOINT_TRANSPORT=runpod_queue`.
- The runner wraps OpenAI-compatible payloads in RunPod `/runsync` jobs.
- The worker unwraps `openai_route` and `openai_input`, then returns OpenAI-compatible response bodies.

## Stage 6: Diagnose The Stuck `initializing` Images

Two custom images reached RunPod releases but stayed stuck in `initializing` with no Python startup logs:

- `temporal-peft-bnb-runpod-20260601`.
- `temporal-peft-bnb-runpod-lazy-20260601`.

We made the worker lazy-load the model after startup so RunPod could mark the handler ready before model download/load. That was the right code change, but it did not fix the stuck startup. There were still no Python logs, including the early startup print.

We checked:

- The endpoint had no start-command override.
- The image `CMD` was correct.
- The image started locally.
- GHCR was anonymously readable.
- The queue was clear and rollback to the official vLLM image worked.

The remaining likely issue was image pull/startup behavior: the custom image was based on a generic multi-GB PyTorch image that RunPod hosts were unlikely to have cached.

## Stage 7: Use RunPod's PyTorch Base

The working fix was to build the custom worker from RunPod's official PyTorch/CUDA base image:

```dockerfile
ARG TEMPORAL_IR_BASE_IMAGE=runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404
FROM ${TEMPORAL_IR_BASE_IMAGE}
```

We also stopped forcing a Docker-side `torch==2.9.1` reinstall and used the base image's CUDA-compatible PyTorch stack.

Working image:

- Tag: `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601`.
- Digest: `sha256:06976765ee6a5c6e6795681c4e0e3accc3fec2bd4ba9278d7542512fc31d47ca`.
- Endpoint: `21gxa0u8btkcc1`.
- Served model name: `qwen-temporal-ir`.

The image rolled out immediately and became the active ready configuration.

## Final Hosted Eval Result

Queue smoke:

- `/v1/models` through `/runsync` completed successfully.
- Reported model: `qwen-temporal-ir`.
- Observed cold/activation delay for that smoke: `63735ms` delay, `86ms` execution.

First-five endpoint eval:

- Transport: `runpod_queue`.
- API: completions.
- Prompt preset: `minimal`.
- Max tokens: `512`.
- Score: `5/5`.
- Report: `api/reports/temporal-ml/temporal-endpoint-runpod-peft-bnb-runpod-base-limit5-512-eval.json`.

Full endpoint eval:

- Score: `30/30`.
- First-correct median: `2722ms`.
- First-correct p95: `5823ms`.
- Final median: `2722ms`.
- Final p95: `5824ms`.
- One outlier: `22931ms` on `weekday-bare-hour-clarification`.
- Report: `api/reports/temporal-ml/temporal-endpoint-runpod-peft-bnb-runpod-base-full-512-eval.json`.

The endpoint was left on the working custom PEFT image with cost controls still in place: max workers `1`, active workers `0`, short idle timeout, and a clear queue.

## Prewarm Benchmark Result

We then tested the product-shaped question: can hotkey prewarm make a scale-to-zero RunPod worker ready before the user submits text?

The benchmark temporarily changed the endpoint idle timeout from `5s` to `30s`, then restored it to `5s` afterward.

Measured results:

- A 1-token generation prewarm after idle took `55.6s` wall time.
- A real submit immediately after that completed prewarm took `6.2s` wall time.
- A second submit inside the same warm burst window took `6.3s` wall time.
- A submit after waiting beyond the idle window took `156.3s` wall time.
- If the user submits `5s` after the 1-token prewarm starts, the submit waits behind the prewarm and took `86.5s` wall time.
- A `/v1/models` prewarm avoids generation but does not load the PEFT model; a submit `5s` later still took `64.0s` wall time.

Decision: keep the custom PEFT worker as the accuracy-proven hosted candidate, but do not wire the current RunPod queue endpoint into the inline parser path. It needs either a different serving architecture, a stronger fallback/timeout policy, or a product path where hosted SLM work is explicitly background/asynchronous.

## Decisions Captured

- Keep Plan-IR as the model output target; do not ask the SLM to emit final timestamps directly.
- Treat the deterministic executor as authoritative for timestamp arithmetic and validation.
- Reject the current vLLM merged, dynamic LoRA, and startup QLoRA paths for this adapter.
- Use the custom PEFT/Transformers RunPod queue worker as the current viable hosted path.
- Use RunPod's official PyTorch base for custom serverless images to avoid uncached generic PyTorch image startup stalls.
- Do not integrate the current RunPod queue path into the inline app parser; hotkey prewarm misses the 5-second product SLO after idle.

## Lessons Learned

- Executor-backed evals catch failures that JSON validity and schema conformance miss.
- Prompt serialization drift can change small-adapter behavior materially.
- A bad hosted result does not prove a bad adapter; test the exact HF artifact locally with the intended runtime before retraining.
- vLLM LoRA/QLoRA behavior can diverge enough from PEFT/BitsAndBytes to invalidate a small adapter.
- Queue-based and HTTP/load-balanced endpoints need different serving contracts and different eval transports.
- For serverless GPU workers, image base choice and provider-side layer caching can decide whether code runs at all.
- Rollback hygiene matters: after each stuck deployment, the endpoint was restored to a healthy known-good image before continuing.
- Hotkey prewarm only works if it finishes before submit. With max workers `1`, generation prewarm can block the real parse request.
- Container-only prewarm is insufficient when the model is lazy-loaded on first generation.

## Remaining Productization Work

Before changing parser defaults or wiring this into the overlay runtime:

- Decide whether to test a different serving architecture for lower warm and revived latency, such as direct HTTP/load-balanced serving, Modal snapshots, or an explicit model-load warmup path.
- Measure truly cold latency after enough time for FlashBoot/cache state to decay only if RunPod remains the candidate.
- Estimate billed seconds per realistic session and confirm the `$50/month` cap still holds.
- Decide the fallback behavior for slow or failed hosted attempts.
- Add app-side kill switch and logging before any real-user path depends on the hosted worker.
- Rotate the Hugging Face token that was exposed by the RunPod edit UI during setup.
