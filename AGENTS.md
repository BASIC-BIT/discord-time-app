# Repo Agent Guidance

## Temporal Parsing Product Invariants

- Hotkey readiness matters more than backend elegance: when the overlay hotkey is pressed, any local or hosted model path should begin warming immediately so it is ready by the time the user finishes typing.
- User-visible temporal parsing should return within 5 seconds as a product-level SLO. Engineer the architecture around that target with prewarm, warm-start, validation, fallback, and latency measurement, but do not treat 5 seconds as a mandatory bail-out cutoff unless a specific code path needs a safety guard.
- Accuracy is non-negotiable: wrong singular timestamp answers are worse than clarification, no-plan, or fallback. Required evals must pass before changing parser defaults.
- Cost and complexity are product constraints. The hosted temporal-model budget is an absolute maximum of `$50/month`; do not choose 24/7 warm GPU workers, min replicas, or always-on containers as a default. Use scale-to-zero, parked-on-demand, hotkey prewarm, warm-start caching, measurement, and fallback unless the user explicitly approves a higher spend.
- Do not add routers, model services, warm pools, or provider abstractions unless measured evals show lower latency, lower wrong-answer risk, or materially lower operating cost within the `$50/month` cap.

Promotion note: chat-level product targets promoted to repo `AGENTS.md`; current tier was chat/session memory, target tier is repo guidance, reason is repeated high-cost parser optimization decisions, over-promotion cost is five visible bullets for all repo agents, demotion path is moving details back to `docs/temporal-ml-experiment-plan.md`, verification signal is future parser work preserving the 5-second SLO and eval-first default changes.

## Local Temporal SLM Deployment

- Use `scripts/start-temporal-peft-server.ps1` as the canonical local deployment command. It serves the current local adapter at `http://127.0.0.1:8765/v1`, prewarms by default, and uses the Docker bf16/chat Qwen3.5 path; do not use port `8000` for the local Temporal SLM because other local Python/FastAPI tools can occupy it.
- Keep `api/.env` aligned with `docs/temporal-local-model-deployment.md` when changing the deployed adapter or endpoint port.

Promotion note: local deployment convention promoted from chat/session memory to repo guidance on 2026-06-02; reason is repeated local port/WSL ambiguity during model deploys, over-promotion cost is two bullets, demotion path is relying only on `docs/temporal-local-model-deployment.md` if the workflow stabilizes enough, verification signal is future agents using `127.0.0.1:8765` and the launcher without rediscovering WSL IP/port behavior.

## Temporal SLM Training Jobs

- Do not run long Temporal SLM LoRA/PEFT training as a foreground shell command that blocks the session. Start it detached and continue useful research, docs, eval preparation, or status monitoring while the GPU works.
- Use `scripts/start-temporal-ir-training.ps1` for async local training jobs. Example start: `powershell -ExecutionPolicy Bypass -File scripts\start-temporal-ir-training.ps1 -AdapterName "qwen-temporal-ir-v4h-bare-24h-hour-minimal-lora" -InstructionPreset minimal`.
- Use the same script for status/log tailing. Example status: `powershell -ExecutionPolicy Bypass -File scripts\start-temporal-ir-training.ps1 -AdapterName "qwen-temporal-ir-v4h-bare-24h-hour-minimal-lora" -Status -Tail 40`.
- The async launcher writes a small WSL runner, `.log`, and `.pid` under ignored `api/reports/temporal-ml/`. Treat those as local experiment artifacts, not durable source. If a one-off manual WSL `nohup` command is unavoidable, avoid unescaped PowerShell `$!` / `$(...)` expansion; prefer the launcher script instead.

Promotion note: async training convention promoted from chat/session memory to repo `AGENTS.md` on 2026-06-02 after a foreground WSL training call blocked the session; current tier was chat/session memory, target tier is repo guidance, reason is preventing repeated shell blocking during multi-minute or multi-hour GPU jobs, over-promotion cost is four visible bullets, demotion path is moving details back to `docs/temporal-local-model-deployment.md` if the script becomes self-explanatory, verification signal is future training work using detached jobs plus `.pid`/`.log` status instead of blocking the main shell.

## Temporal SLM Experiment Discipline

- The local Temporal SLM path is intentionally experimental. When deterministic preflight is disabled, that is usually deliberate: the goal is to exercise the SLM's generalization and failure modes, not to make the immediate example pass by bypassing the SLM.
- Do not respond to an SLM miss by automatically adding a deterministic runtime shim, post-hoc override, or fuzzy matching rule. First classify the miss, preserve the failing example, add or adjust Plan-IR training/eval rows, and report whether retraining or model-family comparison is the right next experiment.
- Deterministic code is still valuable, but keep it in its lane: explicit syntax with a stable product rule, calendar/timezone arithmetic, validation, formatting, and execution of SLM-emitted Plan-IR. Do not move semantic interpretation, typo recovery, shorthand expansion, or arbitrary natural-language mapping into deterministic code just to improve one eval or screenshot.
- Evals are measurement, not a command to hill-climb forever. Not every runner/permutation must be 100%. Required evals gate parser default changes and releases; diagnostic evals expose baselines, regressions, latency, cost, and failure classes so we know whether an experiment is improving.
- Preserve runnable baselines and feature-flagged permutations: deterministic-only, SLM-only, LLM-only, and valid cascades should be comparable where the current architecture supports them. Include active feature flags, model identity, and endpoint details in eval output or logs so changes can be compared and rolled back.
- If the user gives an arbitrary failing temporal phrase while SLM experimentation is active, treat it as research signal. The correct stopping point may be a documented failure plus proposed data/training/model next steps, not a code patch that hides the failure behind deterministic fallback.

Promotion note: SLM experiment discipline promoted from chat/session memory to repo `AGENTS.md` on 2026-06-02; source is the user's explicit correction after a proposed bare-number deterministic guard plus `basics-agentic-dogfooding/docs/agentic/autoresearch-eval-loop.md`; current tier was chat/session memory, target tier is repo guidance, reason is preventing repeated agent hill-climbing that invalidates the SLM experiment, over-promotion cost is six visible bullets for all repo agents, demotion path is moving the longer experimental-loop detail to `docs/temporal-ml-experiment-plan.md` if this becomes too noisy, verification signal is future SLM misses being handled with data/eval/training or documented experiment decisions before deterministic bypasses are added.
