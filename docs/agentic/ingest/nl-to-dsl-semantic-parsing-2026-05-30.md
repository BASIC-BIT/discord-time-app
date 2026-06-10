# Natural Language To DSL / Semantic Parsing Research Scan

Date: 2026-05-30

## Short Summary

- The current Temporal Plan-IR experiment fits an established research area: neural semantic parsing, neural program synthesis, and executable DSL generation.
- The strongest adjacent thread is not generic chat fine-tuning. It is mapping natural language to a typed executable representation, then validating by syntax, schema, and denotation/execution.
- Synthetic canonical forms plus paraphrases are a known bootstrapping pattern for domain-specific semantic parsers.
- Constrained decoding and execution-guided decoding are central if wrong executable outputs are costly.
- A separate router/abstention model is also a known pattern: selective prediction, model cascades, and LLM routing.

## Search Notes

- Parallel scouts searched semantic parsing/text-to-DSL, constrained/executor-guided decoding, and routing/abstention.
- Direct verification used arXiv and ACL Anthology pages where available.
- Brave web search rate-limited after one broad query; direct source fetches covered the strongest known papers.

## Core Vocabulary

- Semantic parsing: mapping natural language to a formal executable meaning representation.
- Text-to-SQL / text-to-SPARQL: common benchmark forms of natural-language-to-DSL parsing.
- Neural program synthesis: using neural models to produce programs from natural language, examples, or input/output pairs.
- Denotation / execution accuracy: correctness measured by executing the generated program, not exact string match.
- Constrained decoding: restricting generation to outputs accepted by a grammar, parser, regex, JSON schema, or semantic validator.
- Selective prediction / reject option: allowing a model to abstain instead of returning a risky answer.
- Model cascade / router: routing easy queries to cheap/small models and hard queries to stronger models.

## High-Value Sources

### Semantic Parsing / Text To DSL

- [Building a Semantic Parser Overnight](https://aclanthology.org/P15-1129/) (Wang, Berant, Liang, ACL-IJCNLP 2015)
  - Shows a rapid path for domain semantic parsers using canonical grammar-generated examples and paraphrases.
  - Fit: very close to generating Temporal Plan-IR labels first, then paraphrasing outward.

- [Neural Symbolic Machines: Learning Semantic Parsers on Freebase with Weak Supervision](https://arxiv.org/abs/1611.00020) (Liang et al., 2016/ACL 2017)
  - Combines a neural programmer with a symbolic executor and trains from question-answer pairs via execution reward/search.
  - Fit: supports executor-backed training/evaluation when exact Plan-IR labels are incomplete.

- [Seq2SQL: Generating Structured Queries from Natural Language using Reinforcement Learning](https://arxiv.org/abs/1709.00103) (Zhong, Xiong, Socher, 2017)
  - Reduces output space using SQL structure and uses in-the-loop query execution rewards.
  - Fit: analogous to using Plan-IR structure and deterministic temporal execution to supervise or filter outputs.

- [Spider: A Large-Scale Human-Labeled Dataset for Complex and Cross-Domain Semantic Parsing and Text-to-SQL](https://arxiv.org/abs/1809.08887) (Yu et al., EMNLP 2018)
  - Text-to-SQL benchmark emphasizing cross-domain generalization and novel programs/schemas in test sets.
  - Fit: reminds us to split temporal evals by semantic family/template family, not only random rows.

- [Task-Oriented Dialogue as Dataflow Synthesis](https://aclanthology.org/2020.tacl-1.36/) (Andreas et al., TACL 2020)
  - Maps dialogue turns to executable dataflow programs; SMCalFlow covers events, weather, places, and people.
  - Fit: probably the closest conceptual relative to Temporal Plan-IR because it uses executable graph/dataflow programs for calendar-like intent.

### AST / Grammar-Oriented Generation

- [Abstract Syntax Networks for Code Generation and Semantic Parsing](https://arxiv.org/abs/1704.07535) (Rabinovich, Stern, Klein, ACL 2017)
  - Generates well-formed executable outputs as ASTs using modular decoders specialized by output tree structure.
  - Fit: suggests Plan-IR should be thought of as a typed AST/dataflow graph, not merely JSON text.

- [A Syntactic Neural Model for General-Purpose Code Generation](https://aclanthology.org/P17-1041/) (Yin and Neubig, ACL 2017)
  - Uses grammar-driven decoding via production rules instead of unconstrained token generation.
  - Fit: if JSON generation stays brittle, generate compact typed productions or actions and expand deterministically.

- [TranX: A Transition-Based Neural Abstract Syntax Parser for Semantic Parsing and Code Generation](https://arxiv.org/abs/1810.02720) (Yin and Neubig, 2018)
  - Frames semantic parsing/code generation as AST construction via transition actions.
  - Fit: potential alternative to LoRA JSON output if a tiny classifier/action model is easier to constrain.

### Constrained / Execution-Guided Decoding

- [Robust Text-to-SQL Generation with Execution-Guided Decoding](https://arxiv.org/abs/1807.03100) (Wang et al., 2018)
  - Uses execution guidance to detect and exclude faulty partially generated programs during decoding.
  - Fit: direct support for running partial/final Plan-IR through deterministic temporal validators before accepting it.

- [PICARD: Parsing Incrementally for Constrained Auto-Regressive Decoding from Language Models](https://arxiv.org/abs/2109.05093) (Scholak, Schucher, Bahdanau, EMNLP 2021)
  - Rejects inadmissible tokens during decoding with incremental parsing, improving text-to-SQL validity/performance.
  - Fit: strong argument for grammar/schema-constrained Plan-IR generation instead of post-hoc JSON repair.

- [Efficient Guided Generation for Large Language Models](https://arxiv.org/abs/2307.09702) (Willard and Louf, 2023)
  - Reformulates guided generation as finite-state transitions and implements efficient regex/CFG guidance in Outlines.
  - Fit: practical direction for JSON-schema/grammar-constrained compact Plan-IR decoding with low overhead.

- [Synchromesh: Reliable Code Generation from Pre-trained Language Models](https://arxiv.org/abs/2201.11227) (Poesia et al., 2022)
  - Combines constrained semantic decoding with syntax, typing, scope, and contextual logic.
  - Fit: relevant if Plan-IR constraints grow beyond JSON shape into semantic constraints like valid step references and compatible temporal precision.

### Routing / Abstention / Cascades

- [On Calibration of Modern Neural Networks](https://arxiv.org/abs/1706.04599) (Guo et al., ICML 2017)
  - Shows modern neural nets are often poorly calibrated and temperature scaling can help.
  - Fit: raw SLM confidence should not decide fallback; calibrate on executor-backed eval outcomes.

- [SelectiveNet: A Deep Neural Network with an Integrated Reject Option](https://arxiv.org/abs/1901.09192) (Geifman and El-Yaniv, ICML 2019)
  - Trains prediction and rejection jointly to optimize risk/coverage.
  - Fit: directly supports a router/SLM that intentionally abstains or escalates when wrong singular answers are risky.

- [FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance](https://arxiv.org/abs/2305.05176) (Chen, Zaharia, Zou, 2023)
  - Studies prompt adaptation, approximation, and LLM cascades; shows cascades can reduce cost substantially.
  - Fit: frames local SLM + deterministic parser + hosted LLM fallback as an efficient cascade, not a hack.

- [AutoMix: Automatically Mixing Language Models](https://arxiv.org/abs/2310.12963) (Aggarwal et al., NeurIPS 2024)
  - Routes from smaller to larger LMs using small-model self-verification and a POMDP router under noisy confidence.
  - Fit: matches the idea of letting a small temporal model draft/check, then escalate if unreliable.

- [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665) (Ong et al., 2024/2025)
  - Learns routers from preference data to choose between stronger and weaker LLMs while preserving quality at lower cost.
  - Fit: useful if temporal routing labels come from executor success, human preference, or large-model judged correctness.

## Practical Implications For Temporal Plan-IR

- The current direction is well grounded: SLM-as-semantic-parser plus deterministic executor is exactly the neural-symbolic pattern these papers point toward.
- The most important next improvement is probably constrained decoding or typed action generation, not just more training epochs.
- Keep evaluation executor-backed. Exact JSON/string match is secondary to whether the plan executes to the right product behavior.
- Treat abstention/escalation as a first-class output. The right metrics are precision at accepted local parses, risk/coverage, fallback rate, and wrong-singular-answer rate.
- Data splits should hold out semantic families and surface forms. Random splits can overstate generalization, especially with synthetic templates.
- Router labels can be generated cheaply from repeated SLM predictions plus executor outcomes: stable correct outputs become `local_plan`, deterministic wins become `deterministic_only`, ambiguous cases become `clarify`, unstable/wrong cases become `escalate_llm`.
- If JSON remains annoying, consider a compact production/action DSL where the model emits typed operators and small enums, then deterministic code expands to full Plan-IR.

## Concrete Next Experiments

- Add a constrained decoding runner for compact Plan-IR using JSON schema or a small CFG, then compare validity/latency/accuracy against raw JSON generation.
- Create a Router-IR dataset from existing eval results and synthetic rows with labels: `deterministic_only`, `local_plan`, `clarify`, `escalate_llm`.
- Calibrate router thresholds on a holdout set and report risk/coverage curves, not only accuracy.
- Split eval reports by warm desktop, cold sporadic desktop, and shared hosted API profile.
- Add semantic-family holdouts for repeated relative chains, ambiguous weekdays, fuzzy clocks, direct epochs, and event-post extraction.

## Bottom Line

This is a reasonable ML technique, not overengineering by default. The less reasonable path would be treating a generic chat model as the whole solution. The research-backed version is a small semantic parser/router with a typed executable IR, constrained generation, deterministic execution, calibrated abstention, and LLM fallback for cases outside the local model's safe coverage.
