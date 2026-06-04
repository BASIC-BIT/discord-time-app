# Temporal Model Upgrade Experiment

This workstream compares model families without changing runtime semantics or hiding SLM misses with deterministic patches.

## Baseline

Current promoted adapter:

- Adapter: `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-month-clock-lora`
- Base: `Qwen/Qwen3.5-0.8B`
- Required gate: `136/136` promoted endpoint. The adapter's last offline/staged retrain gate was `132/132`; the newest bare-minute AM/PM ambiguity canaries were fixed in deterministic clarification policy before Plan-IR finalization.
- Dataset note: current generated expanded dataset is `2584` rows with splits `2049/271/264`; the promoted adapter itself was trained on the prior `2564`-row month-clock dataset. The current non-blocking diagnostic miss is `first of Febuarysdf 2:30`, which should become AM/PM clarification after the next SLM retrain. The next dataset now includes bounded noisy-human-input rows for typo variants, suffix junk, spacing/run-together damage, repeated/missing/transposed letters, keyboard-adjacent substitutions, and negative epoch-like rejection reinforcement.
- Prompt preset: `minimal`; endpoint API/prompt format: `chat`/`chat`.

Any upgraded model must beat or materially complement this baseline on accuracy, latency, cost, or robustness. The prior v4h Qwen2.5 0.5B adapter remains the rollback baseline.

## Candidate Order

1. `Qwen/Qwen3.5-2B`
2. `Qwen/Qwen3.5-0.8B` only if latency/memory pressure dominates.
3. `Qwen/Qwen3.5-4B` if 2B still produces wrong executable IR.
4. `Qwen/Qwen3.5-9B` as quality ceiling or hosted-only candidate.

## Compatibility Scout

Run this before training any Qwen3.5 adapter:

- Load the base model in a disposable or deliberately updated WSL environment.
- Confirm text-only generation works for compact JSON output.
- Inspect module names because Qwen3.5 uses a hybrid architecture and the current LoRA target modules may not match all useful layers.
- Confirm the tokenizer/chat template does not emit thinking content for the intended parser prompt.
- For 4B/9B, explicitly disable thinking content before scoring.
- Record VRAM load, first response latency, and any framework version changes.
- If Qwen3.5 falls back to the torch implementation because `flash-linear-attention` or `causal-conv1d` are missing, run only a tiny training smoke and estimate full runtime before launching detached training. Do not start a multi-hour or multi-day GPU run just because the model loads.
- If Docker Desktop detached runs hang or return engine `500` errors, restart Docker Desktop and verify detached mode with a short `sleep` container before launching training. The container launcher uses native detached Docker mode and writes logs under ignored `api/reports/temporal-ml/`.

## Training Protocol

- Use the same expanded dataset and `minimal` preset unless the experiment is explicitly a prompt ablation.
- Use `scripts/start-temporal-ir-training.ps1` so training runs detached.
- For Qwen3.5 hybrid models that need CUDA extension builds, prefer the uv-managed CUDA devel container lane over mutating the known-good WSL venv. Build with `docker build -f docker/temporal-ir-qwen35.Dockerfile -t hammer-overlay-temporal-ir-qwen35:cuda12.8 .`, then launch with `powershell -ExecutionPolicy Bypass -File scripts\start-temporal-ir-training-container.ps1 -AdapterName "<adapter-name>" -BuildImage`.
- The container lane uses root `pyproject.toml`/`uv.lock`, the CUDA 12.8 devel image, and Docker named cache volumes for Hugging Face and uv caches. It compiles `causal-conv1d` and `flash-linear-attention` with `--no-build-isolation` against the image's torch/CUDA stack.
- Keep first-run hyperparameters boring: 3 epochs, batch 2, grad accum 4, LR `2e-4`, then adjust only if the first run fails for a clear training reason.
- Do not promote based on offline predictions alone.
- Bf16/chat-template experiment knobs: use `scripts/start-temporal-ir-training-container.ps1 -PromptFormat chat -NoLoadIn4Bit`. This trains the adapter against Qwen's chat template with an empty thinking block (`enable_thinking=false`) before the JSON response. Evaluate with `predict_unsloth.py --prompt-format chat --no-load-in-4bit` so training and inference prompts match.

## Gate Protocol

1. Export the same eval input used for v4h or the current required suite.
2. Generate offline PEFT predictions.
   - For Qwen3.5 adapters trained through the CUDA/Unsloth container lane, generate predictions with `ml/temporal-ir/predict_unsloth.py` inside the same Docker image and cache volumes. `predict_peft.py` is the older plain PEFT path.
   - For chat-template experiments, pass `--prompt-format chat`; for bf16/16-bit LoRA experiments, pass `--no-load-in-4bit`.
3. Score with `trained-plan`.
4. Stage endpoint on `8766` and score with `endpoint-plan`.
    - For Qwen3.5 0.8B, prefer the plain PEFT 4-bit Docker serving path first: `scripts/start-temporal-peft-server-container.ps1`. The bf16/non-4-bit path is faster but failed required clarification/composition cases in the first serving experiment.
    - For bf16/chat-template adapters, serve with `-PromptFormat chat -NoLoadIn4Bit`, score with `TEMPORAL_EVAL_ENDPOINT_API=chat` and `TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT=chat`, and keep `enable_thinking=false` unless explicitly testing thinking behavior.
5. Compare latency against v4h.
6. Promote only if offline and staged gates pass and the latency/cost tradeoff is acceptable.

## Reporting

Record every run in `docs/temporal-model-benchmark-log.md`.

Required fields:

- base model
- adapter path
- dataset rows and split counts
- LoRA target modules if changed
- hyperparameters
- train runtime and final eval loss
- offline gate
- staged endpoint gate
- endpoint latency median and p95
- failure classes
- decision

## Kill Criteria

- The model emits plausible but wrong executable IR on required cases.
- The model needs runtime semantic patches to pass.
- Latency exceeds the 5 second product SLO without clear accuracy benefit.
- Framework changes make local deployment materially less reliable than the v4h Qwen2.5 path.
- The model's default thinking/multimodal behavior makes compact Plan-IR serving brittle.
