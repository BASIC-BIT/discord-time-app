# Hosted Temporal SLM Serving Research Ingest - 2026-05-30

## Product Target

- Pressing the overlay hotkey should start warming the model immediately, before the user submits text.
- The user-visible parse result should arrive within 5 seconds as a product SLO. This is an architecture target, not a blanket hard timeout.
- Required evals must pass before a model path becomes a default.
- Wrong singular timestamp answers are worse than clarification, no-plan, or fallback.
- Cost and code complexity are first-class constraints, not afterthoughts.
- Hosted temporal-model spend is capped at `$50/month` unless the user explicitly approves more.

## Summary

- OpenAI fine-tuning is no longer the right first bet if access is winding down. Keep the exporter as an optional compatibility artifact, but move active exploration back to hosted open-model inference.
- The best fit is a hosted endpoint that supports a parked-on-demand worker without making us pay for a GPU 24/7.
- The practical product shape is hotkey prewarm, warm-start optimized serving, executor validation, and fallback to a strong hosted LLM when the small model is cold, invalid, or risky.
- RunPod is the most direct match for the desired soft-park pattern because Serverless supports Flex workers, idle timeout, and FlashBoot state retention. Active workers are over the default budget and should only be used for short diagnostic tests unless approved.
- Modal is the closest SnapStart-like platform because it has `scaledown_window` and Memory Snapshots, but `min_containers` on GPU is over the default budget and should not be a default.
- Baseten is production-oriented and documents fast cold starts/autoscaling; its pricing page says idle time is not billed, but min-replica billing should be verified with a tiny deployment before relying on that for cost.
- Replicate is attractive only if our model can become a fast-booting fine-tune; ordinary private deployments bill setup, idle, and active time.
- Hugging Face Inference Endpoints are simple and predictable, but scale-to-zero has cold starts and returns 502 while initializing, so it is a weaker fit for this SLO unless the app wraps it with prewarm/queue/fallback behavior.

## Warm-Start And Cached-Start Mechanisms

These are the provider features that matter most. Ordinary scale-to-zero only saves money; it does not guarantee the model is ready by submit time. For this app, "cached" should usually mean cached model files, cached container state, or restored memory state, not output-response caching. Temporal responses depend on the reference instant, timezone, and product policy, so response caches are only safe for health/prewarm calls and static prompts.

| Provider | Mechanism | What is cached or kept | Budget fit | Product fit |
| --- | --- | --- | --- | --- |
| RunPod | FlashBoot | Worker state retained after spin-down for faster revival than fresh boot | Strong | Best first test for parked-on-demand serving |
| RunPod | Cached models | Model files pre-loaded on machines for faster initialization | Strong | Useful if our base/merged model can be scheduled as a cached model |
| RunPod | Idle timeout | Worker remains active briefly after a request | Strong if short | Covers repeated hotkey bursts without 24/7 cost |
| Modal | Memory Snapshots | Container memory captured after warmup and reused for future boots | Strong technically | Closest SnapStart-like feature; measure GPU/model compatibility |
| Modal | Image/Volume model weights | Weights downloaded ahead of time instead of on first invocation | Strong | Reduces boot time, but does not by itself keep GPU memory hot |
| Modal | `scaledown_window` | Warm container kept alive for up to 20 minutes | Good if short | Useful for hotkey bursts; cost rises with long windows |
| Replicate | Fast-booting fine-tunes | Shared base-model pool lets fine-tune boot fast and bill active-only | Excellent if eligible | Only compelling if our model version is labeled fast booting |
| Baseten | Fast cold starts/autoscaling | Production stack claims fast starts and controlled autoscaling | Unknown until tested | Needs toy deployment and invoice verification |
| Hugging Face | Hub/model caching inside endpoint | Dedicated endpoint can cache model files while active | Medium | Scale-to-zero still has cold start and 502 while initializing |
| Fireworks | Serverless base models | Provider-managed warm shared pool for supported base models | Good for fallback | Fine-tuned custom serving appears dedicated/on-demand and expensive |

Ranking for this app:

1. RunPod Flex + FlashBoot + cached model if available + short idle timeout.
2. Modal Memory Snapshots with scale-to-zero and a short `scaledown_window`.
3. Replicate fast-booting fine-tune, only if our base/export qualifies.
4. Baseten autoscaling, only after verifying actual billing and cold-start behavior.
5. Hugging Face endpoint as a simple baseline, not the likely winner for hotkey UX.
6. Fireworks serverless base model as fallback, not custom fine-tuned default.
- Fireworks has managed fine-tuning and OpenAI-compatible data format, but docs say fine-tuned models are served on on-demand dedicated deployments, which likely makes it a high-cost path for this sporadic app.

## Rough Cost Shape

These are order-of-magnitude costs from public pricing pages. Monthly always-warm estimates use 730 hours. Parked-on-demand estimates use only billed online seconds. They exclude request egress, storage, CPU/memory adders where separately billed, and provider discounts.

Always-warm GPU is outside the `$50/month` product budget. The only acceptable default shapes are scale-to-zero, parked-on-demand, per-token serverless, or a short-lived warm window started by hotkey prewarm.

| Provider | Mode | Example small GPU | Warm cost if 24/7 | Soft-park fit | Notes |
| --- | --- | ---: | ---: | --- | --- |
| RunPod | Serverless Active worker | A4000-class active `$0.00011/sec` | About `$289/mo` | Strong | Active worker eliminates cold starts. Flex worker plus FlashBoot may be cheaper if hotkey prewarm works. |
| RunPod | Serverless Flex worker | L4/A5000/3090 flex `$0.00019/sec` | Usage-based if scaled down | Strong | Active compute is about `$0.69/hr`; first long-idle request can still cold start unless FlashBoot/prewarm succeeds. |
| Modal | GPU function | T4 `$0.000164/sec`, L4 `$0.000222/sec` | About `$431-$583/mo` plus CPU/memory | Strong technically, medium cost | `scaledown_window` can keep warm up to 20 minutes; `min_containers` keeps at least one warm container; Memory Snapshots reduce cold starts. |
| Baseten | Dedicated deployment | T4 `$0.01052/min`, L4 `$0.01414/min` | About `$461-$619/mo` if fully billed | Promising, verify billing | Pricing docs say no idle-time billing and autoscaling docs support `min_replica`; validate exact min-replica invoice behavior. |
| Replicate | Deployment | T4 `$0.81/hr` | About `$591/mo` | Medium | Deployments can set min instances, but private/deployment instances bill setup, idle, and active time. |
| Replicate | Fast-booting fine-tune | Provider-specific | Active-only if labeled | Potentially excellent | Only applies to versions labeled fast booting fine-tunes. Need check if our model/base can use this path. |
| Hugging Face | Inference Endpoint | T4 `$0.50/hr`, L4 `$0.80/hr` | About `$365-$584/mo` | Medium-low | Scale-to-zero after 15 idle minutes saves cost but has cold start and 502 while initializing. |
| Fireworks | On-demand deployment | H100 `$7/hr` | About `$5,110/mo` | Low for this app | Fine-tuned models are documented as dedicated/on-demand only. Serverless base models may still be useful as fallback. |

## Parked-On-Demand Cost Envelope

For parked deployments, the cost driver is billed online seconds per overlay session. A session includes cold/revival setup, hidden hotkey prewarm, actual parse generation, and any billed idle timeout before the worker parks again.

Approximate `$50/month` capacity:

| Provider/mode | Rate | `$50` buys | 10s/session | 30s/session | 60s/session | 5min/session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| RunPod A4000-class Flex | `$0.00016/sec` | `86.8h` | `31,250/mo` | `10,416/mo` | `5,208/mo` | `1,041/mo` |
| RunPod L4/A5000/3090 Flex | `$0.00019/sec` | `73.1h` | `26,315/mo` | `8,771/mo` | `4,386/mo` | `877/mo` |
| Modal T4 GPU only | `$0.000164/sec` | `84.7h` | `30,487/mo` | `10,162/mo` | `5,081/mo` | `1,016/mo` |
| Modal L4 GPU only | `$0.000222/sec` | `62.6h` | `22,522/mo` | `7,507/mo` | `3,753/mo` | `750/mo` |
| Replicate T4 deployment | `$0.000225/sec` | `61.7h` | `22,222/mo` | `7,407/mo` | `3,703/mo` | `740/mo` |
| Hugging Face T4 endpoint | `$0.50/hr` | `100h` | `36,000/mo` | `12,000/mo` | `6,000/mo` | `1,200/mo` |
| Hugging Face L4 endpoint | `$0.80/hr` | `62.5h` | `22,500/mo` | `7,500/mo` | `3,750/mo` | `750/mo` |

Interpretation:

- If FlashBoot or a cached container makes a full overlay session cost 10-30 billed seconds, the budget is comfortable for personal usage.
- If every parse causes a 5-minute warm window, the budget is still probably fine for personal usage but starts to matter for shared API usage.
- If the product requires a GPU to stay warm 24/7, the budget is blown by 6x-100x depending on provider.
- If the provider bills a 15-minute idle scale-down window per isolated use, Hugging Face T4 fits roughly `400` isolated uses/month under `$50`, but cold-start behavior is poor for the 5-second SLA.

The cost target therefore rules out permanent warm workers, not hosted inference itself.

## Provider Notes

### RunPod

- Sources: https://docs.runpod.io/serverless/overview, https://docs.runpod.io/serverless/endpoints/endpoint-configurations, https://www.runpod.io/pricing
- Serverless workers start on demand and stop when idle; docs describe cold starts as container start plus model loading.
- Endpoint settings include Active workers, Max workers, Idle timeout, and FlashBoot.
- Active workers are always-on and eliminate cold starts, but charge continuously.
- FlashBoot retains worker state after spin-down for faster revival than a fresh boot.
- Cached models can reduce cold starts to seconds even for large Hugging Face-hosted models, avoid billing while the model downloads, and share one cached copy across workers on the same host.
- Cached models work best if the base or merged model is hosted on Hugging Face; private non-Hugging-Face artifacts should be baked into the image instead.
- Load-balancing endpoints are better for low-latency HTTP services; queue-based endpoints are better for guaranteed execution.
- First experiment should use Flex workers, FlashBoot enabled, request-count autoscaling, Active workers `0`, a short idle timeout, and hotkey prewarm. If p95 misses the 5-second SLO, improve warm-start/prewarm behavior and fallback quality rather than defaulting to Active workers.
- Active workers may be used for a short diagnostic benchmark to learn the warm-latency ceiling, but they exceed the default `$50/month` budget as a standing configuration.

### Modal

- Sources: https://modal.com/docs/guide/cold-start, https://modal.com/docs/guide/webhooks, https://modal.com/pricing
- Modal documents cold starts, warm containers, `scaledown_window`, `min_containers`, `buffer_containers`, and Memory Snapshots.
- `scaledown_window` can keep containers alive from 2 seconds to 20 minutes.
- `min_containers` prevents scale-to-zero and keeps warm containers running; this is over the default budget for GPU and should not be a default.
- Memory Snapshots are the closest documented match to a SnapStart-style memory reload.
- GPU Memory Snapshots are an alpha feature, but they can capture GPU state. Modal docs recommend warming the model with a few forward passes before snapshotting.
- Memory Snapshots help most with library initialization, JIT compilation, and initialization-heavy work. They do not directly speed up weight reads from storage, so model-weight packaging still matters.
- GPU pricing is per second; a permanently warm T4 is about `$431/mo`, L4 about `$583/mo`, before CPU/memory details.
- Good fit for measuring true snapshot behavior with scale-to-zero or a short `scaledown_window`, but do not set GPU `min_containers` unless a higher budget is approved.

### Baseten

- Sources: https://docs.baseten.co/deploy/autoscaling, https://www.baseten.co/pricing/
- Baseten exposes autoscaling controls such as `concurrency_target`, `target_utilization_percentage`, `autoscaling_window`, `scale_down_delay`, `min_replica`, and `max_replica`.
- Docs recommend `min_replica` of 2 or more for production to eliminate cold starts and add redundancy.
- Pricing page says dedicated deployments pay by compute down to the minute and says customers do not pay for idle time, only time the model is deploying, scaling, or making predictions.
- This could be very attractive if true for min replicas or scale-down behavior, but it needs invoice-level verification with a toy deployment before it can be considered under the `$50/month` cap.
- Strong candidate if we want production observability and support over lowest possible cost.

### Replicate

- Sources: https://replicate.com/docs/topics/deployments, https://replicate.com/docs/topics/billing, https://replicate.com/pricing
- Deployments provide private dedicated endpoints, autoscaling, min/max instances, warm instances, zero-downtime rollout, monitoring, and cost tracking.
- Private models and ordinary deployments bill setup, idle, and active time.
- Public models bill active processing only but can hit shared queues and cold boots.
- Fast-booting fine-tunes are the exception: docs say they only bill active processing time because they use a shared base-model pool.
- This is only compelling if our base model and training/export path qualify for fast-booting fine-tune labeling, or if min instances stay `0` and cold/revival latency plus fallback still meets the product SLA.

### Hugging Face Inference Endpoints

- Sources: https://huggingface.co/docs/inference-endpoints/autoscaling, https://huggingface.co/pricing
- Dedicated endpoints are simple and can run vLLM/TGI/SGLang/custom containers.
- Autoscaling to zero is supported after more than 15 minutes idle.
- During scale-from-zero initialization, docs say the endpoint returns `502 Bad Gateway` and there is no built-in request queue.
- Good baseline for simple deployment and model hub integration.
- Weak fit for the 5-second SLO unless min replicas stay above zero or the app has its own prewarm/queue/fallback behavior.

### Fireworks

- Sources: https://docs.fireworks.ai/fine-tuning/fine-tuning-models, https://docs.fireworks.ai/serverless/pricing, https://fireworks.ai/pricing
- Fireworks SFT uses OpenAI-compatible chat JSONL, so the current exporter format is relevant.
- Fine-tuned models are documented as deployed to on-demand dedicated deployments, which are priced per GPU second.
- Fine-tuning itself is cheap for our likely dataset size, but dedicated H100 serving at `$7/hr` is not a good sporadic-desktop default.
- Fireworks serverless base models may still be useful as a strong fallback because serverless pricing is per token and marketed as no-cold-start.

## Recommended Workflow

1. Keep the Plan-IR executor and eval harness as the source of truth.
2. Add a generic hosted endpoint runner only if the existing `endpoint-plan` runner is insufficient for provider-specific headers, auth, or warmup checks.
3. Use hotkey prewarm: when the overlay opens, the app calls a cheap `/health`, `/warm`, or one-token dry-run endpoint in the background.
4. Keep one strong fallback path for cold starts, provider errors, invalid JSON, schema failures, executor validation failures, low confidence, and known-risk semantic families.
5. Record warm p50/p95/p99, cold p50/p95/p99, first-correct-display latency, fallback rate, wrong singular answer rate, and cost per 1,000 parses.
6. Start with RunPod Flex plus FlashBoot and hotkey prewarm because it best matches the desired soft-park behavior under `$50/month`.
7. If RunPod cold starts still miss the SLO, keep fallback in the product path and compare Modal Memory Snapshots and Baseten autoscaling before considering any always-warm spend.
8. Only test Replicate after confirming whether our base model/export can become a fast-booting fine-tune.
9. Treat Fireworks custom fine-tune serving as a high-cost control, not the default direction.

## Decision Gates

- Do not ship a hosted SLM default until required evals pass repeatedly with executor-backed scoring.
- Do not promote a default path whose p95 cold or hot user-visible latency misses the 5-second SLO without measured evidence that prewarm/fallback preserves product quality.
- Do not pay for 24/7 GPU warmth under the default budget. A standing warm GPU requires explicit approval because it exceeds `$50/month`.
- Do not allow hidden prewarm calls to run unbounded. Add monthly spend alerts, request caps, and a kill switch before enabling hosted prewarm by default.
- Do not add a second model/router service unless it improves measured latency, accuracy, or cost after fallback is included.
- Do not trust provider marketing about cold starts; measure the exact container, model, adapter, structured-output mode, region, and warmup policy.

## Near-Term Experiment

- Package the current Qwen2.5 0.5B adapter or a merged model behind an OpenAI-compatible server image.
- Deploy to RunPod Serverless with FlashBoot, Active workers `0`, aggressive request-count scaling, and the shortest idle timeout that still covers normal hotkey bursts.
- Add an app/API prewarm call triggered by overlay open, not submit.
- Run the current 30-case eval plus a larger generated holdout against `TEMPORAL_EVAL_BASELINES=endpoint-plan`.
- Repeat after long idle intervals to measure true cold and FlashBoot revival latency.
- If the p95 product path misses the 5-second SLO, first improve prewarm/warm-start behavior and test Modal Memory Snapshots or Baseten autoscaling. Run Active workers `1`, Modal `min_containers=1`, or Baseten `min_replica=1` only as short diagnostic benchmarks, not as defaults.

## Links

- RunPod Serverless overview: https://docs.runpod.io/serverless/overview
- RunPod endpoint settings: https://docs.runpod.io/serverless/endpoints/endpoint-configurations
- RunPod pricing: https://www.runpod.io/pricing
- Modal cold start guide: https://modal.com/docs/guide/cold-start
- Modal web functions: https://modal.com/docs/guide/webhooks
- Modal pricing: https://modal.com/pricing
- Baseten autoscaling: https://docs.baseten.co/deploy/autoscaling
- Baseten pricing: https://www.baseten.co/pricing/
- Replicate deployments: https://replicate.com/docs/topics/deployments
- Replicate billing: https://replicate.com/docs/topics/billing
- Replicate pricing: https://replicate.com/pricing
- Hugging Face autoscaling: https://huggingface.co/docs/inference-endpoints/autoscaling
- Hugging Face pricing: https://huggingface.co/pricing
- Fireworks SFT: https://docs.fireworks.ai/fine-tuning/fine-tuning-models
- Fireworks serverless pricing: https://docs.fireworks.ai/serverless/pricing
- Fireworks pricing: https://fireworks.ai/pricing
