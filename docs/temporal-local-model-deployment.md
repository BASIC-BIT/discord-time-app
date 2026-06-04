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
TEMPORAL_PLAN_IR_ENDPOINT_MODEL=qwen-temporal-ir-qwen35-bf16-chat-month-clock
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
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-qwen35-bf16-chat-month-clock"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = "minimal"
$env:TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_API = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS = "512"
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = "60000"
npm --prefix api run eval:temporal
```

Current local adapter: `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-month-clock-lora`.

Current gate result: `136/136` on the promoted production local endpoint at `http://127.0.0.1:8765/v1`. The latest added required cases are `day after tomorrow 11:34` and `4:30 Tuesday`, which guard AM/PM clarification for bare 1-12 clock text with minutes. Current promoted endpoint latency from that gate: median `1118ms`, p95 `2426ms`. Keep `TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS=15000` until clarification output is shortened.

Semantic Consistency Gate validation: local v4h endpoint plus OpenAI-backed gate passed `131/131`. First-correct display median/p95 was `1669ms`/`4851ms`; final verifier median/p95 was `9447ms`/`22329ms`. Keep `TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE=false` for blocking parse mode by default. Product UX should use asynchronous post-display verification through `/parse/verify` so the first correct answer is shown before the verifier finishes.

Current expanded suite: `136` required cases after adding bare whole-input `13`-`23` hour coverage, the month-boundary explicit-clock canary `5pm the first of last month`, ordinal-weekday explicit-month canaries for `first tuesday of July`, and bare-minute AM/PM clarification canaries. The regenerated expanded dataset has `2584` rows with splits `2049/271/264`; the promoted adapter was trained on the prior `2564`-row month-clock dataset. Current diagnostic `first of Febuarysdf 2:30` is intentionally non-blocking and fails on the promoted adapter until the next SLM retrain; the next dataset now includes bounded noisy-human-input rows for typo variants, suffix junk, spacing/run-together damage, repeated/missing/transposed letters, keyboard-adjacent substitutions, and negative epoch-like rejection reinforcement. v4g remains the prior passing baseline for the `129`-case month-boundary and boundary-snap suite. v4h adds bare `19` before-target and after-target-rollover canaries without adding runtime SLM bypasses, and remains the rollback adapter if the Qwen3.5 Docker path is unavailable.

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

The earlier bf16/chat-template adapter was served with both the chat prompt format and bf16 loading. Staged result on `127.0.0.1:8769`: `131/131`, median `1240ms`, p95 `3701ms`, prewarm `28197ms`. It was superseded by the month-boundary-clock retrain after `5pm the first of last month` exposed a Plan-IR generation miss.

```powershell
.\scripts\start-temporal-peft-server-container.ps1 -AdapterPath "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-month-clock-lora" -ModelName "qwen-temporal-ir-qwen35-bf16-chat-month-clock" -Port 8769 -PromptFormat chat -NoLoadIn4Bit
$env:TEMPORAL_EVAL_BASELINES = "endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = "http://127.0.0.1:8769/v1"
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = "qwen-temporal-ir-qwen35-bf16-chat-month-clock"
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

2. Train to a new adapter directory. Never reuse the currently deployed adapter directory.

```powershell
wsl.exe -d Ubuntu-24.04 --cd /mnt/d/bench/discord-time-app-src -- bash -lc "source .venv-temporal-ir/bin/activate && TEMPORAL_IR_OUTPUT_DIR=ml/temporal-ir/outputs/<new-adapter-name> TEMPORAL_IR_INSTRUCTION_PRESET=minimal python ml/temporal-ir/train_unsloth.py"
```

3. Export eval input with an absolute Windows path. Avoid repo-relative paths here because `npm --prefix api` can make path expectations easy to misread.

```powershell
$env:TEMPORAL_EVAL_EXPORT_INPUT = "D:\bench\discord-time-app-src\api\reports\temporal-ml\temporal-eval-<adapter-name>-input.jsonl"
$env:TEMPORAL_EVAL_BASELINES = ""
$env:TEMPORAL_EVAL_MODELS = ""
npm --prefix api run eval:temporal
```

4. Generate offline PEFT predictions from WSL using the matching `/mnt/d/...` paths, then score them with `trained-plan`.

```powershell
wsl.exe -d Ubuntu-24.04 --cd /mnt/d/bench/discord-time-app-src -- bash -lc "source .venv-temporal-ir/bin/activate && TEMPORAL_IR_ADAPTER_DIR=ml/temporal-ir/outputs/<new-adapter-name> TEMPORAL_IR_INSTRUCTION_PRESET=minimal TEMPORAL_IR_PREDICT_INPUT=/mnt/d/bench/discord-time-app-src/api/reports/temporal-ml/temporal-eval-<adapter-name>-input.jsonl TEMPORAL_IR_PREDICT_OUTPUT=/mnt/d/bench/discord-time-app-src/api/reports/temporal-ml/temporal-eval-<adapter-name>-predictions.jsonl python ml/temporal-ir/predict_peft.py"
$env:TEMPORAL_EVAL_BASELINES = "trained-plan"
$env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS = "D:\bench\discord-time-app-src\api\reports\temporal-ml\temporal-eval-<adapter-name>-predictions.jsonl"
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
