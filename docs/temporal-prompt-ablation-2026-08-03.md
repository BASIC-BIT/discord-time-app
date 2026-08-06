# Temporal Plan-IR Prompt Ablation

Status: controlled single-seed run complete on 2026-08-04.

## Question

How much instruction detail belongs in Temporal Plan-IR fine-tuning examples, and how much belongs in the inference request?

This experiment isolates that question. It does not compare model families, quantization, serving stacks, routers, deterministic fallbacks, Plan-IR representations, or output validation policies.

## Fixed controls

- Base model: `Qwen/Qwen3.5-0.8B`
- Training format: Qwen chat template, thinking disabled
- Precision: BF16 LoRA (`loadIn4Bit=false`)
- Dataset snapshot: `api/reports/temporal-ml/temporal-ir-prompt-ablation-v1.jsonl`
- Dataset rows: 3,019
- Dataset SHA-256: `248b332842762d954ea1e3ce7f565048b89446b3eeffb5d9ba6d2d358ab0e1cc`
- Eval input: `api/reports/temporal-ml/temporal-prompt-ablation-v1-eval-input.jsonl`
- Eval cases: 186
- Eval-input SHA-256: `7d8597c8d12e7180baea7454beb529a26ecbb3fc252080eb7d9798e75e92e5f4`
- Seed: 3,407
- Epochs: 3
- Batch size: 2
- Gradient accumulation: 4
- Learning rate: 0.0002
- Maximum sequence length: 4,096
- Decoding: greedy, thinking disabled, maximum 512 new tokens
- Scoring: executor-backed semantic correctness, not string equality

The launcher must pass the expected dataset hash so a changed snapshot fails before GPU work begins. Each adapter summary records the dataset hash and training seed. Each prediction row records the eval-input hash and serialized-prompt hash.

## Conditions

Training and inference independently use one of three instruction presets:

| Preset | Meaning |
| --- | --- |
| `none` | Structured input envelope only; no instruction text |
| `minimal` | One sentence requesting compact Temporal Plan-IR JSON |
| `detailed` | The current rule-rich instruction with known boundary guidance |

Train three adapters, then run every adapter under all three inference presets for a 3 x 3 matrix. Do not substitute the historical V9 adapter for the minimal-training cell in the primary result: its row count and timestamps strongly suggest the same dataset, but its run summary predates dataset hashing.

Canonical adapter names are:

- `qwen35-08b-prompt-ablation-v1-none`
- `qwen35-08b-prompt-ablation-v1-minimal`
- `qwen35-08b-prompt-ablation-v1-detailed`

Start each training cell with `scripts/start-temporal-ir-training-container.ps1`; run them sequentially because they share one GPU. After all three finish, `scripts/run-temporal-prompt-ablation.ps1` produces and scores the nine inference cells.

For an unattended local run, `scripts/run-temporal-prompt-ablation-pipeline.ps1` resumes from any verified completed adapter, waits on an already-running cell, trains missing cells sequentially, and then invokes the matrix runner. Redirect its stdout and stderr to ignored files under `api/reports/temporal-ml/` when launching it detached.

The pipeline finishes by running `scripts/summarize-temporal-prompt-ablation.ps1`, which writes a Markdown matrix and machine-readable JSON summary alongside the raw ignored reports. Copy the final conclusions and essential evidence into this tracked document before treating the experiment as durable or publication-ready.

## Measures

For each cell report:

- required-case accuracy and wrong-singular-answer count;
- JSON parse/schema/normalization failures;
- clarification and no-plan behavior;
- p50, p95, and maximum model-generation latency;
- prompt token count and generated token count if the runtime exposes them;
- failure IDs grouped by semantic family;
- adapter, dataset, eval-input, prompt preset, prompt format, seed, and hashes.

The primary comparison is matched-prompt cells (`none/none`, `minimal/minimal`, `detailed/detailed`). Cross-prompt cells measure interface brittleness and help explain whether training learned the DSL or merely a prompt-specific serialization.

## Interpretation guardrails

- A single seed can establish a product direction, not a general scaling law.
- Training loss and JSON validity are supporting metrics; executor-backed correctness is primary.
- Faster prompts matter only after accuracy and wrong-answer risk are acceptable.
- Do not add deterministic semantic shims for individual misses discovered here.
- Preserve raw predictions and scored reports before changing the dataset, prompt text, or executor.

## Follow-up experiment

After selecting a training/inference instruction policy, run a separate two-condition output-contract study:

1. compact Plan-IR, omitting default and null fields;
2. full nullable Plan-IR with the same deterministic executor semantics.

Strict normalization remains fixed in both conditions. Keeping this separate prevents representation density and instruction detail from becoming an uninterpretable multi-axis experiment.

## Results

Executor-backed results over 184 required cases and two diagnostics:

| Training | Inference | Required | Resolved failures | Format-only | Unsafe resolves | p50 generation | p95 generation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| none | none | 143/184 | 4 | 4 | 0 | 1,671 ms | 4,420 ms |
| none | minimal | 131/184 | 5 | 3 | 1 | 1,621 ms | 4,022 ms |
| none | detailed | 13/184 | 0 | 0 | 0 | 903 ms | 3,308 ms |
| minimal | none | 0/184 | 0 | 0 | 0 | 1,015 ms | 3,381 ms |
| minimal | minimal | 145/184 | 8 | 4 | 4 | 1,653 ms | 5,496 ms |
| minimal | detailed | 7/184 | 0 | 0 | 0 | 814 ms | 3,104 ms |
| detailed | none | 0/184 | 0 | 0 | 0 | 510 ms | 1,960 ms |
| detailed | minimal | 0/184 | 0 | 0 | 0 | 1,609 ms | 4,270 ms |
| detailed | detailed | 150/184 | 14 | 14 | 0 | 2,144 ms | 6,843 ms |

`Resolved failures` means the executor returned a timestamp despite failing the expected case. `Format-only` means the epoch/status was acceptable but the Discord display-style index differed. `Unsafe resolves` means the expected behavior was clarification but the model resolved an answer. Parse/schema failures and detailed failure IDs remain in the ignored generated summary and raw reports.

### Findings

1. Prompt-interface matching dominates this run. The three matched cells scored 143, 145, and 150 required cases; every cross-prompt cell scored at most 131, and four scored 13 or fewer. Detailed-training/minimal-inference scored 0/184, directly contradicting the recollection that it was the best cell.
2. Detailed/detailed had the highest raw and presentation-adjusted accuracy. Its 14 resolved failures were all Discord format-selection mismatches, not wrong epochs or missed clarification requirements. It also missed the 5-second product latency target at p95 (6.843 seconds).
3. Minimal/minimal was not the best cell in this run. It scored 145/184 and had four unsafe resolutions where clarification was required, plus four format-only failures. Its p95 was 5.496 seconds.
4. None/none learned substantial Plan-IR behavior from examples alone (143/184) and was the only matched cell below the 5-second p95 target (4.420 seconds), but it failed heavily around Discord references, explicit epochs, and boundary policy.
5. The historical terminology likely conflated a rich/detailed dataset with a detailed instruction preset. This run varies instruction text only; all cells use the same 3,019-row dataset and compact Plan-IR target.

### Recommendation

Do not change the production prompt or adapter from this ablation. No raw matched cell passed the accuracy gate, and detailed/detailed missed the latency target despite leading accuracy. Treat the result as strong evidence that the inference prompt is part of the learned adapter interface and must remain byte-shape compatible with training.

For publication-quality evidence, repeat the three matched cells across additional seeds before claiming that detailed instructions improve accuracy. The cross-prompt collapse is large enough to report as a robust observation from this run, but its exact magnitude still comes from one seed and one model family.

## Confirmation run

Status: complete 2026-08-05.

The focused confirmation keeps only `minimal/minimal` and `detailed/detailed`, using seeds 3,407, 1,337, and 20,260,804. Seed 3,407 reuses the verified adapters and reports above; four additional adapters cover the remaining preset/seed pairs. After raw executor scoring, the pipeline serves each candidate through the production router and compares it with current V9 under the same 186-case boundary evaluation.

During setup, a previously hidden prompt-parity defect was found: the inactive TypeScript detailed prompt had drifted from the Python detailed prompt used for training. The runtime and eval copies now match the trained `detailed-v1` text, with a cross-language regression test. Minimal/live behavior is unchanged.

The resumable controller is `scripts/run-temporal-prompt-confirmation-pipeline.ps1`. Its ignored logs and generated reports remain under `api/reports/temporal-ml/`; the aggregate is `prompt-confirm-v1-summary.md` and `.json`.

### Confirmation results

Raw executor scoring reproduced the initial result across all three seeds:

| Matched preset | Required scores | Mean required | Unsafe resolves | Mean p95 generation |
| --- | --- | ---: | ---: | ---: |
| minimal/minimal | 145, 144, 146 / 184 | 145.00 / 184 | 12 | 5,210 ms |
| detailed/detailed | 150, 150, 149 / 184 | 149.67 / 184 | 1 | 6,691 ms |

Detailed instructions therefore improve the offline raw-model result and substantially reduce unsafe resolutions. That advantage did not survive the served production path consistently:

| Candidate | Routed required | Model-owned | Direct served endpoint | p95 routed |
| --- | ---: | ---: | ---: | ---: |
| shipping time-range-2687 | 162/184 | 124/146 | 149/184 | 3,381 ms |
| V9 Routing Smoke comparator | 184/184 | 146/146 | 156/184 | 2,881 ms |
| minimal seed 3,407 | 184/184 | 146/146 | 156/184 | 3,535 ms |
| minimal seed 1,337 | 183/184 | 145/146 | 156/184 | 3,035 ms |
| minimal seed 20,260,804 | 182/184 | 144/146 | 154/184 | 7,058 ms |
| detailed seed 3,407 | 183/184 | 145/146 | 155/184 | 3,263 ms |
| detailed seed 1,337 | 184/184 | 146/146 | 156/184 | 5,094 ms |
| detailed seed 20,260,804 | 181/184 | 143/146 | 153/184 | 2,922 ms |

Every routed report contains both complete 186-case `routed_endpoint` and `endpoint_plan` lanes (184 required cases plus two diagnostics), and every raw prediction file contains 186 predictions. The final controller completed without errors.

### Confirmation conclusion

The exact shipping-baseline comparison is now complete. The packaged `time-range-2687` adapter scored 162/184 routed and 124/146 model-owned, versus V9 at 184/184 and 146/146. Shipping had 22 required failures that V9 passed and no required case that passed on shipping but failed on V9. The failures cluster in Discord-reference shifts (8), reference/clock composition (7), reference arithmetic across DST (3), timezone-aware ranges (2), ambiguous timezone clarification (1), and overnight ranges (1). V9 was also faster in this run at 2,881 ms p95 versus 3,381 ms for shipping. Direct served-endpoint scoring improved from 149/184 to 156/184.

V9 is therefore the promoted local production adapter; there is no accuracy or latency result favoring the previous package. The V9 asset was published and hash-verified, defaults and legacy-default migration were updated, and the exact production 0.1.4 installed-MSI automated smoke passed with warmed p95 `2794ms`. Manual hotkey confirmation remains before release. Keep the minimal live prompt. The repeated prompt experiment validates a narrower claim: detailed training and matched detailed inference are better in the offline Unsloth runner, but neither the direct Transformers/PEFT server nor the full production route shows a reliable detailed-prompt advantage. Seed variance is material in both families.

Before another prompt or adapter promotion experiment, isolate the offline-versus-served runtime disparity under byte-identical prompts and inputs. For minimal seed 3,407, the same adapter scores 145/184 offline and 156/184 through the direct served endpoint; the production graph then reaches 184/184. Until that runtime parity question is explained, raw-runner gains should be treated as research evidence rather than a production-selection signal.
