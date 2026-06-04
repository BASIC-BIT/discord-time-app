# Temporal SLM Model And Serving Research Ingest - 2026-05-30

## Summary

- Keep the current `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit` adapter as the control because it already trains and evaluates in the repo.
- Add newer candidate families only through the same executor-backed evaluation path; do not promote a model on training loss or JSON validity alone.
- For this task, non-thinking or explicitly disabled-thinking modes are preferable because the target output is short compact Plan-IR JSON and latency matters.
- vLLM and SGLang are both viable local OpenAI-compatible serving backends on WSL/Linux; both support structured output constraints and LoRA serving.
- vLLM looks like the best first production-shaped runner because it has mature LoRA serving, OpenAI-compatible APIs, and JSON-schema structured outputs.
- SGLang is a strong parallel benchmark candidate because its docs explicitly guarantee output constraints for JSON schema, regex, or EBNF and it has simple LoRA adapter selection syntax.
- Hosted SLM remains an eval axis, not a product assumption; model cards show some Hugging Face inference-provider availability, but exact warm/cold latency and LoRA/export support must be measured.

## Current Baseline

- Model: `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit`.
- Local adapter: `ml/temporal-ir/outputs/qwen-temporal-ir-expanded-bounded-minimal-lora`.
- Best preliminary same-prompt result: `29/30` on the current small hand suite with `minimal` train and `minimal` inference.
- Role in next work: keep as the low-latency/control baseline and compare newer candidates against it before changing product direction.

## Model Candidates

### Qwen3-0.6B

- Source: https://huggingface.co/Qwen/Qwen3-0.6B
- License: Apache 2.0.
- Model card facts: causal LM, `0.6B` named size, Hugging Face page reports `0.8B params`, 32,768 context length, Qwen3 hybrid thinking/non-thinking support.
- Serving support from model card: Transformers, vLLM, SGLang, Docker Model Runner, quantizations for llama.cpp/Ollama/LM Studio.
- Fit: closest newer-family replacement for the current Qwen2.5 0.5B baseline; likely the first Qwen3 candidate to test for speed/quality tradeoff.
- Risk: thinking mode is enabled by default; inference must explicitly use `enable_thinking=False` or a non-thinking chat template for this short-JSON task.

### Qwen3-1.7B

- Source: https://huggingface.co/Qwen/Qwen3-1.7B
- License: Apache 2.0.
- Model card facts: causal LM, `1.7B` named size, Hugging Face page reports `2B params`, 32,768 context length, hybrid thinking/non-thinking support.
- Serving support from model card: Transformers, vLLM, SGLang, Docker Model Runner, quantizations for llama.cpp/Ollama/LM Studio.
- Fit: probably the best next Qwen size if `0.6B` underfits count/date ambiguity but `4B` is too slow.
- Risk: same thinking-mode latency/format risk as Qwen3-0.6B unless disabled.

### Qwen3-4B-Instruct-2507

- Source: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507
- License: Apache 2.0.
- Model card facts: `4.0B` parameters, 262,144 native context length, non-thinking mode only, no `<think></think>` blocks, improved instruction following/tool usage versus earlier Qwen3 4B non-thinking.
- Serving support from model card: Transformers, vLLM, SGLang, Docker Model Runner, quantizations for llama.cpp/Ollama/LM Studio.
- Fit: strongest local Qwen candidate for quality without thinking-mode management; good candidate if smaller models fail executor-backed holdout.
- Risk: larger latency and memory footprint; long context is not useful for the short Temporal Plan-IR task and should not justify selecting it by itself.

### Gemma 3 1B IT

- Source: https://huggingface.co/google/gemma-3-1b-it
- License/access: Gemma license; Hugging Face page requires accepting Google usage terms before file access.
- Model card facts: 1B parameters, text generation, 32K input context for 1B size, 8192 output context, Transformers support starting from `transformers 4.50.0`.
- Serving support from Hugging Face page: vLLM and SGLang instructions are exposed, plus quantizations for llama.cpp/Ollama/LM Studio.
- Fit: small non-Qwen control with strong open-model family support.
- Risk: gated terms/access adds operational friction; license is not Apache/MIT and must be reviewed before product bundling.

### Phi-4-Mini-Instruct

- Source: https://huggingface.co/microsoft/Phi-4-mini-instruct
- License: MIT.
- Model card facts: `3.8B` parameters, 128K context, 24 supported languages, designed for memory/compute-constrained and latency-bound scenarios, strong reasoning focus.
- Serving support from model card: Transformers and vLLM examples; Hugging Face local-app snippets also show SGLang.
- Fit: useful 4B-class non-Qwen comparison, especially if Qwen candidates fail count/reduction cases.
- Risks: Transformers snippets require `trust_remote_code=True`; model card lists flash-attention requirements and tested hardware as A100/A6000/H100, so RTX 5090 compatibility must be verified rather than assumed.

### SmolLM3-3B

- Source: https://huggingface.co/HuggingFaceTB/SmolLM3-3B
- License: Apache 2.0.
- Model card facts: 3B parameters, fully open model with training details, hybrid reasoning, 64K trained context and up to 128K with YaRN, native support for 6 languages.
- Serving support from model card: vLLM and SGLang OpenAI-compatible deployment; local inference via llama.cpp, ONNX, MLX, MLC, ExecuTorch; quantized checkpoints linked from the model card.
- Fit: attractive fully open 3B-class control, with explicit non-thinking control via `/no_think` or `enable_thinking=False`.
- Risk: Hugging Face page says it is not deployed by any Inference Provider at time fetched, so hosted comparison may require self-hosting.

## Serving Backends

### vLLM

- Sources: https://docs.vllm.ai/en/latest/features/structured_outputs.html, https://docs.vllm.ai/en/latest/features/lora.html, https://docs.vllm.ai/en/stable/getting_started/installation/gpu.html, https://qwen.readthedocs.io/en/latest/deployment/vllm.html
- Platform facts: vLLM GPU docs say Linux is required, Windows is not natively supported, and Windows users should use WSL or community forks; NVIDIA CUDA GPUs need compute capability `7.5` or higher.
- Blackwell note: vLLM GPU docs say NVIDIA Blackwell GPUs require CUDA `12.8` minimum and vLLM binaries are compiled with CUDA `12.9` by default.
- Structured outputs: latest docs support `structured_outputs` with `choice`, `regex`, `json`, `grammar`, and `structural_tag`; OpenAI-compatible server supports JSON schema through `response_format`.
- LoRA: serve adapters with `vllm serve <base> --enable-lora --lora-modules <name>=<path>` and request the adapter by model name; dynamic LoRA loading exists but docs warn it is a production security risk unless isolated and trusted.
- Qwen-specific: Qwen docs recommend vLLM, show `chat_template_kwargs: { enable_thinking: false }` for non-thinking Qwen3 mode, and recommend different sampling params for thinking vs non-thinking.
- Fit: best first production-shaped local runner for this repo because it combines OpenAI-compatible API, LoRA serving, and JSON-schema constrained decoding.
- Risk: install in a fresh WSL/Linux environment; dependency/CUDA wheel mismatches are a common source of time loss.

### SGLang

- Sources: https://docs.sglang.ai/basic_usage/openai_api_completions.html, https://docs.sglang.ai/advanced_features/structured_outputs.html, https://unsloth.ai/docs/basics/inference-and-deployment/sglang-guide.md
- API shape: SGLang provides OpenAI-compatible chat/completions APIs and automatically applies the Hugging Face tokenizer chat template when available.
- Structured outputs: docs say JSON schema, regex, and EBNF can constrain model output, with the model output guaranteed to follow the selected constraint; only one constraint type may be specified per request.
- Grammar backends: XGrammar is the default; Outlines and llguidance are also available.
- LoRA: docs show serving with `--enable-lora --lora-paths adapter_a=/path/to/adapter_a`; request syntax can use `model="base-model:adapter_a"`.
- Qwen/thinking support: SGLang docs list `chat_template_kwargs.enable_thinking` and `--reasoning-parser qwen3` for Qwen3 hybrid models.
- Fit: strong benchmark and possible runtime alternative, especially if JSON/EBNF constraints or LoRA adapter routing are easier for this task than vLLM.
- Risk: Unsloth SGLang guide notes installation can hit Rust/outlines-core and flashinfer cache issues; treat as a separate environment from the current Unsloth training venv.

### Unsloth Export Path

- Sources: https://unsloth.ai/docs/models/tutorials/qwen3-how-to-run-and-fine-tune.md, https://unsloth.ai/docs/basics/inference-and-deployment/vllm-guide.md, https://unsloth.ai/docs/basics/inference-and-deployment/sglang-guide.md, https://qwen.readthedocs.io/en/latest/training/unsloth.html
- Qwen docs summarize Unsloth as a Qwen training path that handles loading, quantization, training, evaluation, running, and deployment with inference engines.
- Unsloth vLLM/SGLang docs show two relevant export options after fine-tuning: `merged_16bit` for a merged model and `lora` for adapter-only output.
- Fit: current repo already uses Unsloth successfully, so serving experiments should first reuse the trained LoRA adapter or export a merged model rather than changing the training stack.
- Risk: adapter compatibility must be tested per base model and backend; managed/serverless APIs may not accept arbitrary local LoRA layouts.

## Hosted SLM Notes

- Hugging Face model pages show some inference-provider availability for Qwen and Gemma/Phi pages, but provider support differs per model.
- SmolLM3 page explicitly said no Inference Provider was currently deployed at fetch time.
- Hosted SLM should be represented as a `temporal-model-eval.ts` runner with the same inputs/outputs as local runners.
- Required metrics: warm p50/p95/p99 latency, cold-start latency, schema-validity rate, executor-valid rate, wrong-singular-answer rate, fallback rate, and cost per 1,000 and 1,000,000 parses.
- Do not assume hosted LoRA is available; evaluate base-model prompting, uploaded merged model, and adapter-hosting separately.

## Recommended Evaluation Matrix

- Control: current Qwen2.5 0.5B adapter with `minimal` train/inference.
- Qwen small: Qwen3-0.6B with `minimal` and `detailed` prompt pairings, non-thinking mode forced.
- Qwen medium: Qwen3-1.7B with same prompt pairings, non-thinking mode forced.
- Qwen quality: Qwen3-4B-Instruct-2507 with same prompt pairings, no thinking mode needed.
- Non-Qwen small: Gemma 3 1B IT if license/access is accepted.
- Non-Qwen medium: Phi-4-mini and SmolLM3-3B if install/runtime compatibility is acceptable.
- Serving: batch Unsloth prediction first for training comparability, then vLLM with structured JSON schema, then SGLang with JSON schema or EBNF.
- Seeds: at least three seeds per promising model/prompt combination after the suite is expanded beyond 30 cases.
- Dataset: keep exact hand evals holdout; train on randomized sibling templates and paraphrases only.

## Near-Term Recommendation

- First implement a local OpenAI-compatible runner interface in `temporal-model-eval.ts` so vLLM/SGLang and hosted endpoints share one path.
- First serving target should be vLLM on WSL with the current Qwen2.5 adapter or a merged export, because it tests deployment shape without changing the model-family axis.
- First new-family model should be Qwen3-0.6B or Qwen3-1.7B; only test 4B-class candidates after a small Qwen3 model shows the eval harness is fair.
- Add structured-output constrained decoding before drawing conclusions from parse failures; this task should penalize semantic mistakes more than recoverable JSON formatting issues.

## Links

- Qwen3-0.6B: https://huggingface.co/Qwen/Qwen3-0.6B
- Qwen3-1.7B: https://huggingface.co/Qwen/Qwen3-1.7B
- Qwen3-4B-Instruct-2507: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507
- Gemma 3 1B IT: https://huggingface.co/google/gemma-3-1b-it
- Phi-4-mini-instruct: https://huggingface.co/microsoft/Phi-4-mini-instruct
- SmolLM3-3B: https://huggingface.co/HuggingFaceTB/SmolLM3-3B
- vLLM structured outputs: https://docs.vllm.ai/en/latest/features/structured_outputs.html
- vLLM LoRA: https://docs.vllm.ai/en/latest/features/lora.html
- vLLM GPU install: https://docs.vllm.ai/en/stable/getting_started/installation/gpu.html
- Qwen vLLM deployment: https://qwen.readthedocs.io/en/latest/deployment/vllm.html
- Qwen Unsloth training: https://qwen.readthedocs.io/en/latest/training/unsloth.html
- Unsloth Qwen3 guide: https://unsloth.ai/docs/models/tutorials/qwen3-how-to-run-and-fine-tune.md
- Unsloth vLLM guide: https://unsloth.ai/docs/basics/inference-and-deployment/vllm-guide.md
- Unsloth SGLang guide: https://unsloth.ai/docs/basics/inference-and-deployment/sglang-guide.md
- SGLang OpenAI API: https://docs.sglang.ai/basic_usage/openai_api_completions.html
- SGLang structured outputs: https://docs.sglang.ai/advanced_features/structured_outputs.html
