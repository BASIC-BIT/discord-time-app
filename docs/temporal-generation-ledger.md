# Temporal Generation Ledger

Product analytics and generation capture are related but not the same thing.

- Product analytics answers aggregate questions: latency buckets, feature usage, fallback rate, success rate, and UI outcomes.
- The generation ledger records parser attempts so we can debug, replay, curate evals, and compare model/cascade versions.

PostHog or a similar analytics tool should consume aggregate events. The generation ledger should be a first-party data store with explicit retention and privacy policy.

## Goals

- Assign a generation ID to every parse request.
- Record the cascade stages and decisions without relying on ignored local reports.
- Measure cost, latency, accuracy proxies, fallback rate, clarification rate, and error classes.
- Support eval mining and future training-data curation.
- Keep raw user text out of remote analytics by default.

## Privacy Defaults

Desktop default:

- Keep raw text local-only unless the user opts into sharing diagnostics.
- Allow local generation history to be disabled.
- Store a text hash for deduplication when raw text is not retained.

API default:

- Do not retain raw request text by default.
- Store generation metadata, model/version data, stage outcomes, latency, and coarse failure classes.
- Raw text retention requires explicit product policy, customer-facing terms, retention duration, and deletion path.

Training-data ingestion:

- Requires a separate consent boundary from product analytics.
- Should record whether a row came from synthetic generation, local debugging, opted-in user feedback, or API diagnostic retention.
- Should preserve enough trace data to avoid training on incorrect final answers.

## Entities

### Generation

One row per parse request.

Fields:

- `generationId`
- `createdAt`
- `surface`: desktop, api, eval, smoke, internal
- `flowVersion`
- `appVersion`
- `requestTimeZone`
- `referenceInstant`
- `inputTextHash`
- `inputTextRetained`: boolean
- `inputText`: nullable, consent-gated
- `finalStatus`: resolved, needs_clarification, failed
- `finalMethod`: deterministic, agent+plan, agent+tools, fallback
- `finalEpoch`: nullable
- `candidateCount`
- `clarificationAlternativeCount`
- `totalDurationMs`
- `firstCorrectDisplayMs`: eval-only or when known
- `costMicros`: nullable
- `errorClass`: nullable

### Stage Attempt

One row per cascade stage attempt.

Fields:

- `attemptId`
- `generationId`
- `sequence`
- `stage`: authoritative_deterministic, slm_plan_ir, semantic_consistency_gate, strong_llm_generator
- `stageOutcome`: pass, fail, uncertain, error
- `resultStatus`: resolved, needs_clarification, failed, none
- `provider`
- `model`
- `adapter`
- `promptVersion`
- `endpoint`
- `durationMs`
- `firstTokenOrFirstResponseMs`: nullable
- `inputChars`
- `outputChars`
- `tokenUsage`: nullable JSON
- `costMicros`: nullable
- `reasonCodes`: JSON string array
- `errorClass`: nullable
- `errorMessageRedacted`: nullable

### Candidate

One row per candidate produced by a stage.

Fields:

- `candidateId`
- `generationId`
- `attemptId`
- `epoch`
- `isoInstant`
- `zonedDateTime`
- `timeZone`
- `precision`
- `provenance`
- `formatPreview`
- `executorValidationPassed`
- `executorWarnings`: JSON string array
- `semanticGateOutcome`: nullable

### User Outcome

One row per user-visible outcome after a parser response.

Fields:

- `outcomeId`
- `generationId`
- `createdAt`
- `action`: copied, inserted, dismissed, edited_before_copy, timeout, feedback_submitted
- `selectedCandidateId`: nullable
- `selectedFormatIndex`: nullable
- `feedbackCategory`: nullable
- `feedbackText`: nullable, consent-gated

## Analytics Derived From Ledger

Safe aggregate analytics can be emitted without raw text:

- parser availability
- p50/p95/p99 latency by stage and final method
- final status rate
- clarification rate
- fallback/escalation rate
- Semantic Consistency Gate reject/uncertain rate
- provider/model cost per 1k requests
- user action rate by final status and method
- eval failure classes by adapter/model version

## Implementation Sequence

1. Add `generationId` to parser responses and thread it through UI actions.
2. Add local SQLite-backed ledger tables for desktop/internal runs.
3. Record stage attempts from the existing graph trace and endpoint eval paths.
4. Add passive user outcome tracking in the desktop app.
5. Add active feedback UI with consent-gated optional text.
6. Emit aggregate analytics events only after privacy boundaries are documented.
7. Add export tooling that converts opted-in ledger rows into eval candidates, not directly into training rows.

## Implementation Status

- Implemented: parser responses include `generationId`.
- Implemented: local SQLite tables `temporal_generations` and `temporal_generation_outcomes`.
- Implemented: API parse requests write privacy-safe generation metadata with SHA-256 text hash and no retained raw text.
- Implemented: `/parse/outcome` accepts passive actions such as `copied` and `dismissed`.
- Implemented: desktop overlay keeps `generationId` from successful parses and clarification errors, then best-effort records `copied` or `dismissed`.
- Still planned: stage-attempt and candidate tables from graph traces.
- Still planned: active feedback UI and consent-gated optional feedback text.
- Still planned: export tooling for reviewed eval candidates.

## Non-Goals For First Implementation

- Do not ship raw-text remote analytics by default.
- Do not train from user feedback without review and curation.
- Do not add billing/user-account infrastructure just to store local desktop generation traces.
- Do not make PostHog the source of truth for replayable generation traces.
