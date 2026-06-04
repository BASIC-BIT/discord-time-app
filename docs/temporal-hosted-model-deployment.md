# Temporal Hosted Model Deployment Workflow

## Product Constraints

- The hosted temporal model budget is capped at `$50/month` unless a higher spend is explicitly approved.
- The 5-second visible-result target is a product SLO, not a blanket hard timeout.
- Hotkey press should start model warmup before the user submits text.
- Wrong singular timestamps are worse than clarification, no-plan, or fallback.
- Required evals must pass before changing parser defaults.

For the narrative of how the current working hosted PEFT path was found, see `docs/temporal-hosted-slm-journey.md`.

## Local Readiness

Checked on 2026-05-30:

- Python: `3.12.10`.
- Node: `v24.15.0`.
- npm: `11.12.1`.
- Docker: `28.1.1`, running with NVIDIA runtime available.
- WSL: Ubuntu 24.04, RTX 5090 visible with `32607 MiB` VRAM.
- Hugging Face CLI: installed and authenticated.
- `huggingface_hub`: installed globally for Python `3.12`.
- Modal CLI: not installed.
- RunPod CLI/package: not installed.
- Cog CLI: not installed.
- RunPod browser session: logged in on 2026-05-31; first serverless vLLM endpoint created and tested.

Do not install more global tools until we choose the provider for the next benchmark. Prefer a repo-local or WSL virtualenv for provider CLIs.

## First Provider Bet

Start with RunPod Serverless because it has the best match for this product shape:

- Flex workers can scale to zero and bill only when workers are online.
- FlashBoot can retain worker state after spin-down for faster revival than a fresh boot.
- Cached Models can pre-place Hugging Face model files on hosts and avoid billing while models download.
- Idle timeout can keep the worker warm for normal hotkey bursts without a 24/7 GPU bill.
- vLLM workers are a supported path and expose an OpenAI-compatible API.

Second provider to test if RunPod revival misses the SLO:

- Modal with Memory Snapshots and a short `scaledown_window`.
- Modal GPU Memory Snapshots are alpha, but they are the closest SnapStart-like feature.
- Keep `min_containers=0` under the `$50/month` cap unless a higher budget is approved.

Third provider to investigate:

- Replicate fast-booting fine-tunes, only if our model/base/export qualifies for the fast-boot label.

## Model Candidate Ladder

The current local adapter proves the workflow, not the final model size. If we are using a hosted GPU anyway, test bigger models when the extra size does not materially hurt warm latency or cost.

| Tier | Candidate | Why | Minimum GPU expectation | Notes |
| --- | --- | --- | --- | --- |
| Control | Current Qwen2.5 0.5B LoRA | Already trained and scores `29/30` on the small eval | 16GB easily | Best first deployment-shape test |
| Small quality bump | Qwen3 1.7B | Better capacity while still small | 16GB likely | Force non-thinking mode |
| Primary hosted candidate | Qwen3 4B Instruct | Better instruction following, still reasonable on L4/4090-class GPUs | 16GB quantized or 24GB comfortable | Good first bigger-model fine-tune |
| Bigger if needed | Phi-4-mini 3.8B | Strong 4B-class control | 24GB comfortable | License MIT, verify serving quirks |
| Larger quality test | Qwen 7B/8B quantized | May improve semantic reliability | 24GB with AWQ/GPTQ, 16GB may be tight | Only test after 4B result is known |

Do not pick a bigger model just because the GPU can hold it. The metric is executor-backed pass rate, wrong-singular-answer rate, warm latency, cold/revival latency, and billed seconds per parse.

## Hugging Face Stack

Hugging Face is the artifact source of truth for hosted tests because RunPod Cached Models and most provider runtimes integrate directly with Hugging Face model repos.

Recommended artifact layout:

- Private Hugging Face repo for a merged model when using RunPod Cached Models.
- Private Hugging Face repo for a LoRA adapter when the provider supports dynamic or startup LoRA loading.
- README in each repo with base model, training dataset hash/path, prompt preset, eval result, and intended serving backend.

Current adapter base:

- Adapter path: `ml/temporal-ir/outputs/qwen-temporal-ir-expanded-bounded-minimal-lora`.
- Private Hugging Face repo: https://huggingface.co/sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora
- Base model: `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit`.
- Prompt preset: `minimal`.
- Known small-eval score: `29/30`.

Experimental Qwen3 1.7B adapter:

- Adapter path: `ml/temporal-ir/outputs/qwen3-1p7b-temporal-ir-expanded-minimal-lora`.
- Private Hugging Face repo: https://huggingface.co/sjkneisler/hammer-overlay-temporal-qwen3-1p7b-lora
- Base model: `unsloth/Qwen3-1.7B-unsloth-bnb-4bit`.
- Prompt preset: `minimal`.
- Local training time on RTX 5090: about `4.6` minutes for 3 epochs.
- Small executor-backed eval signal: `28/30`.
- It fixed `chained-day-after-tomorrow-5`, but regressed `bare-hour-clarification` and `direct-epoch-zero`.
- Local prediction latencies were worse than the 0.5B control; hosted vLLM may change absolute latency but not the current accuracy tradeoff.

RunPod Cached Models work best with a Hugging Face-hosted base or merged model. If we deploy adapter-only, the base can be cached and the tiny adapter can be baked into the image or downloaded at startup. If we deploy a merged model, the whole served artifact can be cached as one Hugging Face model.

## Setup Commands

Create a provider tooling venv from WSL:

```bash
python3 -m venv .venv-hosted-models
source .venv-hosted-models/bin/activate
python -m pip install --upgrade pip
pip install -r ml/temporal-ir/requirements-hosted.txt
```

Check Hugging Face auth without printing tokens:

```bash
huggingface-cli whoami
```

If auth is missing:

```bash
huggingface-cli login
```

Do not paste Hugging Face, RunPod, Modal, or Replicate tokens into tracked docs or shell history. Use provider secret stores or ignored local env files.

## RunPod First Experiment

Goal: measure whether parked-on-demand RunPod can be warm by submit time and stay under `$50/month`.

Status on 2026-05-31: first endpoint created and measured.

Current endpoint:

- Endpoint ID: `21gxa0u8btkcc1`.
- Worker: official RunPod Hub `runpod-workers/worker-vllm`, vLLM `v2.19.0`.
- Endpoint type: queue-based serverless endpoint.
- Served model names as of endpoint version `9`: base alias `qwen-base` and LoRA alias `qwen-temporal-ir`.
- Base model: `Qwen/Qwen2.5-0.5B-Instruct`.
- Adapter artifact: private HF LoRA repo `sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora`.
- Historical merged artifact: private HF merged model `sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-merged`.
- GPU: `24 GB` high-supply tier, observed worker `PRO 6000 MIG 24GB`, `$0.00019/s` while running.
- Active workers: `0`.
- Max workers: `1`.
- Idle timeout: `5s`.
- FlashBoot: enabled.
- Execution timeout: `600s`.

Initial merged-model smoke results:

- `/v1/models` through RunPod native wrapper: cold/activation delay `39.23s`, execution `164ms`, model reported `max_model_len=2048`.
- `/v1/chat/completions`: delay `483ms`, execution `76.46s`; avoid for this adapter because it is much slower and less aligned with raw completion-style training.
- `/v1/completions`: delay `328ms`, execution `495ms`; this is the preferred serving mode for the current merged 0.5B adapter.

Executor-backed endpoint eval:

- Command mode: OpenAI-compatible `/openai/v1/completions`, `TEMPORAL_EVAL_ENDPOINT_API=completions`, `TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT=none`, `TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS=192`.
- Output: `api/reports/temporal-ml/temporal-endpoint-runpod-qwen2p5-0p5b-completions-eval.json`.
- Score: `22/30` required cases.
- Latency: median `571ms`, p95 `4130ms` after the endpoint was warm/revivable.
- Main failures: bare-hour clarification, weekday bare-hour clarification malformed JSON, anchor-offset date/clock, epoch zero, weekday fuzzy clock, chained five `day after tomorrow`, and month-name date-time.

Follow-up isolation:

- Local Unsloth inference from the merged artifact scored `27/30` with both `192` and `512` max-new-token caps. Failures were direct Discord timestamp tag drift, epoch-zero malformed JSON, and the known five-chained-day-after miss.
- Product-shaped cascade with deterministic preflight plus local merged predictions scored `29/29` known and `30/30` assumed, with one escalation for the recursive chain.
- Product-shaped cascade with deterministic preflight plus the RunPod endpoint report scored `25/27` known and `26/30` assumed. Remaining hosted local-plan failures were anchor-offset date/clock; clarification routes lacked passing endpoint evidence for bare-hour and weekday fuzzy cases.
- The endpoint eval prompt formatter had drifted from the Python training/inference prompt: TypeScript sent compact JSON without spaces, while Python used `json.dumps(..., sort_keys=True)` with `": "` and `", "` separators. The eval runner now formats endpoint input JSON to match the Python prompt shape.
- Prompt-parity RunPod rerun output: `api/reports/temporal-ml/temporal-endpoint-runpod-qwen2p5-0p5b-completions-prompt-parity-eval.json`. It scored `20/30` standalone. Explicit timestamp/epoch cases improved, but clarification/composition cases regressed, including bare-hour clarification, anchor-offset date/clock, weekday fuzzy clock, weekday-after-next clarification, and event-post clarification. One cold request timed out at `120s`.
- Prompt-parity cascade output: `api/reports/temporal-ml/temporal-cascade-runpod-qwen2p5-merged-prompt-parity-labels-eval.json`. It scored `24/26` known and `25/30` assumed, below the original hosted cascade.
- Constrained decoding smoke tests did not rescue the endpoint: both `TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT=json_schema` and `structured_outputs_json` scored `1/5` on the first five cases.
- A temporary restricted RunPod key named `Temporal endpoint eval rerun` was created for the rerun, used from clipboard without printing, then deleted. The clipboard was overwritten afterwards.

Adapter-only LoRA serving follow-up on 2026-05-31:

- Endpoint was reconfigured to normal base `Qwen/Qwen2.5-0.5B-Instruct` with `ENABLE_LORA=true` and `LORA_MODULES=[{"name":"qwen-temporal-ir","path":"sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora","base_model_name":"Qwen/Qwen2.5-0.5B-Instruct"}]`.
- RunPod initially failed because endpoint-level `MODEL_NAME` still pointed at the old merged artifact while the template env pointed at the base model. Updating the effective endpoint model to the base model fixed startup.
- The adapter repo is private, so `HF_TOKEN` must be present in endpoint env. RunPod edit/save flows can drop or overwrite env rows; verify `LORA_MODULES` and `HF_TOKEN` after every edit.
- `/v1/models` succeeded after config repair and exposed `qwen-base` plus `qwen-temporal-ir`; the LoRA model had `parent=qwen-base` and `root=sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora`.
- Warm `qwen-temporal-ir` `/v1/completions`, minimal prompt, `512` max tokens scored `1/5` on the first five eval cases. `192` max tokens also scored `1/5`.
- Warm `qwen-temporal-ir` `/v1/chat/completions`, minimal prompt, `512` max tokens scored `2/5` on the first five eval cases.
- Warm `qwen-temporal-ir` `/v1/chat/completions`, detailed prompt, `512` max tokens scored `0/5` on the first five eval cases.
- Warm `qwen-base` `/v1/completions`, minimal prompt, `512` max tokens scored `0/5`, showing the adapter is being applied but vLLM LoRA behavior does not match local PEFT adapter inference.
- Downloading the exact private HF adapter repo and scoring it locally with the standard PEFT path, normal `Qwen/Qwen2.5-0.5B-Instruct` base, minimal prompt, and `512` max tokens scored `5/5` on the same first five cases. This rules out a bad HF upload/revision for the smoke failures and isolates the mismatch to hosted vLLM/RunPod serving behavior.
- Endpoint was parked back to zero workers after testing.

QLoRA/BitsAndBytes startup follow-up on 2026-06-01:

- Endpoint was reconfigured for vLLM startup-time QLoRA/BitsAndBytes serving with `MODEL_NAME=Qwen/Qwen2.5-0.5B-Instruct`, `LOAD_FORMAT=bitsandbytes`, `QUANTIZATION=bitsandbytes`, `ENABLE_LORA=true`, `QLORA_ADAPTER_NAME_OR_PATH=sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora`, empty `LORA_MODULES`, and served model override `qwen-temporal-ir`.
- `/v1/models` succeeded after startup and exposed only `qwen-temporal-ir`; the reported root was the cached base-model snapshot, not the adapter repo.
- Warm `qwen-temporal-ir` `/v1/completions`, minimal prompt, `512` max tokens scored `0/5` on the first five eval cases. Output: `api/reports/temporal-ml/temporal-endpoint-runpod-qwen2p5-0p5b-qlora-bnb-completions-limit5-512-eval.json`.
- Warm `qwen-temporal-ir` `/v1/chat/completions`, minimal prompt, `512` max tokens scored `0/5` on the first five eval cases. Output: `api/reports/temporal-ml/temporal-endpoint-runpod-qwen2p5-0p5b-qlora-bnb-chat-limit5-512-eval.json`.
- The chat smoke returned base-like explanatory JSON rather than compact Temporal Plan-IR, so the vLLM QLoRA/BitsAndBytes path still does not match the known-good local PEFT BNB 4-bit inference path.
- The restricted endpoint eval key can read `/health`, `/purge-queue`, and OpenAI-compatible routes, but cannot read RunPod GraphQL endpoint configuration or logs. The browser UI confirmed `Active workers=0`, `Max workers=1`, `Idle timeout=5 seconds`, `0 running workers`, and `$0.00000/s` after testing.

Custom PEFT/Transformers server follow-up on 2026-06-01:

- Added a small stdlib OpenAI-compatible server at `ml/temporal-ir/serve_peft_openai.py`, backed by the shared `ml/temporal-ir/peft_runtime.py` loader. The loader matches the known-good `predict_peft.py` path: adapter tokenizer, normal `Qwen/Qwen2.5-0.5B-Instruct` base, BitsAndBytes NF4 4-bit, BF16 compute, double quantization, eager attention, and PEFT adapter load.
- Local WSL server command used the exact downloaded HF adapter repo at `C:\Users\steve\AppData\Local\Temp\opencode\hf-temporal-qwen-lora`, served as `qwen-temporal-ir` on `localhost:8000`.
- OpenAI-compatible `/v1/completions`, minimal prompt, `512` max tokens scored `5/5` on the first five cases. Output: `api/reports/temporal-ml/temporal-endpoint-local-peft-bnb-completions-limit5-512-eval.json`.
- The full 30-case endpoint eval scored `29/30`, matching the best local PEFT adapter behavior. Output: `api/reports/temporal-ml/temporal-endpoint-local-peft-bnb-completions-full-512-eval.json`.
- The only full-eval failure remained `chained-day-after-tomorrow-5`, which emitted four days instead of five. This is a model quality miss, not a serving-stack mismatch.
- Packaged the same runtime as a RunPod queue worker using `ml/temporal-ir/runpod_worker_peft.py`. The first GHCR image based on `pytorch/pytorch:2.9.1-cuda12.8-cudnn9-runtime` reached RunPod release creation but stayed in `initializing` with no Python logs, likely from uncached multi-GB image pull/startup before `CMD` execution. The endpoint was rolled back to the known-good vLLM image after each failed attempt.
- The deployable image uses RunPod's official PyTorch base and lazy model loading: `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601`, digest `sha256:06976765ee6a5c6e6795681c4e0e3accc3fec2bd4ba9278d7542512fc31d47ca`. It is served on queue endpoint `21gxa0u8btkcc1` as model `qwen-temporal-ir`.
- Queue smoke for `/v1/models` through `/runsync` completed successfully with `delayTime=63735ms`, `executionTime=86ms`, and output model `qwen-temporal-ir`.
- First-five hosted queue eval, completions API, minimal prompt, `512` max tokens scored `5/5`. Output: `api/reports/temporal-ml/temporal-endpoint-runpod-peft-bnb-runpod-base-limit5-512-eval.json`.
- Full 30-case hosted queue eval scored `30/30`. Output: `api/reports/temporal-ml/temporal-endpoint-runpod-peft-bnb-runpod-base-full-512-eval.json`. Warm summary: first-correct median `2722ms`, first-correct p95 `5823ms`, final median `2722ms`, final p95 `5824ms`, with one max-latency outlier at `22931ms` on `weekday-bare-hour-clarification`.

Prewarm and revival benchmark on 2026-06-01:

- Temporarily changed idle timeout from `5s` to `30s` for the benchmark, then restored it to `5s` afterward.
- A 1-token generation prewarm after idle completed in `55.6s` wall time, with `34.4s` queue delay and `20.5s` execution time.
- A real submit immediately after that completed prewarm took `6.2s` wall time, with `0.3s` queue delay and `4.7s` execution time.
- A second submit inside the warm burst window took `6.3s` wall time, with `18ms` queue delay and `4.5s` execution time.
- A submit after waiting beyond the idle window took `156.3s` wall time, with `124.1s` queue delay and `32.1s` execution time.
- If a real submit arrives `5s` after a 1-token hotkey prewarm starts, max workers `1` makes it wait behind the prewarm; the submit completed in `86.5s` wall time.
- A cheaper `/v1/models` hotkey prewarm starts the container but does not load the PEFT model. A submit `5s` later completed in `64.0s` wall time, with `37.9s` queue delay and `25.2s` execution time.

Conclusion: the RunPod serving shape works for accuracy and cost-controlled experiments, but the merged 0.5B artifact, adapter-only vLLM LoRA serving, and startup-time vLLM QLoRA/BitsAndBytes serving are not productionizable for this adapter. Prompt parity, constrained decoding, larger token caps, chat formatting, detailed prompting, dynamic LoRA, and QLoRA startup loading did not fix hosted accuracy. The custom PEFT/Transformers queue worker restores and slightly exceeds local BNB 4-bit adapter quality on the 30-case executor eval. Do not change parser defaults until fallback, spend, rollback, and app-side kill-switch behavior are chosen.

Latency conclusion after the prewarm benchmark: RunPod queue serving is only product-shaped when the worker and model are already warm. A 30-second idle window helps only after a prewarm generation has fully completed before submit. It does not make post-idle hotkey prewarm safe for quick submits, and generation prewarm can actively block the only worker. Do not wire this endpoint into the inline parser path without a measured fallback/timeout policy.

Security note: the RunPod edit modal exposed the Hugging Face token value in browser accessibility output during setup/config edits. Rotate that HF token after testing. The RunPod eval API key `Temporal endpoint eval` was created with restricted read/write access only for endpoint `21gxa0u8btkcc1`; it was used from ignored local env for eval commands, not committed, and intentionally kept for follow-up eval runs.

Recommended endpoint shape:

- Endpoint type: queue-based for the current working custom PEFT worker; load-balancing only if using a plain OpenAI-compatible HTTP server.
- Worker: custom PEFT/Transformers worker for this adapter; keep official RunPod vLLM results as rejected serving-stack evidence.
- GPU: start with a 16GB tier for 0.5B/1.7B/4B quantized tests, then L4/A5000/3090 24GB if 4B/7B needs it.
- Active workers: `0`.
- Max workers: `1` for initial cost control.
- FlashBoot: enabled.
- Cached Model: set to the Hugging Face base or merged model repo.
- Idle timeout: short, then tune upward only if repeated hotkey bursts need it.
- Autoscaling: request-count for short LLM requests.

Run eval against the OpenAI-compatible endpoint:

```powershell
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "https://<provider-endpoint>/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "<served-model-name>"
$env:TEMPORAL_EVAL_ENDPOINT_API_KEY = "<local-only-token>"
$env:TEMPORAL_EVAL_ENDPOINT_PROVIDER = "runpod-vllm"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_API = "completions"
$env:TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT = "none"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "192"
npm --prefix api run eval:temporal
```

Run eval against the current RunPod queue worker:

```powershell
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "https://api.runpod.ai/v2/21gxa0u8btkcc1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir"
$env:TEMPORAL_EVAL_ENDPOINT_API_KEY = "<local-only-token>"
$env:TEMPORAL_EVAL_ENDPOINT_PROVIDER = "runpod-peft-bnb"
$env:TEMPORAL_EVAL_ENDPOINT_TRANSPORT = "runpod_queue"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_API = "completions"
$env:TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT = "none"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = "600000"
npm --prefix api run eval:temporal
```

Measure three profiles separately:

- Warm: run eval immediately after a successful health/prewarm call.
- Revived: wait beyond idle timeout but within a likely FlashBoot revival window, then run eval.
- Cold: wait long enough that the provider likely has no useful retained state, then run eval.

## Modal Second Experiment

Use Modal only after RunPod has a measured limitation or if we specifically want to test memory snapshots.

Recommended Modal shape:

- Use vLLM OpenAI-compatible server.
- Use Modal Volumes for Hugging Face and vLLM caches.
- Use `scaledown_window` for a short hotkey burst window.
- Use `enable_memory_snapshot=True`.
- Consider GPU Memory Snapshots only as an experiment because they are alpha.
- Keep `min_containers=0` under the default budget.

Modal docs note that Memory Snapshots help with initialization-heavy work such as imports, JIT compilation, and warmup. They do not directly make weight reads from storage faster, so cached weights and model size still matter.

## Cost Controls

Before enabling hosted prewarm in the app:

- Set provider spend limits or alerts.
- Set max workers to `1` for the first benchmark.
- Add a local kill switch for hosted model prewarm.
- Log billed-session estimates in eval reports where provider data is available.
- Keep deterministic and strong LLM fallback paths available.

Cost estimate rule:

```text
monthly_cost = billed_seconds_per_session * sessions_per_month * provider_rate_per_second
```

Example at RunPod L4/A5000/3090 Flex rate `$0.00019/sec`:

- `10s` billed/session and `1,000` sessions/month is about `$1.90/month`.
- `30s` billed/session and `1,000` sessions/month is about `$5.70/month`.
- `60s` billed/session and `1,000` sessions/month is about `$11.40/month`.
- `300s` billed/session and `1,000` sessions/month is about `$57/month`.

The `$50/month` budget can tolerate parked-on-demand serving, but not 24/7 warm GPU.

## Done Definition

A hosted model path is worth productizing only when it has:

- Required eval pass rate at or above the current production path.
- No wrong singular answers on required evals.
- Warm p95 near or under the 5-second product SLO.
- Revived/cold behavior that is either near the SLO or masked by a measured safe fallback path.
- Estimated monthly spend below `$50/month` for expected usage.
- Simpler or equal operational complexity compared with keeping the local desktop model path.

## Links

- RunPod vLLM overview: https://docs.runpod.io/serverless/vllm/overview
- RunPod Cached Models: https://docs.runpod.io/serverless/endpoints/model-caching
- RunPod Hugging Face models: https://docs.runpod.io/serverless/development/huggingface-models
- Modal Memory Snapshots: https://modal.com/docs/guide/memory-snapshots
- Modal vLLM inference: https://modal.com/docs/examples/vllm_inference
- Modal vLLM snapshot example: https://modal.com/docs/examples/vllm_snapshot
- Endpoint eval docs: `docs/temporal-evals.md`
- Hosted SLM journey: `docs/temporal-hosted-slm-journey.md`
- Hosted serving research ingest: `docs/agentic/ingest/hosted-temporal-slm-serving-2026-05-30.md`
