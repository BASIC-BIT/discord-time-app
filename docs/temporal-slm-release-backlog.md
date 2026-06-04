# Temporal SLM Release Backlog

This backlog tracks release-grade work for the Temporal Plan-IR SLM as a small set of bucketed issue candidates. Split into GitHub issues only when ready to execute a bucket.

## 1. Model And Dataset Release Package

- Create a public-facing model card with base model, LoRA details, prompt format, eval summary, latency, hardware, and intended use.
- Create a dataset card for the tagged synthetic/permutation dataset, including split policy, category mix, generation rules, and privacy notes.
- Document known limitations, including ambiguity handling, unsupported recurrence, locale coverage, and cases requiring clarification.
- Include reproducible commands for synthetic generation, optional paraphrase dry-run/expansion, training, prediction, and executor-backed eval.

## 2. Benchmark And Prior-Art Suite

- Use `docs/temporal-prior-art.md` as the starting inventory for competitor behavior and source references.
- Benchmark against `chrono-node`, Duckling, `dateparser`, and best-effort GPT-mini or similar hosted LLM baselines.
- Give each competitor a fair prompt or configuration rather than forcing the Plan-IR prompt onto models that were not trained for it.
- Report schema validity, executable rate, wrong singular answer rate, clarification correctness, latency, and cost.
- Include standard, messy, ambiguous, and hard-boundary buckets so the suite cannot over-reward esoteric examples.

## 3. Demo API And Examples

- Publish a small demo API or local server path that accepts text, reference instant, and time zone, then returns resolved timestamps or clarification alternatives.
- Include examples of clarification behavior, especially bare hours, next-weekday ambiguity, event posts with multiple times, and short malformed inputs like `tu 5pma`.
- Keep deterministic execution visibly authoritative: the SLM emits Plan-IR, and the executor computes timestamps.
- Provide copy-paste examples for command-line inference and HTTP requests.

## 4. Architecture And Product Narrative

- Add a clear diagram showing `user text -> Temporal Plan-IR SLM -> schema validation -> deterministic executor -> resolved/clarification/fallback`.
- Explain why the model does not directly predict epoch seconds.
- Explain the cost/latency positioning: local small model, deterministic short-circuit, fallback, and no always-on hosted GPU assumption.
- Frame novelty accurately: not academically novel schema generation, but a practical, cost/time optimized fuzzy temporal parser with strict validation.
