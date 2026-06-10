# Temporal Local Model Deployment

Local Temporal SLM deployment uses one stable Windows-local endpoint:

```powershell
.\scripts\start-temporal-peft-server.ps1
```

The script serves the current local adapter on `http://127.0.0.1:8765/v1`, prewarms by default, and verifies Windows `localhost` reachability before reporting success. It also stops legacy WSL `serve_peft_openai.py` processes on `8765` before starting the Docker server so the promoted container can bind the canonical port.

The API should use these local settings:

```env
TEMPORAL_FEATURE_PLAN_IR=true
TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL=http://127.0.0.1:8765/v1
TEMPORAL_PLAN_IR_ENDPOINT_MODEL=qwen-temporal-ir-qwen35-bf16-chat-time-range-2687
TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET=minimal
TEMPORAL_PLAN_IR_ENDPOINT_API=chat
TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT=chat
TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS=512
TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS=15000
```

Do not use port `8000` for the local Temporal SLM. It is too likely to collide with other local Python/FastAPI tools, and a collision can make Windows `127.0.0.1:8000` hit the wrong service while the WSL model is healthy.

When changing the deployed local adapter, update `scripts/start-temporal-peft-server.ps1`, restart the server with the command above, and run:

```powershell
$env:PATH = "C:\ProgramData\nvm\v24.15.0;$env:PATH"
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://127.0.0.1:8765/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-qwen35-bf16-chat-time-range-2687"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_API = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = "60000"
npm --prefix api run eval:temporal
```

Current local adapter: `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora`.

Current gate result: `153/153` required and `1/1` diagnostic on the promoted production local endpoint at `http://127.0.0.1:8765/v1`. The latest promoted diagnostic is `first of Febuarysdf 2:30`, which returns AM/PM clarification after SLM typo recovery instead of a wrong singular answer. Current promoted endpoint latency from that gate: first-correct median `1306ms`, p95 `3605ms`; final median `1536ms`, p95 `4466ms`; prewarm `29159ms`. Keep `TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS=15000` until clarification output is shortened.

Semantic Consistency Gate validation: local v4h endpoint plus OpenAI-backed gate passed `131/131`. First-correct display median/p95 was `1669ms`/`4851ms`; final verifier median/p95 was `9447ms`/`22329ms`. Keep `TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE=false` for blocking parse mode by default. Product UX should use asynchronous post-display verification through `/parse/verify` so the first correct answer is shown before the verifier finishes.

Current expanded suite: `153` required cases after adding first-class `time_range` coverage for same-day ranges, 24-hour ranges, overnight ranges, timezone ranges, next-weekday range clarification, and unsupported date-span/schedule-block rejection on top of first-class timezone coverage and the earlier bare-hour, month-boundary, ordinal-weekday, noisy-input, and bare-minute ambiguity canaries. The regenerated expanded dataset has `2687` rows with splits `2138/281/268`; the promoted adapter was trained on that dataset after adding range reinforcement for next-weekday ambiguity and unsupported date spans. The previous timezone-step `2642` adapter remains the rollback adapter for non-range behavior; v4h remains the rollback adapter if the Qwen3.5 Docker path is unavailable.

Durable adapter/model comparison notes live in `docs/temporal-model-benchmark-log.md`.

Qwen3.5 hybrid-model experiments that require CUDA extension compilation should use the uv-managed CUDA devel container lane in `docker/temporal-ir-qwen35.Dockerfile` instead of changing the known-good `.venv-temporal-ir` environment. Details live in `docs/temporal-model-upgrade-experiment.md`.

Qwen3.5 0.8B Docker serving experiments can still use the plain PEFT launcher directly for non-production ports. It serves trained Qwen3.5 adapters through `serve_peft_openai.py` and prewarms one tiny completion so the first user request does not pay the cold compile cost.

```powershell
.\scripts\start-temporal-peft-server-container.ps1
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://127.0.0.1:8767/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-qwen35-4bit"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_API = "completions"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
npm --prefix api run eval:temporal
```

Do not switch Qwen3.5 serving to `-NoLoadIn4Bit` based on speed alone. The bf16/non-4-bit endpoint was much faster (`95/131`, median `1397ms`, p95 `2425ms`) but failed required clarification/composition cases. The 4-bit endpoint was slower but passed the full gate (`131/131`, median `2354ms`, p95 `6185ms`) after prewarm with `max_tokens=512`.

For current Qwen3.5 bf16/chat adapters, stage on a non-production port with both chat prompt formatting and bf16 loading before changing the canonical launcher. Latest time-range staged result on `127.0.0.1:8769`: `153/153` required and `1/1` diagnostic, first-correct median `1125ms`, p95 `3087ms`, final median `1311ms`, final p95 `3523ms`, prewarm `28361ms`.

```powershell
.\scripts\start-temporal-peft-server-container.ps1 -AdapterPath "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora" -ModelName "qwen-temporal-ir-qwen35-bf16-chat-time-range-2687" -Port 8769 -PromptFormat chat -NoLoadIn4Bit
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://127.0.0.1:8769/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-qwen35-bf16-chat-time-range-2687"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_API = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = "60000"
npm --prefix api run eval:temporal
```

The promoted production launcher now wraps the same Docker path on port `8765` with `-PromptFormat chat -NoLoadIn4Bit` and prewarm enabled by default:

```powershell
.\scripts\start-temporal-peft-server.ps1
```

## Training And Staging Checklist

Use this checklist for every new adapter. Do not skip directly from training to changing `scripts/start-temporal-peft-server.ps1`.

1. Regenerate data and confirm the mix guard:

```powershell
$env:PATH = "C:\ProgramData\nvm\v24.15.0;$env:PATH"
npm --prefix api run ml:temporal:synthetic
$env:TEMPORAL_IR_PARAPHRASE_DRY_RUN = "1"
npm --prefix api run ml:temporal:paraphrase
$env:TEMPORAL_IR_CHECK_MIX_ONLY = "1"
python ml\temporal-ir\train_unsloth.py
```

2. Train to a new adapter directory. Never reuse the currently deployed adapter directory. For current Qwen3.5 bf16/chat adapters, use the Docker CUDA lane so the command runs from the current checkout instead of a hardcoded WSL path.

```powershell
.\scripts\start-temporal-ir-training-container.ps1 -AdapterName "<new-adapter-name>" -PromptFormat chat -NoLoadIn4Bit
.\scripts\start-temporal-ir-training-container.ps1 -AdapterName "<new-adapter-name>" -Status -Tail 40
```

3. Export eval input with an absolute Windows path. Avoid repo-relative paths here because `npm --prefix api` can make path expectations easy to misread.

```powershell
$repoRoot = (Resolve-Path .).Path
$env:TEMPORAL_EVAL_EXPORT_INPUT = Join-Path $repoRoot "api\reports\temporal-ml\temporal-eval-<adapter-name>-input.jsonl"
$env:TEMPORAL_EVAL_BASELINES = ""
$env:TEMPORAL_EVAL_MODELS = ""
npm --prefix api run eval:temporal
```

4. Generate offline predictions with the same Docker image/cache volumes used for training, then score them with `trained-plan`. For bf16/chat adapters, use `predict_unsloth.py` with `TEMPORAL_IR_MODEL_DIR`, `TEMPORAL_IR_PROMPT_FORMAT=chat`, and `TEMPORAL_IR_NO_LOAD_IN_4BIT=1`; `predict_peft.py` is the older plain PEFT path.

```powershell
docker run --rm --gpus all --workdir /workspace --volume "${repoRoot}:/workspace" --volume temporal-ir-hf-cache:/cache/huggingface --volume temporal-ir-uv-cache:/cache/uv --env TEMPORAL_IR_MODEL_DIR="ml/temporal-ir/outputs/<new-adapter-name>" --env TEMPORAL_IR_INSTRUCTION_PRESET=minimal --env TEMPORAL_IR_PROMPT_FORMAT=chat --env TEMPORAL_IR_NO_LOAD_IN_4BIT=1 --env TEMPORAL_IR_PREDICT_INPUT="api/reports/temporal-ml/temporal-eval-<adapter-name>-input.jsonl" --env TEMPORAL_IR_PREDICT_OUTPUT="api/reports/temporal-ml/temporal-eval-<adapter-name>-predictions.jsonl" hammer-overlay-temporal-ir-qwen35:cuda12.8 python ml/temporal-ir/predict_unsloth.py
$env:TEMPORAL_EVAL_BASELINES = "trained-plan"
$env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS = Join-Path $repoRoot "api\reports\temporal-ml\temporal-eval-<adapter-name>-predictions.jsonl"
npm --prefix api run eval:temporal
```

5. Stage the new adapter on a non-default port before promotion. The default launcher only checks the served model name, so an already-running old adapter on `8765` can look healthy. Use a staging port such as `8766` for the endpoint gate. This is unpromoted adapter validation, not a concurrent production server; the launcher stops stale local Temporal PEFT server processes before starting the requested adapter. For Qwen3.5 container-trained adapters, use `scripts/start-temporal-peft-server-container.ps1` instead.

```powershell
.\scripts\start-temporal-peft-server.ps1 -AdapterPath "ml/temporal-ir/outputs/<new-adapter-name>" -Port 8766
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://127.0.0.1:8766/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
npm --prefix api run eval:temporal
```

6. Promote only after offline and staged endpoint gates both pass. Then update `scripts/start-temporal-peft-server.ps1`, this document, and any local `.env` adapter/endpoint notes if they changed. Restart the production local server on `8765` and rerun the endpoint gate against `8765`.
