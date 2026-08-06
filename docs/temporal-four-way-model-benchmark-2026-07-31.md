# Temporal parsing: four-way model benchmark

Date: 2026-07-31

## Recommendation

Keep the V9 routed Qwen cascade as the product default. It is the only tested
configuration that combined:

- 184/184 required cases correct;
- zero wrong resolved answers;
- 1.16 s median and 2.96 s p95 end-to-end latency, inside the 5 s product SLO;
- no hosted-model marginal API spend.

Do not replace it with a prompt-only Luna call or the current GPT-5.5 Plan-IR
agent. Luna is fast and inexpensive but not accurate enough. GPT-5.5 handles
the important Discord-reference compositions well, but the current path is too
slow, too costly, and still produces more wrong resolved answers than the
deterministic-only baseline.

The architectural result is stronger than a model-family result: the winning
system is the confidence-gated cascade. Exact syntax, copied presentation prose,
and known ambiguity should remain deterministic. Only model-owned semantic
composition should invoke a model, and deterministic Plan-IR execution and
validation should remain authoritative.

## Benchmark definition

All primary results use the same 184 required cases plus 2 diagnostic cases,
with fixed reference instants and timezones from the repository eval catalog.
Each configuration ran once, sequentially.

| Configuration | Required correct | Wrong resolved | Median | p95 | Measured API cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Deterministic-only | 125/184 (67.9%) | 13 | 3 ms | 6 ms | $0 |
| V9 production-routed Qwen | 184/184 (100%) | 0 | 1.16 s | 2.96 s | $0 hosted API |
| GPT-5.6 Luna, prompted Plan-IR | 47/184 (25.5%) | 17 | 2.27 s | 3.39 s | $0.3212 |
| GPT-5.5 current Plan-IR agent | 138/184 (75.0%) | 20 | 6.95 s | 13.74 s | $5.2833 |

The GPT-5.5 maximum observed latency was 69.3 s. Its run used 593,530 input
tokens, 77,189 output tokens, and 251 model calls. Luna used 129,948 input
tokens and 31,869 output tokens.

At the measured blended cost per eval request:

- Luna projects to about $17.45 per 10,000 requests, or roughly 28,600 requests
  within a $50 cap.
- GPT-5.5 projects to about $287.14 per 10,000 requests, or roughly 1,740
  requests within a $50 cap.

These are straight-line projections from this corpus, not invoices. V9's local
hardware, electricity, packaging, and maintenance costs were not measured.

## Four product-defining cases

| Input class | Deterministic-only | V9 routed Qwen | Luna Plan-IR | GPT-5.5 agent |
| --- | --- | --- | --- | --- |
| Standalone `<t:1779724800:F>` | Pass, 9 ms | Pass, 7 ms | Correct epoch but wrong Discord format, 1.69 s | Deterministic fast-path pass, 12 ms |
| `<t:1785643200:t> 1 hour later` | Fails closed | Pass, 1.90 s | Correct epoch but wrong format, 2.38 s | Pass, 7.14 s |
| Long copied prose containing one timestamp | Pass, 5 ms | Pass, 4 ms | Correct epoch but wrong format, 1.55 s | Deterministic copied-prose pass, 8 ms |
| `<t:1785643200:t> day at 12 pm` | Fails closed | Pass, 2.48 s | Fails closed, 2.81 s | Pass, 18.64 s |

Additional safety checks support the same boundary:

- Two unrelated timestamps clarify deterministically in about 1-3 ms.
- An exact two-timestamp range stays deterministic and passes.
- `1 day earlier` passes through V9 in 1.89 s and GPT-5.5 in 10.90 s; Luna
  fails closed.

## Interpretation by configuration

### Deterministic-only

This is the right lane for exact tokens, exact ranges, copied affirmative prose,
and high-confidence ambiguity/rejection rules. It is effectively free and
instantaneous. Its 59 required failures show why it cannot own fuzzy language,
typos, relative transformations, or broader composition. Thirteen failures
were wrong resolved answers, so deterministic parsing must remain confidence
bounded rather than continuously expanded.

### V9 routed Qwen

The production route passed all 184 required cases. The raw Qwen Plan-IR runner
by itself passed 156/184 and had 20 wrong resolved failures; routing and
deterministic guards are what converted that into the 184/184 production result.
The boundary assigned 38 cases to the classifier and 146 to the model.

This is important: the evidence does not support “Qwen is perfect.” It supports
“Qwen plus the current classifier, Plan-IR executor, and fail-closed policy is
the best tested system.”

### GPT-5.6 Luna prompt-only Plan-IR

The fair Luna comparison used one hosted call, a compact detailed Plan-IR
instruction, structured JSON, no tools, no fine-tuning, and the same
deterministic executor used by the local model. It met the latency and cost
goals but passed only 47 required cases. Its largest failure class was numeric
relative offsets (42 failures), followed by Discord reference routing and
boundary snapping. Many outputs were structurally invalid or created cyclic or
incomplete step dependencies.

A secondary naive prompt that asked Luna to emit a final epoch directly passed
only 29/184 and produced 116 wrong resolved answers. That control confirms that
moving arithmetic into the model is materially less safe than Plan-IR.

Luna remains worth considering for a narrowly gated shadow experiment after a
schema/prompt redesign, but not as a fallback or production default.

### GPT-5.5 current Plan-IR agent

The current strong path recovered many compositional and typo cases, including
all tested Discord-reference shifts and clock replacements. However, it passed
only 138/184, produced 20 wrong resolved answers, exceeded the 5 s p95 target,
and consumed over ten times Luna's measured spend.

Thirty failures were numeric relative-offset cases. The dominant error was
preserving the reference instant's clock for date-like offsets instead of the
product's date-only noon convention. This is a Plan-IR semantic contract issue,
not something that should be hidden with example-specific deterministic rules.

The path also performs a second model validation call for many candidates.
That improves fail-closed behavior but materially increases latency and cost.

## Defects found and corrected during the benchmark

1. The GPT-5.5 Responses API path was not actually reaching inference. Its
   structured-output schema contained optional plan fields, which strict
   structured outputs reject. The runtime schema now represents those fields as
   required nullable values and normalizes them back to the internal Plan-IR.
2. Plan-IR could contain a self-referential step dependency and leave execution
   waiting forever. The executor now rejects cyclic dependencies immediately,
   preserving the model miss as a fast failure.
3. Planner and final-validation token usage is now included in eval cost
   accounting.
4. The eval runner now supports offsets, progress output, and resumable shards.

These changes improve correctness of evaluation and fail-closed runtime
behavior. They do not add phrase-specific semantic shims or make a failing
model example pass deterministically.

## Credential convention

For local product lifecycle work on Windows, `OPENAI_API_KEY` is stored as a
user-scoped environment variable. New development servers, eval/test commands,
and newly launched installed builds can inherit the same credential.
`api/.env` remains an optional per-checkout override and must use
`OPENAI_API_KEY=<value>`; an unlabeled raw key line is ignored. Keys must never
be committed, logged, or copied into reports.

Production deployment still needs its own secret-manager injection. A Windows
user environment variable is a local lifecycle convention, not a production
secret store.

## Next experiment

Do not train or replace the default yet. The smallest useful next slice is:

1. Keep V9 as default and preserve the 184/184 release gate.
2. Add the structured-output schema fix and cyclic-plan rejection to the next
   installed-build smoke candidate.
3. Run a focused Luna shadow experiment only on model-owned inputs, with a
   strict compact schema that cannot emit irrelevant null fields.
4. Measure whether Luna can match V9 on the Discord-reference subset without
   increasing wrong resolved answers. Stop if it cannot.
5. Treat GPT-5.5 as an offline oracle/data-generation candidate, not an
   interactive default, unless latency and the date-offset contract improve
   substantially.

## Evidence and limitations

Primary artifacts:

- `api/reports/temporal-ml/four-way-deterministic-2026-07-30.json`
- `api/reports/temporal-ml/discord-reference-v9-evaluation-boundary-final.json`
- `api/reports/temporal-ml/four-way-luna-plan-ir-full-2026-07-31.json`
- `api/reports/temporal-ml/four-way-gpt55-agent-full-2026-07-31.json`
- Secondary control: `api/reports/temporal-ml/four-way-luna-full-2026-07-31.json`

Limitations:

- Each hosted case ran once; stochastic variance is not characterized.
- V9 and hosted runs were measured on different days and execution stacks.
- Local GPU cold start, installed-app launch, energy, and hardware depreciation
  were not included.
- The Luna and GPT-5.5 prompts are architecture-appropriate rather than
  token-identical: Luna used a compact Plan-IR prompt; GPT-5.5 used the current
  full agent Plan-IR prompt and conditional final validation.
- No installed MSI smoke or production deployment was performed.

Model identity and pricing were checked against OpenAI's current model guidance
and API pricing pages:

- https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6
- https://developers.openai.com/api/docs/pricing
