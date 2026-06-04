# Temporal Text-To-IR ML Research Ingest - 2026-05-30

## Summary

- The proposed approach is best framed as domain-specific semantic parsing: user text -> Temporal Plan-IR -> deterministic executor -> timestamp, candidates, or clarification.
- This is not academically novel, but it is a strong product architecture because the ML model never directly predicts opaque epoch seconds.
- Recurrence should be represented as an optional IR capability, but not included in the first training experiment unless the product needs it. Use iCalendar/RRULE concepts as the reference model if recurrence enters scope.
- Fastest practical experiment: generate synthetic IR cases, use an LLM to paraphrase them, fine-tune a small instruction model with supervised fine-tuning, then reject invalid IR and fallback to current GPT Plan-IR.
- Recommended initial tooling: Unsloth or TRL+PEFT for the first fine-tune; W&B for experiment tracking if we want a familiar hosted dashboard; Colab or Kaggle for cheap GPU trials.
- OpenAI ChatGPT subscriptions and API platform billing are separate. Do not assume ChatGPT/Codex/OpenCode subscription access can legally or reliably power arbitrary batch API generation.

## Domain Terms

- Semantic parsing: translating natural language into a formal meaning representation, such as SQL, a DSL, or our Temporal Plan-IR.
- Text-to-program: a subtype of semantic parsing where the output is executable or interpretable code/IR.
- IR: intermediate representation, a structured format that is not the final answer but can be deterministically executed.
- SFT: supervised fine-tuning; train a model on input/output examples.
- LoRA: low-rank adaptation; train a small adapter instead of all model weights.
- QLoRA: quantized LoRA; reduce memory by loading a quantized base model while training adapters.
- PEFT: parameter-efficient fine-tuning; umbrella term for LoRA-style methods.
- Holdout set: examples withheld from training and used only to measure generalization.
- Schema validity: model output parses as valid JSON and satisfies the Plan-IR schema.
- Execution validity: valid IR can be executed by deterministic calendar tools without runtime errors.
- Execution-equivalent accuracy: produced IR may differ textually from the label but executes to the same expected candidates/status.

## Recurrence Notes

- Recurrence is a natural extension of temporal IR, but it is likely out of scope for HammerOverlay's current single Discord timestamp UX.
- If added, recurrence should be represented as an IR branch, not forced into one-shot timestamp candidates.
- RFC 5545 iCalendar defines standard concepts for recurrence, including RRULE, RDATE, EXDATE, DTSTART, timezone IDs, duration, and event components.
- RRULE is widely understood and compact for storage, but recurrence plus timezone/DST behavior is a footgun. Use an existing recurrence library rather than custom expansion.
- Existing temporal-normalization research points to richer formalisms than TimeML, including SCATE-style compositional representations and repeating intervals. This is relevant if we ever model phrases like "every Thursday morning" or "first weekday of each month".

## Existing Temporal Parsing References

- Duckling parses natural language into structured dimensions including time. It is relevant as prior art for deterministic/rule-backed structured extraction, not necessarily as the product solution.
- SUTime and HeidelTime are older rule-based temporal normalizers around ISO-TimeML. Useful as reference points, but likely too rigid for our fuzzy UX.
- A 2025 arXiv result found via search, "A Semantic Parsing Framework for End-to-End Time Normalization", specifically discusses end-to-end time normalization and richer compositional representations. Fit: conceptually validating; not an implementation shortcut today.

## Tooling Candidates

### Unsloth

- Source: https://docs.unsloth.ai/
- Fit: best first experiment candidate if we want a fast practical path. It advertises faster/lower-VRAM fine-tuning, supports many current models, has notebooks, Docker, and Windows/WSL/Linux support.
- Pros: pragmatic, good for local/Colab-style experiments, LoRA/QLoRA support, strong model coverage, beginner-friendly Studio/UI path.
- Cons: extra abstraction; we should keep artifacts reproducible in scripts, not only a UI.

### Hugging Face TRL + PEFT

- Sources: https://huggingface.co/docs/trl/index and https://huggingface.co/docs/peft/index
- Fit: best transparent baseline for supervised fine-tuning. TRL provides SFTTrainer; PEFT provides LoRA/QLoRA-style parameter-efficient training.
- Pros: ecosystem standard, scriptable, integrates with Transformers, W&B, datasets, model hub.
- Cons: more Python/ML boilerplate than Unsloth or LLaMA Factory.

### Axolotl

- Source: https://docs.axolotl.ai/docs/getting-started.html
- Fit: strong config-driven fine-tuning framework, good if we want YAML-driven reproducibility.
- Pros: quick LoRA example, supports local JSONL instruction data, inference and merge flows.
- Cons: may be more framework than needed for a one-day spike.

### LLaMA Factory

- Source: https://github.com/hiyouga/LLaMA-Factory
- Fit: best no/low-code UI option. Supports many models, LoRA/QLoRA, W&B/MLflow/TensorBoard, Colab notebook, Gradio UI.
- Pros: approachable if we want a visual workflow and quick Colab start.
- Cons: large surface area; risk of spending time learning the framework instead of proving the hypothesis.

### Weights & Biases

- Source: https://wandb.ai/site/experiment-tracking/
- Fit: experiment tracking and dashboards, familiar from image model workflows. Useful for logging loss, eval accuracy, schema-validity rate, fallback rate, latency, and artifacts.
- Pros: low setup, integrates with Transformers/TRL, logs metrics and artifacts.
- Cons: hosted service/privacy considerations; not required for day-zero local proof.

### Langfuse

- Source: https://docs.langfuse.com/
- Fit: LLM application observability, prompt management, traces, datasets, and evals. Better for the current GPT Plan-IR workflow than for low-level GPU training.
- Pros: trace current LLM planner, curate eval failures, build datasets, prompt/version management.
- Cons: not the training tracker for LoRA runs; complements W&B rather than replacing it.

### Google Colab

- Source: https://research.google.com/colaboratory/faq.html
- Fit: cheap/free hosted notebooks with GPUs/TPUs, good for quick SFT experiments.
- Pros: no setup, GPU access, easy notebooks.
- Cons: resources not guaranteed; free tier has variable limits and timeouts; paid compute still not guaranteed like dedicated cloud GPUs.

### Kaggle Notebooks

- Source: https://www.kaggle.com/docs/notebooks
- Fit: alternative free/cheap GPU notebook environment.
- Pros: common for ML experiments and datasets.
- Cons: fetched page had minimal usable detail; need deeper follow-up if selected.

### OpenAI Fine-Tuning

- Source: https://platform.openai.com/docs/guides/fine-tuning
- Fit: low-ops hosted fine-tuning if platform access/model support fits.
- Important note from fetched docs: OpenAI states ChatGPT and API billing are separate, and the docs page observed says the fine-tuning platform is winding down / limited for new users. Verify before planning around it.
- Pros: easiest if available.
- Cons: less likely to meet the local/cheap latency goal; API costs remain token-billed.

## OpenAI Subscription/API Cost Note

- Source: https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform
- OpenAI says ChatGPT and API platform use separate billing systems.
- Interpretation: a ChatGPT/Codex/OpenCode monthly subscription should not be treated as a supported way to run arbitrary high-volume API batch generation.
- Safe alternatives: use OpenAI API Batch/Flex/lower-cost models, local/open models for paraphrase generation, or manually use subscription-based Codex/OpenCode for interactive work but not as an automated data-generation backend.

## Proposed Data Generation Shape

- Generate IR first, then text. This keeps labels known and executable.
- For each synthetic IR case, deterministically execute it to produce expected status/candidates.
- Ask an LLM to create many paraphrases for the IR, including casual text, typos, punctuation, pasted-event style, ambiguity, and shorthand.
- Run verifier passes: schema check, deterministic execution, optional LLM judge, and holdout eval.
- Keep training and holdout splits by template family and semantic composition, not random rows only.

## Recommended First Experiment

- Freeze a small Plan-IR subset: relative dates, weekday anchors, explicit clocks, fuzzy stable clocks, AM/PM ambiguity, top-level `next <weekday>` ambiguity, holidays, ordinal weekday grammar.
- Exclude recurrence for experiment 1 except maybe a `no_plan`/unsupported label for recurrence examples.
- Generate 1k-5k examples first, not 50k.
- Fine-tune a small model with SFT/LoRA to output strict JSON Plan-IR.
- Evaluate on current temporal evals plus synthetic holdout.
- Route model output through strict schema validation and deterministic executor; fallback to GPT Plan-IR on invalid output, no-plan, low confidence, or execution mismatch.

## Decision Recommendation

- Use Unsloth first if the goal is a one-day proof with minimum ML setup friction.
- Use TRL+PEFT if the goal is maximum script-level control and long-term maintainability.
- Use W&B only if we want metrics/artifact tracking from the start; otherwise log JSON locally for the spike.
- Use Colab for GPU if local hardware is inadequate; keep the dataset and eval scripts in this repo so the notebook is just a runner.

## Links

- Unsloth docs: https://docs.unsloth.ai/
- TRL docs: https://huggingface.co/docs/trl/index
- PEFT docs: https://huggingface.co/docs/peft/index
- Axolotl quickstart: https://docs.axolotl.ai/docs/getting-started.html
- LLaMA Factory: https://github.com/hiyouga/LLaMA-Factory
- W&B experiment tracking: https://wandb.ai/site/experiment-tracking/
- Langfuse overview: https://docs.langfuse.com/
- Colab FAQ: https://research.google.com/colaboratory/faq.html
- OpenAI ChatGPT vs API billing: https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform
- OpenAI model optimization/fine-tuning docs: https://platform.openai.com/docs/guides/fine-tuning
- RFC 5545 iCalendar: https://www.rfc-editor.org/rfc/rfc5545
- Duckling Rust port: https://crates.io/crates/duckling
- Semantic parsing framework for time normalization: https://arxiv.org/html/2507.06450v1
