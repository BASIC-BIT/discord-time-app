# Temporal Text-To-IR ML Experiment Plan

## Thesis

Train or fine-tune an SLM to translate fuzzy temporal text into Temporal Plan-IR, then keep deterministic code responsible for calendar math, validation, formatting, and final timestamps.

The model is a semantic parser, not a datetime calculator.

## Terminology

- Use `LLM` only for large foundation models such as GPT-class hosted models used for planning, fallback, judging, or paraphrase generation.
- Use `SLM` or `small language model` for the fast local or hosted model trained to emit Temporal Plan-IR.

## Why This Is Worth Testing

- Plan-IR output is structured, inspectable, and rejectable.
- Synthetic data is practical because we can generate IR first and paraphrase outward.
- The deterministic executor gives a cheap correctness oracle for many examples.
- A local or cheap hosted SLM could improve first-correct-display latency versus the current multi-second GPT Plan-IR path.
- Fallback to GPT Plan-IR can make the experiment safe even when the SLM fails.

## Complexity Budget

This project should stay boring unless evals force complexity. Prefer the simplest parser path that passes required evals and preserves the product rule that a wrong singular answer is worse than clarification or fallback.

Current product candidate:

- Deterministic preflight for explicit timestamps, epochs, obvious formats, and cheap ambiguity policies.
- One Plan-IR model for fuzzy interpretation.
- Deterministic executor and validator for all accepted Plan-IR.
- Strong LLM fallback only for invalid, low-confidence, unsupported, or known-risk cases.

Measurement-only unless proven otherwise:

- Router-IR as a separate trainable model.
- Cascade eval as a reporting lens.
- Local desktop model serving and warm-model management.

Cull or demote experiments aggressively:

- If a path adds another model call without reducing measured latency or wrong-answer risk, do not productize it.
- If a path only improves the 30-case toy eval, require a larger semantic-family holdout before keeping it.
- If a hosted/fine-tuned model matches local quality with lower operational complexity, prefer hosted for production.

## Non-Goals For The First Day

- Do not train a model that outputs epoch seconds directly.
- Do not use private user text for training.
- Do not add recurrence execution to the product path yet.
- Do not replace GPT Plan-IR in production.
- Do not optimize model quality before proving the data/eval loop works.

## Recurrence Position

Recurrence belongs in the IR eventually, but not in the first training target unless the product surface changes. Discord timestamp generation currently wants one timestamp or a clarification set, not a recurring schedule.

For now:

- Include recurrence examples as `no_plan` or unsupported in training/evals if needed.
- Use RFC 5545/RRULE concepts as the reference for future recurrence IR.
- Keep recurrence execution behind a separate deterministic library if it is added later.

## Recommended Tool Stack For Spike

- Data generation: local scripts plus GPT/LLM calls with structured output.
- Fine-tuning: Unsloth first for speed; TRL+PEFT as the fallback/control path.
- Tracking: local JSON reports first; W&B if we want a dashboard during training.
- GPU: local WSL + RTX 5090 first; Colab/Kaggle only if the local path fails.
- Evaluation: existing `api/scripts/temporal-model-eval.ts` pattern, extended to call the trained model and executor.
- Durable benchmark ledger: `docs/temporal-model-benchmark-log.md`.

## Unsloth Spike Notes

- Keep training code outside the production app path until the experiment passes evals.
- Use the repo to generate JSONL datasets, then mount/copy the dataset into Colab or a local Unsloth environment.
- Start with LoRA/QLoRA supervised fine-tuning; do not use RL for the first proof.
- Use a small instruct SLM and a strict output prompt that asks for `TemporalPlanPlannerSchema` JSON only.
- Export the adapter/checkpoint and evaluate it through the same schema validator before considering app integration.
- Local scaffold: `ml/temporal-ir/` contains Unsloth requirements, training, lightweight JSON metrics, and plotting scripts.

## Model Candidates

- Start with a small instruct SLM in the 0.5B-3B range.
- Prefer Qwen/Gemma/Phi family models supported by Unsloth or TRL+PEFT.
- Use LoRA/QLoRA; do not full-fine-tune for the first experiment.
- The trained adapter is enough for a spike; merging/exporting can come later.

## OpenAI Fine-Tuning Feasibility

OpenAI supervised fine-tuning is no longer the active first bet if access is winding down. Keep the exporter as a compatibility artifact, but do not spend product architecture on this path unless account access and model availability are confirmed.

Current documentation caveat: OpenAI says the fine-tuning platform is being wound down and is no longer accessible to new users. Existing users may be able to create jobs for a limited period. Treat access as the first gate before spending time here.

Documented supervised fine-tuning candidates:

- `gpt-4.1-2025-04-14`
- `gpt-4.1-mini-2025-04-14`
- `gpt-4.1-nano-2025-04-14`

Minimal experiment:

1. Export existing compact Plan-IR rows to OpenAI chat JSONL with `npm --prefix api run ml:temporal:openai-export`.
2. If fine-tuning access exists, fine-tune `gpt-4.1-nano-2025-04-14` first.
3. Evaluate the fine-tuned model through the same executor-backed `endpoint-plan`/OpenAI-compatible path.
4. Compare against base `gpt-4.1-nano`, base `gpt-4.1-mini`, current GPT Plan-IR, deterministic-only, and local Qwen LoRA.
5. Keep only if it improves latency/cost/complexity without increasing wrong-singular-answer risk.

If fine-tuning access is unavailable, do not emulate it with more local complexity. Run base hosted small-model structured-output evals and decide whether prompt-only hosted is already enough.

## Hosted Deployment Strategy

The active hosted-model question is not only "can we host the adapter?" It is "can the model be warm enough by the time a hotkey user finishes typing, usually return within the 5-second product SLO, pass evals, and not cost hundreds of dollars unnecessarily?"

Product target:

- On hotkey press, start model warmup immediately; do not wait for submit.
- Engineer toward a correct user-visible result within the 5-second product SLO. This is not a blanket hard timeout.
- Use fallback or clarification instead of risking a wrong singular timestamp.
- Keep the app/API code simple unless measured latency or accuracy forces complexity.
- Keep hosted temporal-model spend under an absolute `$50/month` cap unless the user explicitly approves more.

Recommended hosted path:

1. First test RunPod Serverless Flex workers with FlashBoot, Active workers `0`, request-count scaling, short idle timeout, and hotkey prewarm.
2. If cold or revived p95 misses the 5-second SLO, improve prewarm/warm-start behavior and keep fallback in the product path; do not default to an always-warm worker.
3. Compare against Modal with `scaledown_window` and Memory Snapshots, but keep GPU `min_containers=0` by default.
4. Compare against Baseten autoscaling only after verifying exact min-replica and idle billing on a toy deployment.
5. Test Replicate only if our model qualifies for fast-booting fine-tunes; ordinary deployments bill setup, idle, and active time.
6. Keep Hugging Face Inference Endpoints as a simple baseline, but note that scale-to-zero can return `502` while initializing.
7. Treat Fireworks custom fine-tuned serving as a high-cost control because fine-tuned models are documented as dedicated/on-demand deployments.

Rough parked-on-demand budget from public pages:

- RunPod A4000-class Flex at `$0.00016/sec`: `$50` buys about `86.8` billed hours. At `30s` per overlay session, that is about `10,416` sessions/month.
- RunPod L4/A5000/3090-class Flex at `$0.00019/sec`: `$50` buys about `73.1` billed hours. At `30s` per overlay session, that is about `8,771` sessions/month.
- Modal T4 GPU-only at `$0.000164/sec`: `$50` buys about `84.7` billed hours before CPU/memory details. At `30s` per overlay session, that is about `10,162` sessions/month.
- Replicate T4 deployment at `$0.000225/sec`: `$50` buys about `61.7` billed hours. At `30s` per overlay session, that is about `7,407` sessions/month.

Rough monthly 24/7 warm-worker cost from public pages, which exceeds the default budget:

- RunPod A4000-class Active worker: about `$289/mo`.
- RunPod L4/A5000/3090-class Active worker: about `$342/mo`.
- Modal T4/L4 `min_containers=1`: about `$431-$583/mo` plus CPU/memory details.
- Baseten T4/L4 dedicated compute if fully billed: about `$461-$619/mo`, but docs say idle time is not billed, so verify invoice behavior.
- Replicate T4 deployment with `min=1`: about `$591/mo`.
- Hugging Face T4/L4 endpoint with `min=1`: about `$365-$584/mo`.
- Fireworks on-demand H100: about `$5,110/mo`.

Durable deployment workflow: `docs/temporal-hosted-model-deployment.md`.

Raw research note: `docs/agentic/ingest/hosted-temporal-slm-serving-2026-05-30.md`.

## Hosted SLM Evaluation

- Hosted SLM inference is now the main deployment-simplicity axis, but it is not automatically faster than a warm local RTX 5090.
- Measure warm p50/p95/p99 latency, cold-start latency, JSON validity, execution accuracy, fallback rate, and total cost per 1,000 and 1,000,000 parses.
- Serverless GPU endpoints can have cold starts unless the provider keeps a worker warm; always separate cold-start from warm latency in reports.
- Always test the exact adapter/export format because managed APIs, vLLM-style endpoints, and serverless LoRA loading have different startup and batching behavior.
- Treat hosted SLM as another runner in `temporal-model-eval.ts`, not as a production assumption.
- Reports must include hotkey-prewarm behavior separately from submit-only behavior.

## Deployment Profiles To Measure

- Warm desktop: the desktop app keeps a tiny local model loaded on the user's machine, so GPU memory residency is acceptable and steady-state latency matters most.
- Cold sporadic desktop: the user invokes parsing once a day for a few seconds, so model load time, first-token latency, and total first-correct-display latency dominate the UX.
- Shared hosted API: multiple desktop clients call a server-owned API, so warm-pool sizing, cold starts, batching, cost, and fallback rate matter more than local GPU availability.
- Keep reports split by profile. A model/export that is best for a warm always-on desktop path may be unacceptable for sporadic cold starts, and vice versa.

## Router IR Experiment

Train and evaluate a separate SLM routing head or compact Router-IR target before forcing every input through the local Temporal Plan-IR model. The router should emit a small structured decision such as `local_plan`, `deterministic_only`, `clarify`, or `escalate_llm`, plus calibrated confidence and reason codes.

This makes LLM fallback an intentional success path instead of an afterthought. The target metric becomes high precision for local accepted answers, bounded wrong-singular-answer rate, and an explicit escalation/clarification rate.

Router training labels can be derived from executor-backed outcomes:

- `local_plan`: compact Plan-IR model output validates and executes to the expected result across repeated samples.
- `deterministic_only`: deterministic parser already handles explicit timestamps or simple supported formats faster and more reliably than the SLM.
- `clarify`: the correct product behavior is multiple alternatives or a question.
- `escalate_llm`: the small model is unstable, unsupported, low confidence, or would risk a plausible but wrong singular answer.

Keep the router schema compact and auditable. Do not encode broad natural-language semantic hacks into the router; it should classify confidence/risk and route to tools or models that own the actual parsing.

Initial scaffold:

- Shared schema: `api/src/temporal/router-ir.ts`.
- Dataset builder: `api/scripts/temporal-router-ir-dataset.ts`.
- Cascade scorer: `api/scripts/temporal-cascade-eval.ts`.
- Package script: `npm --prefix api run ml:temporal:router`.
- Package script: `npm --prefix api run eval:temporal:cascade`.
- Labels are derived from executor-backed eval reports rather than hand-assigned confidence.

## Research-Backed Refinement

The closest research threads are semantic parsing, neural program synthesis, constrained decoding, execution-guided decoding, selective prediction, and model cascades. The durable research note is `docs/agentic/ingest/nl-to-dsl-semantic-parsing-2026-05-30.md`.

Practical implications for this project:

- Treat Temporal Plan-IR as a typed executable AST/dataflow graph, not arbitrary JSON text.
- Prefer constrained decoding or compact production/action generation before simply scaling model size.
- Keep denotation/execution accuracy as the primary metric; exact string match is secondary.
- Track risk/coverage for local accepted answers, because abstention is a valid success mode.
- Hold out semantic families and template families to avoid synthetic-data memorization.
- Use deterministic execution and repeated local predictions to generate router labels cheaply.

## Dataset Strategy

Generate labels first:

1. Programmatically emit Plan-IR examples from a small grammar.
2. Execute each IR through deterministic tools to produce expected outputs.
3. Ask an LLM to paraphrase each IR into user text.
4. Add controlled noise: typos, casing, punctuation, clipboard text, casual phrasing, fuzzy clocks, ambiguous `next <weekday>`, bare times.
5. Validate paraphrases with schema checks, executor checks, and spot LLM judging.
6. Split holdouts by semantic family and template family, not only random rows.

Use an 80/10/10 default split for randomized template rows. Fixed hand-eval rows should normally be holdout rows, with separate randomized siblings in train so the adapter learns the family without memorizing the exact eval string.

## Data Taxonomy To Cover

- Explicit timestamps: Discord `<t:...>` tags, bare Unix seconds, milliseconds, microseconds, nanoseconds, epoch zero, huge out-of-range values, negative values.
- Calendar formats: `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY.MM.DD`, `MM/DD/YYYY`, unambiguous `DD/MM/YYYY`, `29 May 2026`, month abbreviations, compact numeric forms only if product behavior is defined.
- Clock formats: 24-hour, 12-hour with punctuation/case variation, compact `430pm`, textual `noon`/`midnight`, relative clock phrases, bare-hour ambiguity.
- Relative composition: repeated `day after`, `week after`, mixed before/after chains, shifted holidays, anchor-plus-clock, and compositions where the final operation is a reducer over repeated modifiers.
- Ambiguity boundaries: `next <weekday>`, weekday-after-next, event posts with multiple candidate times, `later today at 1am`, “tonight” near midnight, user-local vs server-local expectations.
- Holidays and cultural calendars: fixed-date holidays, movable holidays, country/subdivision-specific holidays, informal cultural references only when a deterministic holiday library or explicit training rule exists.
- Noise and extraction: pasted announcements, Discord prose, unrelated dates, typos, casing, punctuation, URL-like junk, and instructions such as “not the other date”.
- Unsupported cases: recurrence, negative epochs, extreme future/past values outside product tolerance, underspecified compact numeric dates, and anything that would be a wrong singular answer without clarification.

## DSL Design Notes

- The model should emit executable Plan-IR, not epoch arithmetic, whenever deterministic tools can own the math.
- Direct epoch-like input should route through deterministic timestamp parsing with `resolve_calendar_query`; the model should not infer milliseconds vs nanoseconds itself.
- Repeated relative language should be representable as one reduced `shift_datetime` delta, not as an unbounded sequence of identical Plan-IR steps.
- The current Plan-IR `max(6)` step bound is a useful guardrail, but it means recursive text must be reduced before execution.
- For bounded repeated text such as up to five `day after` modifiers, the SLM may reduce the count into one `shift_datetime` delta and executor validation should catch wrong outputs.
- If reduction requires arbitrary counting, the safe options are a sandbox/code-execution tool or LLM fallback with validation. Do not grow ad hoc regex piles for every observed phrasing.
- `propose_candidate` remains a last resort for explicit ISO/epoch values and should not be used for remembered holidays or calendar math.

## Agent Sandbox Idea

The agent-facing type list already has a `sandbox_eval` placeholder, but there is no implemented sandbox tool yet. A useful future tool would expose the user input as a read-only variable and allow constrained Python for counting/reducing text patterns before emitting Plan-IR. This is most valuable for recursive composition like repeated “day after”, not for ordinary date parsing that deterministic libraries already handle.

Example row shape:

```json
{
  "input": {
    "text": "next saturday at l33t time",
    "referenceInstant": "2026-05-24T12:00:00Z",
    "timeZone": "America/New_York"
  },
  "output": {
    "outcome": "clarification",
    "plans": [
      { "steps": [{ "operation": "resolve_weekday_anchor", "weekday": "saturday", "weekdayAnchor": "next_ambiguous" }] }
    ]
  }
}
```

## First-Day Experiment

### Phase 1: Freeze Schema

- Define a minimal training IR schema from the current Plan-IR.
- Include `outcome`: `plans`, `clarification`, `no_plan`.
- Keep fields nullable/required to match structured-output constraints already learned.
- Add a schema validator script independent of the app runtime.
- Current shared schema lives in `api/src/temporal/plan-ir.ts`.

### Phase 2: Generate Synthetic Data

- Generate 200-500 seed IR cases from deterministic templates.
- Use an LLM to create 3-10 paraphrases each.
- Target 1k-5k rows for the first run.
- Save train/validation/holdout JSONL.
- Seed generator: `npm --prefix api run ml:temporal:synthetic`.

### Phase 3: Baseline Without Training

- Prompt a small open SLM, if feasible, and measure JSON validity and execution accuracy.
- This tells us whether fine-tuning is needed and gives a baseline.

### Phase 4: Fine-Tune

- Run SFT LoRA/QLoRA with Unsloth or TRL+PEFT.
- Log training loss and validation exact-match/schema-validity metrics.
- Save local Trainer metrics and optionally mirror them to W&B for prettier graphs.
- Keep hyperparameters boring: small LR, 1-3 epochs, small batch, early stop if overfitting.

### Phase 5: Evaluate

- Run model outputs through strict JSON/schema validation.
- Execute valid IR with deterministic tools.
- Compare to current evals and synthetic holdout.
- Measure first-correct-display latency, final latency, schema-validity rate, executable rate, fallback rate, and wrong-singular-answer rate.

## Success Criteria

- At least 95% valid schema on synthetic holdout.
- At least 90% execution-equivalent accuracy on synthetic holdout.
- No wrong singular answers on required hand-written evals; invalid/uncertain output must fallback.
- Median local or cheap hosted model planning latency materially below GPT Plan-IR.
- Current required evals pass when fallback is allowed.

## Kill Criteria

- The model frequently emits plausible but semantically wrong executable IR.
- The dataset/eval loop cannot distinguish real generalization from template memorization.
- Latency gains disappear after validation/fallback.
- The generated IR is harder to debug than the current GPT Plan-IR path.

## Glossary

- Adapter: small trainable weights added to a base model.
- Base model: pretrained model before task-specific fine-tuning.
- Fine-tuning: training a pretrained model on task-specific examples.
- LoRA: trainable low-rank adapter weights, cheap compared with full fine-tuning.
- QLoRA: quantized base model plus LoRA, lower GPU memory.
- SFT: supervised fine-tuning on example input/output pairs.
- IR: intermediate representation consumed by deterministic code.
- Semantic parser: model/system that maps text to a formal meaning representation.
- Holdout: data excluded from training and validation to test generalization.
- Overfitting: model memorizes training patterns but fails new patterns.
- Schema validity: output matches the JSON/Zod schema.
- Execution accuracy: output runs and produces expected candidates/status.
- Precision: share of accepted model outputs that are correct once fallback/abstain exists.
- Recall: share of all handleable cases the model answers correctly without fallback.
- Fallback rate: share of inputs routed back to GPT Plan-IR or another safe path.

## Open Questions

- Which Plan-IR fields are stable enough to train against now?
- Do we want the small model to output one plan graph with multiple candidates, or multiple alternative plans?
- Should recurrence be `no_plan` in the first dataset or represented as an unsupported IR branch?
- Local GPU availability is confirmed: RTX 5090 visible from Windows and WSL.
- Do we want W&B tracking from the first run, or local JSON only?

## Source Notes

Raw research notes are in `docs/agentic/ingest/temporal-text-to-ir-ml-2026-05-30.md`.

IR audit notes are in `docs/temporal-plan-ir-audit.md`.
