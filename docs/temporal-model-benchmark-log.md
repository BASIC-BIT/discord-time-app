# Temporal SLM Benchmark Log

This ledger records durable local/hosted Temporal Plan-IR SLM experiments. Keep raw JSON, logs, predictions, and PID files under ignored `api/reports/temporal-ml/`; summarize only the decisions and comparable measurements here.

## Benchmark Fields

- Adapter or model ID: stable name for the adapter, base model, or endpoint.
- Base model: pretrained model before LoRA/QLoRA or hosted tuning.
- Dataset: row count, split counts, and important new semantic coverage.
- Training recipe: preset, epochs, batch size, grad accumulation, LR, LoRA rank/alpha when known.
- Eval gates: offline trained-plan required cases, staged endpoint required cases, promoted endpoint required cases.
- Latency: prediction or endpoint p50/p95 when measured.
- Decision: promoted, rejected, pending, or research-only.

## Current Required Suite

- Required eval cases: `136` after adding bare-minute AM/PM clarification canaries for `day after tomorrow 11:34` and `4:30 Tuesday`.
- Diagnostic eval cases: `0/1` for the current promoted adapter on `first of Febuarysdf 2:30`; target behavior is AM/PM clarification after normalizing `Febuarysdf` to February.
- Reference clock: `2026-05-24T12:00:00Z` unless overridden.
- Reference timezone: `America/New_York` unless overridden.
- Promotion rule: offline trained-plan and staged endpoint gates must pass before changing the canonical `8765` local adapter.
- Current generated expanded dataset: `2584` rows with splits `2049/271/264` after adding ordinal-weekday explicit-month, bare-minute ambiguity, fuzzy-month suffix, bounded noisy-human-input rows, and negative epoch-like rejection reinforcement for the next retrain. The current promoted adapter was trained on the prior `2564`-row month-clock dataset.

## Adapter Ledger

| Adapter | Base Model | Dataset / Coverage | Training Recipe | Offline Gate | Staged Endpoint Gate | Promoted Endpoint Gate | Decision | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen-temporal-ir-permutation-v3-minimal-lora` | Qwen2.5 0.5B instruct lineage | Early permutation suite | minimal preset | `52/70` | not promoted | not promoted | Rejected | Early baseline, broad misses. |
| `qwen-temporal-ir-permutation-v4b-ambiguity-rebalanced-minimal-lora` | Qwen2.5 0.5B instruct lineage | Ambiguity rebalanced | minimal preset | `69/70` | not promoted | not promoted | Rejected | Improved ambiguity handling, one remaining miss. |
| `qwen-temporal-ir-permutation-v4c-date-anchor-double-digit-minimal-lora` | Qwen2.5 0.5B instruct lineage | Date anchor and double-digit coverage | minimal preset | `70/70` | not promoted | not promoted | Superseded | First complete pass on the 70-case suite. |
| `qwen-temporal-ir-v4d-relative-offsets-shorthand-minimal-lora` | Qwen2.5 0.5B instruct lineage | Relative offsets and shorthand | minimal preset | `115/117` | not promoted | not promoted | Rejected | Missed required relative/shorthand cases. |
| `qwen-temporal-ir-v4e-relative-offsets-shorthand-reinforced-minimal-lora` | Qwen2.5 0.5B instruct lineage | Relative offsets and shorthand reinforcement | minimal preset | `117/117` | not promoted | not promoted | Superseded | Complete pass before month-boundary additions. |
| `qwen-temporal-ir-v4f-boundary-snap-month-boundary-minimal-lora` | Qwen2.5 0.5B instruct lineage | Boundary snap and month-boundary coverage | minimal preset | `127/129` | not promoted | not promoted | Rejected | Regressed five-deep recursive `day after` counting and `tu 5pma` ambiguity. |
| `qwen-temporal-ir-v4g-boundary-snap-month-boundary-reinforced-minimal-lora` | `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit` | `129` required cases; reinforced v4f regressions | minimal preset; default script hyperparameters: 3 epochs, batch 2, grad accum 4, LR `2e-4`, LoRA r16/alpha16 | `129/129` | `129/129` on `127.0.0.1:8766` | `129/129` on `127.0.0.1:8765` | Superseded | Prior canonical local adapter. |
| `qwen-temporal-ir-v4h-bare-24h-hour-minimal-lora` | `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit` | `2560` expanded rows; splits `2039/263/258`; adds bare whole-input `13`-`23` hour rows and `19` required canaries | minimal preset; 3 epochs, batch 2, grad accum 4, LR `2e-4`, LoRA r16/alpha16; train runtime `711.2s`, train loss `0.2012`, final eval loss `0.1057` | `131/131`; first-correct median `1976ms`, p95 `5404ms` from offline prediction durations | `131/131` on `127.0.0.1:8766`; median `1831ms`, p95 `5201ms` | `131/131` on `127.0.0.1:8765`; median `1803ms`, p95 `5009ms` | Superseded | Fixes bare `19` without a runtime SLM bypass. Keep as rollback if the Qwen3.5 Docker path is unavailable. |
| `qwen-temporal-ir-qwen35-08b-bf16-chat-minimal-lora` | `Qwen/Qwen3.5-0.8B` | Same `2560` expanded rows and `131` required suite as v4h | minimal preset; Qwen chat-template format; bf16/16-bit LoRA (`-NoLoadIn4Bit`); 3 epochs, batch 2, grad accum 4, LR `2e-4`; train runtime `1368s`, train loss `0.1684`, final eval loss `0.09952` | `131/131`; first-correct median `1635ms`, p95 `4728ms` from offline prediction durations | `131/131` on `127.0.0.1:8769`; chat API, prompt format `chat`, bf16 PEFT; median `1240ms`, p95 `3701ms` | `131/131` on `127.0.0.1:8765`; median `1995ms`, p95 `6232ms`; prewarm `33672ms` | Superseded | Superseded by month-boundary-clock retrain after it dropped the explicit clock in `5pm the first of last month`. |
| `qwen-temporal-ir-qwen35-08b-bf16-chat-month-clock-lora` | `Qwen/Qwen3.5-0.8B` | `2564` expanded rows; splits `2041/264/259`; adds month-boundary explicit-clock rows and required `5pm the first of last month` canary | minimal preset; Qwen chat-template format; bf16/16-bit LoRA (`-NoLoadIn4Bit`); 3 epochs, batch 2, grad accum 4, LR `2e-4`; train runtime `1300s`, train loss `0.1695`, final eval loss `0.1018` | `132/132`; first-correct median `1629ms`, p95 `5093ms` from offline prediction durations | `132/132` on `127.0.0.1:8769`; median `1340ms`, p95 `3828ms`; prewarm `28158ms` | `136/136` on `127.0.0.1:8765` after deterministic ordinal-month and bare-minute ambiguity fixes; median `1118ms`, p95 `2426ms`; prior prewarm `26490ms` | Promoted | Current canonical local adapter. Fixes the observed month-boundary clock omission via retrain; `first tuesday of July` was fixed in deterministic ordinal-weekday grammar because the model already preserved the full query. Bare 1-12 clock text with minutes is now handled by input-level AM/PM clarification before Plan-IR can finalize one side. Product endpoint requires `TEMPORAL_PLAN_IR_ENDPOINT_API=chat` and `TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT=chat`. |

## Semantic Consistency Gate Results

- Feature flag: `TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE=false` by default.
- Full local v4h endpoint plus OpenAI-backed `Semantic Consistency Gate`: `131/131` required cases on `127.0.0.1:8765`, minimal preset, endpoint timeout `30000ms`.
- Result artifact: ignored local file `api/reports/temporal-ml/semantic-gate-endpoint-v4h-full-final.json`.
- Latency: first-correct median `1669ms`, first-correct p95 `4851ms`; final median `9447ms`, final p95 `22329ms`.
- Decision: validated as a correctness gate. Do not promote the blocking parse-mode flag as the default user-visible flow because final verifier latency exceeds the 5 second product SLO. The product path should display the SLM result immediately, then run async/post-display verification against the exact displayed candidate via `/parse/verify`.
- Gate conventions added during validation: future-looking `first of the month`, date-like relative offsets defaulting to local noon, bare `13`-`23` as supported 24-hour shorthand, ordinal weekday-of-explicit-month calendar arithmetic, epoch zero, and leet/l33t/133t/1337 time as 13:37 when emitted via `interpret_clock_phrase`.

## Model Family Comparison Backlog

- Active upgrade protocol: `docs/temporal-model-upgrade-experiment.md`.
- Qwen2.5 0.5B v4h remains the rollback baseline because it passed required gates and used the simpler WSL/4-bit path.
- Qwen3.5 candidates to compare next: `Qwen/Qwen3.5-0.8B`, `Qwen/Qwen3.5-2B`, `Qwen/Qwen3.5-4B`, and `Qwen/Qwen3.5-9B` if local memory and latency are acceptable.
- Use the same dataset, prompt preset, trained-plan eval, and staged endpoint eval before comparing quality. Do not compare a Qwen3.5 run against v4g unless eval suite, instruction preset, and endpoint settings are recorded.
- First hyperparameter sweep should stay small: base model family/size first, then at most LR and epoch count. Avoid tuning runtime heuristics to hide SLM misses.

## Qwen3.5 Research Notes

Official model cards checked: `https://huggingface.co/Qwen/Qwen3.5-0.8B`, `https://huggingface.co/Qwen/Qwen3.5-2B`, `https://huggingface.co/Qwen/Qwen3.5-4B`, and `https://huggingface.co/Qwen/Qwen3.5-9B`.

- All four are Apache-2.0 Hugging Face Transformers models with vision encoder support and native `262,144` token context. This parser does not need vision, so text-only serving should be preferred when the framework supports it.
- `0.8B` and `2B` model cards say non-thinking mode is the default. They also warn that thinking mode can enter thinking loops; keep this parser in direct/non-thinking output mode.
- `4B` and `9B` model cards say thinking mode is the default. For Temporal Plan-IR, disable thinking content via `chat_template_kwargs: {"enable_thinking": false}` or equivalent before scoring.
- Qwen3.5 serving docs require very new framework versions for vLLM/SGLang/Transformers. Before training, run a small local load/generate smoke in a disposable environment or update the WSL venv deliberately.
- Qwen3.5 model-card language benchmark signal: `2B` is materially stronger than `0.8B`; `4B` and `9B` are much stronger but may be slower and heavier than this low-latency parser can justify.
- Initial comparison order: `2B` first, then `0.8B` only if latency/memory dominates, then `4B` if `2B` still produces wrong executable IR. Treat `9B` as a quality ceiling or hosted-only candidate unless local latency is surprisingly acceptable.
- Do not use Qwen3.5's broad tool-calling or multimodal features as a reason to add runtime complexity. The benchmark question is narrow: can it emit valid compact Temporal Plan-IR faster or safer than the Qwen2.5 0.5B adapter?

### Qwen3.5 0.8B Compatibility Scout

- Date: 2026-06-03.
- Base model: `Qwen/Qwen3.5-0.8B`.
- WSL env: `.venv-temporal-ir`, `torch=2.9.1`, `transformers=5.5.0`, `unsloth=2026.5.8`, `bitsandbytes=0.49.2`, RTX 5090.
- Transformers load: model class `Qwen3_5ForCausalLM`, tokenizer class `TokenizersBackend`, tokenizer chat template contains thinking-related content; plain prompt path should continue avoiding chat-template thinking behavior.
- Transformers raw-base generation smoke: `tomorrow at 3pm` generated 128 tokens in `4252ms`; lorem/no-temporal input generated 128 tokens in `2547ms`. Raw base output was not valid Plan-IR, as expected before fine-tuning.
- Unsloth load: recognized `Qwen3_5`, returned tokenizer class `Qwen3VLProcessor`, wrapped PEFT successfully with target modules `q_proj`, `k_proj`, `v_proj`, `o_proj`, `gate_proj`, `up_proj`, and `down_proj`; target count `96`.
- Memory: Transformers scout peak allocation about `1469 MiB`; Unsloth load/wrap scout peak allocation about `847 MiB`.
- Training smoke: 16-row, one-step Unsloth smoke completed and saved an adapter under ignored `api/reports/temporal-ml/qwen35-08b-train-smoke`, but the training step took about `110s` and total runtime was `117.6s`.
- Blocker: Qwen3.5 fast path was unavailable because `flash-linear-attention`/`causal-conv1d` are not installed. A dry-run install of `causal-conv1d` failed because `nvcc` was not available and package metadata generation errored.
- Container remediation: added root `pyproject.toml`/`uv.lock`, `docker/temporal-ir-qwen35.Dockerfile`, and `scripts/start-temporal-ir-training-container.ps1`. The Docker image uses `nvidia/cuda:12.8.1-devel-ubuntu24.04`, uv, torch `2.9.1+cu128`, and compiled `causal-conv1d==1.6.2.post1` plus `flash-linear-attention==0.5.0` successfully. Probe confirmed `nvcc`, CUDA-visible torch on RTX 5090, and imports for `causal_conv1d` and `fla`.
- Container training smoke: same 16-row, one-step smoke completed under ignored `api/reports/temporal-ml/qwen35-08b-container-train-smoke`; first training step improved to about `70s`, total train runtime `75.84s`, and the prior Qwen3.5 fast-path-unavailable warning disappeared. Unsloth still reported broken Flash Attention 2 and used Xformers.
- Launcher verification: Docker Desktop recovered with NVIDIA runtime. Native `docker run -d` worked again, so `scripts/start-temporal-ir-training-container.ps1` was simplified back to detached Docker mode with in-container log teeing. Detached smoke `qwen35-08b-container-detached-smoke` completed, saved an adapter, and reported `train_runtime=79.16s` for one step.
- Runtime estimate: bounded run `qwen35-08b-container-estimate-40r-1e` used 40 rows, 32 train rows, 1 epoch, and 4 training steps. It completed with `train_runtime=80.87s`, `train_loss=2.816`, and `eval_loss=2.321`, implying about `20.2s/step`. Full 2039-train-row, 3-epoch training is roughly `765` steps, about `4.3h` before prediction/eval.
- Full container training completed for `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-minimal-lora`: `765` steps, `train_runtime=1526s`, `train_loss=0.1774`, final `eval_loss=0.1016`, 3 epochs. Initial dataset mix passed: standard `53.7%`, common messy `20.9%`, ambiguity `18.9%`, hard boundary `6.5%`.
- Prediction compatibility fixes: Qwen3.5 loads through `Qwen3VLProcessor`, so `predict_unsloth.py` must pass prompts as `text=[prompt]`; positional input is interpreted as images and fails with `Incorrect image source`. Explicit `eos_token_id` is also required during generation; without it, the model emits the correct first JSON then continues with extra `assistant`/`<think>` text, inflating median latency to `10649ms`.
- Offline trained-plan gate after explicit EOS: `131/131` required cases passed using `api/reports/temporal-ml/temporal-eval-qwen35-08b-minimal-predictions-eos.jsonl`. First-correct latency improved but remains marginal: median `4684ms`, p95 `12987ms`, with a first-request cold compile/warmup outlier of `73001ms`; executor-only final median was `4ms`, p95 `8ms`.
- Serving latency experiments:
  - Plain PEFT bf16/non-4-bit warmed endpoint on `8766` was fast but not correct: `95/131`, median `1397ms`, p95 `2425ms`. It regressed clarification/composition behavior, for example emitting only one AM plan for a bare-hour clarification.
  - Plain PEFT 4-bit warmed endpoint on `8767` with `max_tokens=256` was `130/131`, median `2699ms`, p95 `7552ms`; the single miss was a truncated six-way clarification.
  - Plain PEFT 4-bit warmed endpoint on `8767` with `max_tokens=512` passed `131/131`, median `2354ms`, p95 `6185ms`. The pathological `tu 5pma` six-way clarification took `15721ms` and required `481` completion tokens.
  - Endpoint cold prewarm remained expensive: about `30-31s` for the first request in both bf16 and 4-bit server tests.
- Kernel note: current image still reports `FA2 = False` and uses `xformers==0.0.33.post2`. See `docs/agentic/ingest/flash-attention-blackwell-qwen35-2026-06-03.md`; do not mutate the current image for FA2. If kernel work becomes worthwhile, test `flash-attn-4` in a separate Docker tag.
- Bf16/chat-template follow-up: `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-minimal-lora` trained Qwen3.5 0.8B with Qwen chat-template formatting and bf16/16-bit LoRA (`TEMPORAL_IR_PROMPT_FORMAT=chat`, `TEMPORAL_IR_NO_LOAD_IN_4BIT=1`). Smoke runs completed: 16-row smoke saved `qwen35-08b-bf16-chat-smoke` with `train_runtime=79.24s`; 40-row estimate saved `qwen35-08b-bf16-chat-estimate-40r-1e` with `train_runtime=85.39s`. Full training completed in `1368s` with train loss `0.1684` and final eval loss `0.09952`.
- Offline bf16/chat gate: `131/131` using `predict_unsloth.py --prompt-format chat --no-load-in-4bit`; first-correct median `1635ms`, p95 `4728ms`, with a cold first request around `40.5s`.
- Bf16/chat serving support: `serve_peft_openai.py` and `scripts/start-temporal-peft-server-container.ps1` can now use `--prompt-format chat` / `-PromptFormat chat` so chat-route requests are wrapped with the tokenizer chat template before generation. `TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT=chat` makes the endpoint eval send the matching user-content shape.
- Staged bf16/chat endpoint gate: Docker PEFT server on `127.0.0.1:8769`, model `qwen-temporal-ir-qwen35-bf16-chat`, `-PromptFormat chat`, `-NoLoadIn4Bit`, `max_tokens=512`, prewarm `28197ms`; direct warm smoke `tomorrow` returned clean JSON in `1365ms`; full endpoint gate passed `131/131`, median `1240ms`, p95 `3701ms`. The worst required case remained `weekday-short-ambiguous-clock-suffix-six-way` at `9019ms`.
- Month-boundary-clock miss and fix: user-reported `5pm the first of last month` exposed a Plan-IR generation miss where the bf16/chat adapter dropped the explicit `5pm` and emitted only `first of last month`. Final validation correctly rejected the date-only/noon candidate. Added required eval canary plus train/validation/holdout rows for month-boundary explicit clocks, then retrained `qwen-temporal-ir-qwen35-08b-bf16-chat-month-clock-lora`.
- Promoted month-clock endpoint gate: canonical launcher `scripts/start-temporal-peft-server.ps1` wraps Docker PEFT serving on `127.0.0.1:8765`, model `qwen-temporal-ir-qwen35-bf16-chat-month-clock`, `-PromptFormat chat`, `-NoLoadIn4Bit`, `max_tokens=512`; prewarm `26490ms`; full endpoint gate passed `132/132`, median `1321ms`, p95 `3725ms`. The exact user case resolved to epoch `1777669200` with Plan-IR steps `resolve_calendar_query`, `resolve_clock_time`, and `combine_date_time`.
- Ordinal explicit-month miss and fix: user-reported `first tuesday of July` showed the model preserved the full query but deterministic `resolve_calendar_query` fell through to chrono, which returned June 9 2026. Added a deterministic ordinal weekday-of-explicit-month grammar rule plus required eval canaries, including past-month rollover recomputation, and regenerated the expanded dataset with future retrain rows. Promoted endpoint gate passed `134/134`, median `2114ms`, p95 `6754ms`; result artifact `api/reports/temporal-ml/temporal-eval-qwen35-08b-bf16-chat-month-clock-ordinal-month-rollover-promoted-8765.json`. The exact user case resolved to epoch `1783440000` (`2026-07-07T12:00:00-04:00[America/New_York]`) and the rollover canary resolves to `2027-07-06T12:00:00-04:00[America/New_York]`.
- Bare-minute ambiguity miss and fix: user-reported `day after tomorrow 11:34` exposed that chrono treats `11:34` as AM and the existing clarification policy only caught trailing bare integer hours. Added input-level AM/PM clarification for single bare 1-12 clock mentions with `HH:MM`, dotted `HH.MM`, compact `HMM`/`HHMM`, or trailing bare hour; applied it before both product graph execution and direct Plan-IR execution. Added a deterministic validation backstop so a single candidate with an unresolved 1-12 clock cannot finalize silently. Promoted endpoint gate passed `136/136`, median `1118ms`, p95 `2426ms`; result artifact `api/reports/temporal-ml/temporal-eval-qwen35-08b-bf16-chat-month-clock-bare-minute-ambiguity-promoted-8765.json`.
- Fuzzy-month suffix diagnostic: user-reported `first of Febuarysdf 2:30` should be interpreted by the SLM as February plus AM/PM clarification, but should not be hardcoded in deterministic parsing. Added non-blocking diagnostic eval, three targeted future-training rows, and bounded noisy-human-input synthetic rows covering typo variants, suffix junk, spacing/run-together damage, repeated/missing/transposed letters, and keyboard-adjacent substitutions. Current promoted endpoint remains `136/136` required but diagnostic is `0/1`; result artifact `api/reports/temporal-ml/temporal-eval-qwen35-08b-bf16-chat-month-clock-febuarysdf-diagnostic-promoted-8765.json`.
- Noisy-input retrain attempt: `qwen-temporal-ir-qwen35-08b-bf16-chat-noisy-input-2580-lora` trained on the `2580`-row dataset in `1154s` with train loss `0.174` and final eval loss `0.1023`. Offline trained-plan gate was rejected: `135/136` required, `1/1` diagnostic; `negative-epoch-rejected` regressed by mapping `-1` to `-12:00`. Added negative epoch-like rejection reinforcement rows before the next retrain.
- Decision: Qwen3.5 0.8B bf16/chat month-clock is promoted as the canonical local adapter. Keep v4h as rollback, and prioritize shortening verbose clarification outputs because the six-way clarification remains the latency outlier.

## Next Entry Template

```markdown
### <adapter-or-model-id>

- Date:
- Base model:
- Adapter path or endpoint:
- Dataset rows / splits:
- New coverage:
- Training recipe:
- Offline trained-plan gate:
- Staged endpoint gate:
- Promoted endpoint gate:
- Latency:
- Failure classes:
- Decision:
```
