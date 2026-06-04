# Temporal Text-To-IR Training Spike

Goal: fine-tune a small model that maps user temporal text to HammerOverlay Temporal Plan-IR JSON. The model does not calculate timestamps directly; generated IR must still pass schema validation and deterministic execution.

## Hardware

Local preflight has confirmed:

- Windows `nvidia-smi`: NVIDIA GeForce RTX 5090, 32 GB VRAM.
- WSL `nvidia-smi`: GPU visible from Ubuntu 24.04.

Use WSL for Unsloth unless a future Windows-native path proves smoother.

## Dataset

From repo root on Windows or WSL:

```bash
npm --prefix api run ml:temporal:synthetic
```

Optional LLM paraphrase expansion:

```bash
TEMPORAL_IR_PARAPHRASES_PER_ROW=4 npm --prefix api run ml:temporal:paraphrase
```

Dry-run without API calls:

```bash
TEMPORAL_IR_PARAPHRASE_DRY_RUN=1 npm --prefix api run ml:temporal:paraphrase
```

Default outputs:

- `api/reports/temporal-ml/temporal-ir-seeds.jsonl`
- `api/reports/temporal-ml/temporal-ir-expanded.jsonl`

`reports/` is ignored by git, so copy important experiment artifacts elsewhere before cleaning.

The seed generator includes weekday typo examples for the local SLM, especially abbreviated weekday forms with missing or extra letters such as `tu`, `tuee`, `wedn`, `thrs`, `frii`, and `satdy`. These train the model to emit a normalized weekday query for deterministic execution rather than adding broad typo lookup tables to app code.

## WSL Setup

From WSL at the repo path:

```bash
python3 -m venv .venv-temporal-ir
source .venv-temporal-ir/bin/activate
python -m pip install --upgrade pip
pip install -r ml/temporal-ir/requirements-unsloth.txt
```

If PyTorch/CUDA install fails on the 5090, install the current PyTorch build recommended by PyTorch/Unsloth for the detected CUDA stack, then rerun the requirements install. Do not commit the virtualenv.

## Train

```bash
source .venv-temporal-ir/bin/activate
python ml/temporal-ir/train_unsloth.py \
  --dataset api/reports/temporal-ml/temporal-ir-expanded.jsonl \
  --output ml/temporal-ir/outputs/qwen-temporal-ir-lora \
  --epochs 3
```

Training validates the tagged train-split mix before importing the GPU stack. The default target is documented in `docs/temporal-permutation-data-strategy.md`: enough standard rows to keep the model grounded, plus bounded messy, ambiguity, and hard-boundary buckets. Run only the guard with `--check-mix-only`. For tiny debugging subsets only, bypass it with `--skip-mix-check` or `TEMPORAL_IR_SKIP_MIX_CHECK=1`.

Training and prediction both default to the `detailed` instruction preset. To test whether behavior comes from fine-tuning or from inference-time steering, hold the adapter fixed and rerun predictions with different presets:

```bash
python ml/temporal-ir/predict_unsloth.py \
  --model ml/temporal-ir/outputs/qwen-temporal-ir-lora \
  --input api/reports/temporal-ml/temporal-eval-expanded-input.jsonl \
  --output api/reports/temporal-ml/temporal-eval-qwen-detailed.jsonl \
  --instruction-preset detailed

python ml/temporal-ir/predict_unsloth.py \
  --model ml/temporal-ir/outputs/qwen-temporal-ir-lora \
  --input api/reports/temporal-ml/temporal-eval-expanded-input.jsonl \
  --output api/reports/temporal-ml/temporal-eval-qwen-minimal.jsonl \
  --instruction-preset minimal
```

Prediction rows include `instructionPreset`; when scoring, set `TEMPORAL_EVAL_TRAINED_PLAN_MODEL` to a label that includes the adapter and prompt preset so summaries stay separated.

```bash
TEMPORAL_EVAL_BASELINES=trained-plan \
TEMPORAL_EVAL_TRAINED_PLAN_MODEL=qwen-temporal-ir-lora-detailed \
TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS=api/reports/temporal-ml/temporal-eval-qwen-detailed.jsonl \
npm --prefix api run eval:temporal

TEMPORAL_EVAL_BASELINES=trained-plan \
TEMPORAL_EVAL_TRAINED_PLAN_MODEL=qwen-temporal-ir-lora-minimal \
TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS=api/reports/temporal-ml/temporal-eval-qwen-minimal.jsonl \
npm --prefix api run eval:temporal
```

Latest prompt ablation on the 30-case executor-backed eval. This is a single-run, tiny-sample signal, not a conclusion. Treat it as a reason to keep both same-prompt paths alive until a larger ablation covers more seeds, model families, dataset variants, and holdout cases.

| Training preset | Inference preset | Required accuracy | Main failures |
| --- | --- | ---: | --- |
| detailed | detailed | 28/30 | epoch zero; D/M/Y slash date |
| detailed | minimal | 0/30 | malformed/schema-invalid JSON |
| minimal | minimal | 29/30 | five chained `day after` modifiers |
| minimal | detailed | 18/30 | prompt mismatch; malformed direct timestamp/epoch outputs |

Current evidence only shows that prompt/training mismatch can be catastrophic and that short-instruction training can work on this small suite. Keep `minimal`+`minimal` and `detailed`+`detailed` as active experiment paths; do not infer from this run alone that short prompts are generally superior.

## Router-IR

Router-IR is measurement scaffolding unless evals prove it earns a production slot. Do not add a second generative model just to decide whether to call the Plan-IR model unless it materially reduces latency, cost, or wrong-answer risk on a larger holdout.

Router-IR is a separate small target for deciding whether an input should use deterministic parsing, the local Plan-IR model, a clarification path, or a stronger LLM. Build rows from executor-backed eval reports:

```bash
TEMPORAL_EVAL_BASELINES=deterministic \
TEMPORAL_EVAL_OUTPUT=reports/temporal-ml/temporal-deterministic-expanded-eval.json \
npm --prefix api run eval:temporal

TEMPORAL_ROUTER_EVAL_INPUTS=reports/temporal-ml/temporal-deterministic-expanded-eval.json,reports/temporal-ml/temporal-trained-expanded-bounded-minimal-current-repeat-1-eval.json \
TEMPORAL_ROUTER_OUTPUT=reports/temporal-ml/temporal-router-ir-current-rows.jsonl \
npm --prefix api run ml:temporal:router
```

Train and predict a router adapter from WSL:

```bash
source .venv-temporal-ir/bin/activate
python ml/temporal-ir/train_router_unsloth.py \
  --dataset api/reports/temporal-ml/temporal-router-ir-current-rows.jsonl \
  --output ml/temporal-ir/outputs/qwen-temporal-router-ir-lora \
  --epochs 3

python ml/temporal-ir/predict_router_unsloth.py \
  --model ml/temporal-ir/outputs/qwen-temporal-router-ir-lora \
  --input api/reports/temporal-ml/temporal-router-ir-current-rows.jsonl \
  --output api/reports/temporal-ml/temporal-router-ir-predictions.jsonl
```

Do not treat router accuracy alone as the production metric. Report risk/coverage: accepted local/deterministic answers must have very high precision, while uncertain cases should intentionally become `clarify` or `escalate_llm`.

## OpenAI Fine-Tune Export

OpenAI supervised fine-tuning may be unavailable for new users. This export only prepares local JSONL in OpenAI chat fine-tuning format; upload/create jobs manually only after confirming access and cost.

```bash
npm --prefix api run ml:temporal:openai-export
```

Defaults:

- Input: `api/reports/temporal-ml/temporal-ir-expanded.jsonl`
- Output: `api/reports/temporal-ml/temporal-openai-finetune.jsonl`
- Splits: `train,validation`

Use env vars to override:

```bash
TEMPORAL_OPENAI_FINETUNE_INPUT=reports/temporal-ml/temporal-ir-expanded.jsonl \
TEMPORAL_OPENAI_FINETUNE_OUTPUT=reports/temporal-ml/temporal-openai-finetune.jsonl \
TEMPORAL_OPENAI_FINETUNE_SPLITS=train,validation \
npm --prefix api run ml:temporal:openai-export
```

If access exists, test `gpt-4.1-nano-2025-04-14` first. If unavailable, compare prompt-only hosted `gpt-4.1-nano`/mini with structured outputs before adding more local model-serving complexity.

## Release Backlog

Release-grade packaging, benchmark, demo API, and architecture documentation work is bucketed in `docs/temporal-slm-release-backlog.md` so it can be split into a few GitHub issues when ready.

Optional W&B dashboard:

```bash
export WANDB_PROJECT=hammer-overlay-temporal-ir
python ml/temporal-ir/train_unsloth.py --dataset api/reports/temporal-ml/temporal-ir-expanded.jsonl
```

## Metrics And Graphs

Training loss/eval loss are emitted by Hugging Face Trainer and optionally W&B.

Generate local PNGs from a run directory:

```bash
python ml/temporal-ir/plot_training_metrics.py ml/temporal-ir/outputs/qwen-temporal-ir-lora
```

For prediction JSONL files shaped as `{"id":"...","expected":{...},"predicted":"...json..."}`, compute lightweight JSON metrics:

```bash
python ml/temporal-ir/evaluate_json_outputs.py predictions.jsonl --output metrics.json
python ml/temporal-ir/plot_training_metrics.py ml/temporal-ir/outputs/qwen-temporal-ir-lora --metrics metrics.json
```

These metrics are only the first layer. The real production metric is execution-equivalent accuracy through the TypeScript Plan-IR executor.

## Merge For Hosted Serving

Some hosted vLLM flows can serve LoRA adapters directly, but provider UIs may not expose all required env vars. To create a self-contained HF model artifact from the current 0.5B control adapter:

```bash
source .venv-temporal-ir/bin/activate
python ml/temporal-ir/merge_unsloth_lora.py \
  --adapter ml/temporal-ir/outputs/qwen-temporal-ir-expanded-bounded-minimal-lora \
  --output ml/temporal-ir/outputs/qwen-temporal-ir-expanded-bounded-minimal-merged \
  --hub-repo sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-merged \
  --private
```

The merged model is easier to serve as `MODEL_NAME=<repo>` but must still pass endpoint-backed executor evals. The first RunPod merged-model result scored `22/30`; local Unsloth inference from the same merged artifact scored `27/30`, and deterministic-first cascade recovered the local merged path to `29/29` known, `30/30` assumed. A prompt-parity hosted rerun scored `20/30`, and constrained decoding smoke tests scored `1/5`, so this merged 0.5B RunPod endpoint is not productionizable. Adapter-only RunPod vLLM LoRA serving starts successfully and exposes the adapter model, but scored only `1/5` on warm completions and `2/5` on warm chat for the first five eval cases. Downloading the exact private HF adapter repo and scoring it locally with standard PEFT BNB 4-bit scored `5/5` on the same first five cases, while unquantized PEFT failed at `1/5`, so the HF artifact is good and the mismatch is in hosted vLLM/RunPod serving behavior. Startup-time vLLM QLoRA/BitsAndBytes serving exposed only `qwen-temporal-ir` but scored `0/5` for both warm completions and warm chat on the first five cases. A custom stdlib OpenAI-compatible PEFT/Transformers server that shares the `predict_peft.py` BNB 4-bit load path scored `5/5` on the first five endpoint cases and `29/30` on the full endpoint eval, with only the known chained-day-after-tomorrow miss. Do not treat this as hosted parity until the custom server is packaged and measured on scale-to-zero infrastructure.

## Endpoint Eval

For production-shaped local serving tests, run a vLLM/SGLang/hosted OpenAI-compatible endpoint and score it directly through the TypeScript executor:

```bash
TEMPORAL_EVAL_BASELINES=endpoint-plan \
TEMPORAL_EVAL_ENDPOINT_BASE_URL=http://localhost:8000/v1 \
TEMPORAL_EVAL_ENDPOINT_MODEL=qwen-temporal-ir-lora \
TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET=minimal \
TEMPORAL_EVAL_ENDPOINT_API=completions \
TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT=none \
npm --prefix api run eval:temporal
```

For the current 0.5B QLoRA adapter, vLLM did not preserve local PEFT quality. Use the custom PEFT/Transformers server for the next hosted path:

```bash
source .venv-temporal-ir/bin/activate
python ml/temporal-ir/serve_peft_openai.py \
  --adapter /mnt/c/Users/steve/AppData/Local/Temp/opencode/hf-temporal-qwen-lora \
  --host 0.0.0.0 \
  --port 8000 \
  --model-name qwen-temporal-ir
```

For hosted containers, `--adapter` may be a Hugging Face repo ID such as `sjkneisler/hammer-overlay-temporal-qwen2p5-0p5b-lora` when `HF_TOKEN` is present in the environment. The RunPod queue worker uses the same runtime through `ml/temporal-ir/runpod_worker_peft.py`.

## Local Overlay Wiring

The HammerOverlay API sidecar can call the local PEFT server for Plan-IR generation while keeping deterministic parsing as the first pass. Simple deterministic parses still return immediately; the SLM is used only when the graph does not safely short-circuit.

Start the canonical local PEFT server from Windows PowerShell:

```powershell
.\scripts\start-temporal-peft-server.ps1
```

Enable the API sidecar with ignored local env values in `api/.env`:

```text
TEMPORAL_FEATURE_PLAN_IR=true
TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL=http://127.0.0.1:8765/v1
TEMPORAL_PLAN_IR_ENDPOINT_MODEL=qwen-temporal-ir-qwen35-bf16-chat-noisy-input-2584
TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET=minimal
TEMPORAL_PLAN_IR_ENDPOINT_API=chat
TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT=chat
TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS=512
TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS=15000
```

For the local desktop app, persist the env-file and source-sidecar paths at the Windows user-env level so release/autostart launches do not depend on the current working directory:

```powershell
[Environment]::SetEnvironmentVariable("HAMMEROVERLAY_API_ENV", "D:\bench\discord-time-app-src\api\.env", "User")
[Environment]::SetEnvironmentVariable("HAMMEROVERLAY_API_ENTRYPOINT", "D:\bench\discord-time-app-src\api\dist\index.js", "User")
[Environment]::SetEnvironmentVariable("HAMMEROVERLAY_NODE", "C:\ProgramData\nvm\v24.15.0\node.exe", "User")
```

To keep the local SLM server available after login, use `scripts/start-temporal-peft-server.ps1`. If Windows Scheduled Tasks cannot be registered without elevation, place a shortcut in the user Startup folder that runs:

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\bench\discord-time-app-src\scripts\start-temporal-peft-server.ps1"
```

After rebuilding the API sidecar, restart the parser service or HammerOverlay so the running sidecar picks up the new `dist` files and environment. Confirm with `/health`: `TEMPORAL_FEATURE_PLAN_IR` should be `true`, `TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL` should point at `127.0.0.1:8765/v1`, `TEMPORAL_PLAN_IR_ENDPOINT_API` and `TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT` should both be `chat`, and `OPENAI_API_KEY` can be `not configured` for a local-only test.

Then evaluate it as an OpenAI-compatible chat endpoint:

```powershell
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://127.0.0.1:8765/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-qwen35-bf16-chat-noisy-input-2584"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_API = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = "60000"
npm --prefix api run eval:temporal
```

Use `TEMPORAL_EVAL_ENDPOINT_EXTRA_BODY` for backend-specific options, for example `{"chat_template_kwargs":{"enable_thinking":false}}` when testing Qwen3 non-thinking mode through vLLM or SGLang. For raw completion-style adapters, prefer `TEMPORAL_EVAL_ENDPOINT_API=completions`; use chat only when the model was trained and measured with chat formatting.

The current hosted RunPod queue worker is evaluated with `TEMPORAL_EVAL_ENDPOINT_TRANSPORT=runpod_queue` and `TEMPORAL_EVAL_ENDPOINT_BASE_URL=https://api.runpod.ai/v2/<endpoint-id>`. The working image tag is `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601`, built from RunPod's PyTorch CUDA base to avoid uncached PyTorch image pulls. On 2026-06-01 it scored `30/30` on the full endpoint eval at `512` max tokens with completions/minimal prompt.

Endpoint prompts must stay byte-shape-compatible with `temporal_ir_prompts.py`: same instruction text and Python-style sorted input JSON formatting. Small LoRA adapters are sensitive to prompt serialization drift.

Model quality should be judged by executor-backed eval accuracy, schema/parse failure rate, wrong-singular-answer rate, and latency. Training loss and raw JSON validity are only supporting signals.

## Hosted Deployment

The durable hosted workflow is `docs/temporal-hosted-model-deployment.md`. Start there before creating paid resources.

Provider tooling can be installed into a separate WSL venv:

```bash
python3 -m venv .venv-hosted-models
source .venv-hosted-models/bin/activate
python -m pip install --upgrade pip
pip install -r ml/temporal-ir/requirements-hosted.txt
```

Use `ml/temporal-ir/hosted-endpoint.env.example` as the shape for local endpoint eval settings. Never commit real provider tokens.
