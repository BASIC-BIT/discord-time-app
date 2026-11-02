# Hosted SLM Decision Packet

Status: decision packet for BASIC, 2026-10-29, revised 2026-10-30 after review (serverless reframed around duty cycle, warm-on-interaction added in section 7). Nothing in this document has been deployed. No provider resources were created, no secrets were touched, no money was spent.

The ask: stop depending on a Docker Desktop + NVIDIA runtime on every user's machine, and have the V22 temporal model (`qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22`) always live somewhere so HammerOverlay parses out of the box.

What ships in this PR (no infra needed): the app and sidecar can already use a hosted OpenAI-compatible endpoint with a bearer key, fall back to the local runtime when hosted is not configured, and skip every Docker check, pull, and auto-start when hosted is in effect. Section 5 lists the exact steps that only BASIC can run.

## 1. How the model is served today

| Layer | What it does | Where |
|---|---|---|
| Model server | Stdlib Python HTTP server wrapping PEFT + Transformers. Loads `Qwen/Qwen3.5-0.8B` in bf16 and applies the V22 LoRA. Routes: `GET /v1/models`, `GET /health`, `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/cancel`. Optional bearer auth via `--auth-token` / `TEMPORAL_IR_SERVER_AUTH_TOKEN`. One GPU lock: requests are serialized. | `ml/temporal-ir/serve_peft_openai.py`, `ml/temporal-ir/peft_runtime.py` |
| Container | Image `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8`, repo mounted at `/workspace`, adapter read from the mounted path, HF cache volume for the base model. Started with `--prompt-format chat --no-load-in-4bit --max-new-tokens 512`. | `scripts/start-temporal-peft-server-container.ps1`, `scripts/start-temporal-peft-server.ps1` |
| Desktop supervision | Tauri installs runtime files into app data, downloads the adapter zip from the GitHub release `local-slm-runtime-qwen35-range-format-infix-v22`, pulls the Docker image, starts the container, and probes `GET /v1/models` on `127.0.0.1:8770` for readiness. It then passes `TEMPORAL_PLAN_IR_ENDPOINT_*` env to the API sidecar. | `src-tauri/src/lib.rs` (`LOCAL_SLM_*` constants, `apply_slm_api_env`, `local_slm_status_for_settings`) |
| Sidecar | Reads `TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL`, `_MODEL`, `_API_KEY`, `_API` (`chat`), `_PROMPT_FORMAT` (`chat`), `_INSTRUCTION_PRESET` (`minimal`), `_MAX_TOKENS` (512), `_TIMEOUT_MS` (15000). Sends one `POST {base}/v1/chat/completions` per parse with `Authorization: Bearer <key>` and `x-request-id`, best-effort `POST {base}/v1/cancel` on abort. On any endpoint error it returns the deterministic fallback with a warning instead of a wrong timestamp. | `api/src/config.ts`, `api/src/temporal/graph.ts` (`invokePlanIrEndpoint`) |

What the sidecar needs from any hosted endpoint:

- OpenAI-compatible chat completions at `/v1/chat/completions`, `temperature: 0`, `max_tokens: 512`, plain string `choices[0].message.content`. No tool calls, no streaming, no JSON mode required.
- Bearer auth (optional; the sidecar sends it if configured).
- The exact V22 numerics. Earlier hosted work proved that serving the same adapter through vLLM dropped accuracy from 5/5 to 1/5 on the first five cases while the PEFT path scored 5/5. Treat "same adapter, different serving stack" as a new model that must re-pass the gate.
- Latency: the product SLO is a visible result within 5 seconds. V22 locally on an RTX 5090: routed median 1165 ms, p95 3111 ms. The sidecar hard timeout is 15 s, after which the deterministic fallback is returned.
- `/v1/cancel` is optional. If the host does not implement it the sidecar's best-effort call fails silently.

## 2. Hosting options compared

Model footprint: 0.8B parameters in bf16 is about 1.7 GB of weights plus a small LoRA; it fits any current GPU, and a Q8 GGUF is about 0.8 GB for CPU serving.

Budget rule from the earlier hosted work: `$50/month` unless BASIC explicitly approves more. Measured facts from the 2026-05-30 to 2026-06-01 RunPod work are reused where they still apply, with the caveat that they were taken with the older Qwen2.5 0.5B adapter via the RunPod job queue, not with V22.

| Option | Monthly cost (730 h) | Cold start | Latency when warm | Auth | Risk to V22 accuracy | Verdict |
|---|---|---|---|---|---|---|
| **A. Always-on small GPU pod running the existing PEFT container** (RunPod Community Cloud RTX A4000 ~$0.17/h, RTX 4000 Ada ~$0.20/h; Secure Cloud ~$0.32 to $0.38/h; AWS g4dn.xlarge ~$0.53/h, g6.xlarge ~$0.80/h) | $124 to $146 (RunPod community), $234 to $277 (RunPod secure), $384 to $588 (AWS) | None after boot (model load 20 to 60 s once) | Unmeasured on these GPUs. Expect roughly 2x the 5090 numbers, so p95 around 4 to 6 s. Must be measured before enabling. | Bearer token on the server plus provider HTTPS proxy or Caddy | Lowest: same code, same bf16 PEFT path as local | **Recommended if the budget cap is raised.** Only option that reuses the proven runtime unchanged. |
| B. Serverless GPU, scale to zero (RunPod Serverless flex, Modal) | Usage-driven: about $0.03 to $0.10 per cold session depending on the idle window (RunPod flex 16 GB tier $0.00016/s; Modal L4 $0.80/h billed per second) | Measured on RunPod: 34 to 124 s queue delay after idle, 55 s for a prewarm, 156 s for a cold submit, with a lazy-loading worker and a 5 s idle timeout. Baked weights, eager load and a longer idle window were not tried. Modal snapshots untested. | Warm: median 2.7 s, p95 5.8 s (0.5B worker on a MIG slice) | Provider API key or server bearer token | Medium: new worker image for V22 needed | **Viable with warm-on-interaction (section 7).** The first parse of a cold burst is deterministic and the overlay says so; cold start only sets how long the notice shows. Cheapest option below about 30 percent duty cycle. |
| C. Managed inference with a merged model (Hugging Face Inference Endpoints, per-token LoRA services) | HF dedicated L4 $0.80/h is $584 always-on; scale-to-zero wakes in minutes (HF documents no figure; the Quick Start quotes 3 to 5 minutes to initialise and the idle floor is 15 to 60 minutes of billed time). Per-token serverless LoRA services do not list Qwen3.5-0.8B as a base. | Minutes when scaled to zero, with 502/503 until the replica is up | Unknown | Provider token | High: merged-model vLLM paths scored 20 to 22/30 versus 29/30 local on the old adapter | Rejected. Worse price than A or worse cold start than B, plus known numerics drift. |
| D. Always-on CPU box with a merged Q8 GGUF via llama.cpp server (Hetzner / Vultr 8 vCPU class, $30 to $60) | $30 to $60 | None | Estimated 3 to 8 s for a 100-token plan at 15 to 35 tok/s. Unmeasured. | Bearer via llama.cpp `--api-key` | High: merge plus quantization is a new serving stack; needs the full 197/159 gate rerun | Fits the budget, but a benchmark spike first. Not shippable blind. |
| E. BASIC's own always-on 5090 box exposed through Cloudflare Tunnel or Tailscale Funnel | $0 | None | Identical to today's local numbers (p95 3.1 s) plus internet RTT | Server bearer token; Cloudflare Access or rate limiting at the edge | None: it is literally the current runtime | Cheapest bridge to "works out of the box" today. Single machine, home uplink, not an SLA. |

Cost sources (third-party trackers and provider pages, checked 2026-10-29; confirm on the live pricing pages): RunPod GPU pricing page for A4000 / 4000 Ada community and secure rates, RunPod serverless docs for the A4000 flex rate, Modal T4 at about $0.59/h, AWS g4dn.xlarge about $0.526/h and g6.xlarge about $0.805/h in us-east-1, Hugging Face Inference Endpoints L4 at $0.80/h with a one-hour default scale-to-zero window.

Note on T4 (g4dn, cheapest AWS GPU): Turing has no native bf16. The current server loads bf16; on a T4 it would run fp16 or emulated and would need its own eval pass. Prefer Ada (RTX 4000 Ada, L4) or Ampere (A4000, A10G) so the served numerics stay bf16.

### Dedicated versus a serverless worker pinned 24/7

Monthly figures at 730 hours, 16 to 24 GB GPU class, prices as found on 2026-10-29 (confirm on the live pricing pages):

| Shape | Provider and GPU | Rate | 24/7 month |
|---|---|---|---|
| Dedicated pod | RunPod Community, RTX A4000 | $0.17/h | $124 |
| Dedicated pod | RunPod Community, RTX 4000 Ada | $0.20/h | $146 |
| Dedicated pod | RunPod Secure, A4000 / 4000 Ada | $0.32 / $0.38/h | $234 / $277 |
| Marketplace rental | Vast.ai, RTX 4000 Ada | about $0.16/h | about $120, interruptible |
| Serverless, active worker (always-on discount) | RunPod Serverless 16 GB tier | $0.00011/s = $0.40/h | $289 |
| Serverless, flex worker kept hot | RunPod Serverless 16 GB tier | $0.00016/s = $0.58/h | $420 |
| Serverless, flex worker kept hot | RunPod 24 GB tier (the MIG slice tested in June) | $0.00019/s = $0.68/h | $499 |
| Serverless, min_containers=1 | Modal T4 / L4 / A10G | $0.59 / $0.80 / $1.10/h | $431 / $584 / $803 |
| Managed endpoint, no scale-to-zero | Hugging Face L4 | $0.80/h | $584 |
| Cloud VM on demand | AWS g4dn.xlarge (T4) / g6.xlarge (L4) | $0.53 / $0.81/h | $384 / $588 |

A serverless worker that is hot around the clock costs 2.3x to 3.4x a dedicated pod of the same GPU on the same provider, and 3x to 6x on Modal or Hugging Face. Serverless only wins on duty cycle: RunPod flex beats the community pod when the worker is alive less than about 30 percent of the month (about 7 hours a day), and beats the secure pod below about 56 percent. Scheduled "active hours" warming is therefore just a pod during those hours; once more than one product shares the endpoint, the union of active windows climbs past the line quickly.

### Recommendation

1. **Ship warm-on-interaction (section 7) regardless of provider.** It makes cold start a UX notice rather than a failure, which is what lets the cheapest shape be chosen on cost alone.
2. **Pick the provider on measured duty cycle.** Pull sessions per month and session-gap distribution from the parse telemetry database first. Below about 30 percent duty cycle, RunPod Serverless flex (16 GB tier) with a 3 to 10 minute idle timeout is cheapest and likely under the $50 cap. Above it, option A, the RunPod Community pod at about $125 to $150 a month, which needs the cap raised.
3. **If the cap stands and usage is unknown, run E as the bridge** while telemetry accumulates. E costs nothing, needs no new eval because it is the same runtime, and gives users the out-of-box experience now.
4. Hugging Face scale-to-zero is out whatever the schedule: minutes to wake, 15 to 60 minutes of billed idle per wake, and forum reports of endpoints stuck initialising.

Either way, the hosted endpoint must pass the same gate as the local runtime before it becomes the default: 197/197 required routed cases, 159/159 model-owned cases, zero wrong singular answers, warm p95 at or under about 5 s.

## 3. What this PR changes in the app

Settings (`AppSettings` in `src-tauri/src/lib.rs`, mirrored in `src/components/Settings.tsx`):

| Field | Default | Meaning |
|---|---|---|
| `slm_mode` | `"local"` | `"local"` runs the Docker runtime on this machine; `"hosted"` points the sidecar at a remote endpoint. |
| `hosted_slm_endpoint_base_url` | `HOSTED_SLM_DEFAULT_ENDPOINT_BASE_URL` (empty) | OpenAI-compatible base URL. Must be `https://`, or a `http://127.0.0.1:<port>` URL for local testing. A plain `http://` remote URL is refused so the key never leaves the machine in clear text. |
| `hosted_slm_model` | V22 model id | Model id sent in the request body. |
| `hosted_slm_api_key` | `HOSTED_SLM_DEFAULT_API_KEY` (empty) | Sent as `Authorization: Bearer`. Stored in the Tauri settings store in app data, same place as the rest of the settings. |

Behaviour:

- `hosted_slm_endpoint()` resolves the hosted endpoint only when the mode is hosted and the URL is non-empty and secure. Otherwise the app behaves exactly as before (local runtime). This is the "falls back to local when configured" rule, and it also means flipping the default mode to hosted before the constants are filled is harmless.
- `apply_slm_api_env()` passes the effective endpoint, model and key to the sidecar. The sidecar needed no changes: it already honoured `TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL` and `TEMPORAL_PLAN_IR_ENDPOINT_API_KEY`.
- In hosted mode `get_local_slm_status` returns state `hosted` and never runs `docker version`, `docker image inspect`, the launcher lookup, or the adapter check. `start_local_slm` (including the boot-time auto-start) returns immediately. Install Runtime Files, Download Model, Pull Docker Image, Start and Stop are hidden in the UI.
- Changing any hosted field restarts the sidecar on save, the same way local endpoint changes did.
- Deliberately not done: a hosted health probe from Rust. The Tauri side has no HTTPS client and adding one for a status pill was not worth a dependency. The sidecar already reports per-request endpoint failures and returns the deterministic fallback, and the Settings panel shows "Endpoint: configured" rather than claiming "ready".

Tests: `cargo test --lib slm` covers mode resolution, the empty-URL fallback, the plain-HTTP refusal, and the exact env handed to the sidecar.

## 4. Security notes BASIC should read before filling the defaults

- A default key compiled into `HOSTED_SLM_DEFAULT_API_KEY` is extractable from the binary. Treat it as a rate-limiting token, not a secret: cap `max_tokens` server side (the server already defaults to 512), put the endpoint behind an edge rate limit (Cloudflare, or the provider's proxy), and rotate it by shipping a release. Per-install keys issued by a tiny auth proxy are the upgrade path if abuse appears.
- The server serializes requests behind one GPU lock. A single abusive client can starve everyone. Edge rate limiting is the mitigation, not a code change.
- The HF token that the RunPod edit UI exposed in June is still listed as an open item in `docs/temporal-hosted-slm-journey.md`. Rotate it before creating any new provider resources.
- Only `https://` remote URLs are accepted by the app. Do not put the server on the public internet without TLS in front of it; `serve_peft_openai.py` speaks plain HTTP.

## 5. Exact steps for BASIC (nothing here was run)

These steps create paid or public resources and touch secrets, so they are queued for BASIC under the standing no-deploy, no-infra, no-money rules.

### 5a. Option A: always-on GPU pod (recommended if the budget is approved)

1. Rotate the exposed Hugging Face token (journey doc open item). Not strictly needed for A, which uses the release zip, but it is overdue.
2. RunPod console: create a Pod (not Serverless), Community Cloud, GPU `RTX A4000` or `RTX 4000 Ada`, template "RunPod PyTorch" or any CUDA 12.8 base, 20 GB container disk, 20 GB volume at `/workspace`. Expose HTTP port `8770`. Set a spend alert at $160/month in Billing.
3. In the pod shell:

   ```bash
   cd /workspace
   git clone https://github.com/BASIC-BIT/discord-time-app.git repo && cd repo
   curl -L -o adapter.zip https://github.com/BASIC-BIT/discord-time-app/releases/download/local-slm-runtime-qwen35-range-format-infix-v22/qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22-lora.zip
   echo "fcd12698c93736cfa1a62ec49e93e1c50919a45c42548beb8322f51a1d3a84ce  adapter.zip" | sha256sum -c
   mkdir -p ml/temporal-ir/outputs && unzip adapter.zip -d ml/temporal-ir/outputs
   pip install -r ml/temporal-ir/requirements-peft-server.txt
   export TEMPORAL_IR_SERVER_AUTH_TOKEN="$(openssl rand -hex 32)"; echo "$TEMPORAL_IR_SERVER_AUTH_TOKEN"   # save this in your password manager
   nohup python ml/temporal-ir/serve_peft_openai.py \
     --base-model Qwen/Qwen3.5-0.8B \
     --adapter ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22-lora \
     --model-name qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22 \
     --host 0.0.0.0 --port 8770 --max-new-tokens 512 \
     --prompt-format chat --no-load-in-4bit > server.log 2>&1 &
   ```

   Confirm the adapter zip's top-level folder name matches `--adapter` after extraction, and adjust the path if the zip nests it. Alternatively run the exact local image: `docker run --gpus all -p 8770:8770 -v /workspace/repo:/workspace ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8 python ml/temporal-ir/serve_peft_openai.py ...` with the same arguments; RunPod pods need the Docker-in-Docker template for that, so the bare `pip install` path above is simpler.
4. Turn the server into a pod startup command (Pod → Edit → Container Start Command) so it survives restarts, with `TEMPORAL_IR_SERVER_AUTH_TOKEN` set as a pod environment variable, not in the command line.
5. The endpoint URL is `https://<pod-id>-8770.proxy.runpod.net/v1`. Check from your machine:

   ```bash
   curl -H "Authorization: Bearer <token>" https://<pod-id>-8770.proxy.runpod.net/v1/models
   ```

6. Gate it with the existing eval runner from the repo root (fill the key in an ignored env file, never in the shell history):

   ```bash
   TEMPORAL_EVAL_BASELINES=endpoint-plan TEMPORAL_EVAL_ENDPOINT_BASE_URL=https://<pod-id>-8770.proxy.runpod.net/v1 TEMPORAL_EVAL_ENDPOINT_MODEL=qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22 TEMPORAL_EVAL_ENDPOINT_API=chat TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT=chat TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET=minimal TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS=512 TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS=15000 TEMPORAL_EVAL_ENDPOINT_API_KEY=<token> npm --prefix api run eval:temporal:boundary
   ```

   Use `scripts/run-temporal-evaluation-boundary.ps1` on Windows with the same variables. Required: 197/197 routed, 159/159 model-owned, zero wrong singular answers. Record warm median and p95; if p95 is above about 5 s, move to RTX 4000 Ada or L4 and re-run.
7. Alarm (standing rule: unattended prod ships with an alarm that emails basic@basicbit.net). RunPod has no CloudWatch, so use an external uptime monitor (UptimeRobot or Better Stack free tier): HTTP check every 5 minutes on `https://<pod-id>-8770.proxy.runpod.net/v1/models` with header `Authorization: Bearer <token>`, alert contact basic@basicbit.net. If you choose AWS instead, create the CloudWatch alarm with the SNS email topic in the same Terraform change as the instance, per the basic-life convention.
8. Ship it: in `src-tauri/src/lib.rs` set `HOSTED_SLM_DEFAULT_ENDPOINT_BASE_URL` to the URL, `HOSTED_SLM_DEFAULT_API_KEY` to the token, change the `slm_mode` default to `SLM_MODE_HOSTED` and `local_slm_enabled` default to `true`; mirror the two defaults in `src/components/Settings.tsx`; release. Existing users keep whatever mode they saved.

### 5b. Option E: bridge on BASIC's 5090 box ($0)

1. Start the local runtime as today (`scripts/start-temporal-peft-server.ps1`) but add `-AuthToken` support, or run the container launcher by hand adding `--env TEMPORAL_IR_SERVER_AUTH_TOKEN=<token>` and `--publish 127.0.0.1:8770:8770` (already loopback-only, good).
2. Cloudflare: add a Tunnel (`cloudflared tunnel create hammer-slm`), route a hostname such as `slm.<your-domain>` to `http://127.0.0.1:8770`, and add a Rate Limiting rule (for example 60 requests per minute per IP on `/v1/*`). Alternatively `tailscale funnel 8770` for a quicker but Tailscale-domain URL.
3. Run steps 5a.5 to 5a.8 against `https://slm.<your-domain>/v1`. The eval should match local numbers exactly; if it does not, something in the tunnel is altering requests.
4. Uptime monitor as in 5a.7. Expect downtime whenever the machine sleeps or updates; the deterministic fallback covers users during those windows.

### 5c. Option D spike (only if the cap stands and E is not acceptable)

1. Merge the LoRA into the base (`ml/temporal-ir/merge_unsloth_lora.py` is written for the old Unsloth path; a plain PEFT `merge_and_unload()` on `Qwen/Qwen3.5-0.8B` bf16 is a 20-line script), convert with llama.cpp `convert_hf_to_gguf.py`, quantize to Q8_0.
2. Serve with `llama-server --model merged-q8.gguf --host 0.0.0.0 --port 8770 --api-key <token> --chat-template` on an 8-vCPU VPS, and run the step 5a.6 gate. Any loss against 197/159 kills the option.
3. Only if the gate passes and p95 is under 5 s, proceed as in 5a.7 and 5a.8.

## 6. Open items this packet does not close

- No hosted eval of any Qwen3.5 adapter exists yet; all prior hosted numbers are for the 0.5B adapter.
- Latency of V22 on A4000 / 4000 Ada class GPUs is unmeasured.
- Per-install key issuance is not built; the shipped default key is shared.
- The exposed HF token rotation from June is still pending.

## 7. Warm-on-interaction (shipped in the app and sidecar, dormant until the hosted defaults are filled)

Design: any desktop interaction warms the hosted worker; while it is not known to be warm, parses return the deterministic result instantly and the overlay says so; when it is warm, the overlay switches over. This makes a 30 to 120 s cold start a visible notice instead of a 15 s hang followed by a silent fallback.

Sidecar (`api/`):

- Enabled by `TEMPORAL_PLAN_IR_ENDPOINT_WARMUP=true`, which the Tauri runtime sets only in hosted mode. Local mode is untouched.
- Readiness is a timestamp: the endpoint counts as `ready` for `TEMPORAL_PLAN_IR_ENDPOINT_READY_TTL_MS` (default 240000, 4 minutes) after any successful request to it, parse or warm. Transport failures (network, timeout, non-2xx) mark it cold; a model answer that fails Plan-IR parsing does not, because the worker is evidently up.
- While not `ready`, `POST /parse` skips the endpoint, returns the deterministic result immediately with `debug.endpointWarming: true` and `debug.shortCircuitReason: "plan_ir_endpoint_warming"`, and fires one background warm request: a one-token chat completion with the bearer key, timeout `TEMPORAL_PLAN_IR_ENDPOINT_WARMUP_TIMEOUT_MS` (default 180000). Warms are deduplicated and throttled (10 s after a success, 15 s after a failure).
- `POST /parse/warm` (same `x-api-key` auth as `/parse`) starts a warm and returns the status; `GET /health` reports it under `planIrEndpoint` as `{ configured, warmupEnabled, state: disabled | ready | warming | cold, lastReadyAt, lastError, inFlight }`.

Desktop (`src-tauri/src/lib.rs`, `src/components/Overlay.tsx`):

- The Rust side calls `/parse/warm` when the overlay is shown (hotkey or tray) and once when the sidecar becomes healthy at startup, throttled to one call per 10 s, only when hosted mode is in effect.
- The overlay shows "Smart parsing is warming up, usually under a minute. Showing basic results meanwhile." whenever a result carries `debug.endpointWarming` or the health status is not `ready` with warmup enabled. It polls `/health` every 2.5 s while the notice is up. When the state turns `ready` and the current text is unchanged, idle, and nothing has been copied, it re-runs the parse once so the model result replaces the deterministic one. If something was already copied, nothing changes under the user.

Provider settings that follow from this:

- Set the worker idle timeout above the ready TTL (at least 5 minutes against the 4 minute default) so the sidecar never believes a worker is warm after the provider has torn it down. Shorter idle timeouts are cheaper and cause more cold notices; the telemetry session-gap distribution is the right input for choosing it.
- Rough cost per cold session on RunPod flex 16 GB rates: idle window plus about 30 s of work, so 3 minutes is about $0.03 and 10 minutes about $0.10. At 500 cold sessions a month a 10 minute window lands at the $50 cap.
- Bake the base model and adapter into the worker image and load eagerly at container start. The June worker loaded lazily from the Hub (20 to 32 s) and pulled a multi-gigabyte image on revival; both are avoidable.
- `max_tokens` is capped server side (512) and the warm request asks for 1 token, so a warm is near-free on the model but still bills the worker's revival.
