# Temporal Parser Prior Art

## Summary

- `chrono-node` is open source and deterministic: a TypeScript parser/refiner pipeline built from regex-style parsers and ordered refiners.
- Duckling is open source and mostly rule-engine based, with an additional generated Naive Bayes ranking/classifier layer trained from its corpus.
- `dateparser` is open source and deterministic/configuration-driven, with optional language detection hooks but no neural temporal parser core.
- The Temporal Plan-IR SLM differs by using a small fine-tuned model for fuzzy semantic normalization while deterministic code remains authoritative for calendar arithmetic and validation.

## chrono-node

- Project: [wanasit/chrono](https://github.com/wanasit/chrono), MIT license.
- README describes it as a JavaScript natural-language date parser with locale support, strict/casual modes, reference dates/time zones, and customization.
- Source shape: `Configuration` is an ordered list of `parsers` and `refiners`; each parser exposes `pattern(context): RegExp` and `extract(context, match)`, and refiners transform `ParsingResult[]`.
- Prior-art relevance: good deterministic baseline for normal and moderately casual English text. It is not designed to produce explicit clarification alternatives for every ambiguity, and customization means adding parser/refiner code.

## Duckling

- Project: [facebook/duckling](https://github.com/facebook/duckling), BSD-style license.
- README describes it as a Haskell library for parsing text into structured data, with dimensions like `Time`, `Duration`, `Numeral`, `AmountOfMoney`, and `Url`.
- Rule source shape: English time rules in `Duckling/Time/EN/Rules.hs` are composable Haskell `Rule` values with a `name`, `pattern`, and `prod` function. Examples include `this|next <day-of-week>`, `tomorrow`, `tonight`, `hh:mm`, `hhmm am|pm`, and named weekday/month regex rules.
- Corpus source shape: each dimension/language has corpus files with positive and negative examples.
- Ranking nuance: Duckling has a generated probabilistic layer. `exe/Duckling/Ranking/Train.hs` documents a Naive Bayes classifier with Laplace smoothing, trained one classifier per rule from the corpus.
- Prior-art relevance: strongest non-LLM prior art. It combines deterministic composable rules, corpora, tests, and lightweight statistical ranking. It is not an SLM/LoRA system and does not learn a compact executable temporal IR from user text.

## dateparser

- Project: [scrapinghub/dateparser](https://github.com/scrapinghub/dateparser), BSD-3-Clause license.
- Docs describe generic parsing of localized dates in over 200 language locales, relative dates, time zones, incomplete dates, non-Gregorian calendars, and date search in longer text.
- Pipeline source shape: default parsers are `timestamp`, `relative-time`, `custom-formats`, and `absolute-time`. `dateparser/date.py` iterates configured parsers for each applicable locale after sanitization/translation.
- It supports optional `detect_languages_function`, but this is for language detection/routing, not a neural temporal parser.
- Prior-art relevance: strong multilingual deterministic parser/configuration baseline, especially for web-scraped dates. It warns about false positives and recommends constraining languages/locales/settings to reduce them.

## Positioning Implication

The release claim should not be academic novelty. A stronger and more accurate claim is applied-system novelty for this product shape:

- Fine-tuned local SLM emits compact Plan-IR rather than epoch seconds.
- Deterministic executor computes and validates timestamps.
- Ambiguous cases can return multiple validated alternatives instead of a silent best guess.
- Dataset balance and executor-backed evals track wrong-singular-answer risk, not just parse coverage.
- Local serving can be cheaper and faster than general LLM calls for this narrow task.
