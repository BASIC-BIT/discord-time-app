# Temporal Coalescing V1

## Purpose

Replace the current single-pass LLM-normalize-then-parse flow with a small LangGraph-backed agent loop that can inspect calendar facts through tools, validate candidate timestamps, and return debuggable parse metadata.

The goal is not to remove LLM flexibility. The goal is to keep the model flexible while grounding final date/time math in explicit calendar tools.

## Current Problem

The current API flow asks the model to rewrite user text into parseable prose, then parses that prose once with `chrono-node`. That is fragile for relative dates, weekday qualifiers, timezone boundaries, and holidays.

Known failure classes:

- `next Wednesday` resolves to a Tuesday.
- `next Saturday` resolves to tomorrow when the user expects the following week.
- relative expressions resolve against server timezone instead of user timezone.
- missing times are guessed without clear policy.
- final output has no rich validation metadata.

## Design Goals

- Give the agent a small calendar toolbox, not just a text normalizer.
- Require every parse to have explicit calendar context.
- Make final timestamp candidates deterministic and inspectable.
- Support future event ingestion from Discord posts, posters, OCR text, and images.
- Keep sandbox and web lookup available as escape hatches, not default dependencies.

## Calendar Context

Every parse is anchored to a `CalendarContext`:

```ts
type CalendarContext = {
  referenceInstant: string;
  timeZone: string;
  locale?: string;
  country?: string;
  subdivision?: string;
};
```

Rules:

- `referenceInstant` is always explicit.
- `timeZone` is always explicit.
- `locale`, `country`, and `subdivision` are optional but useful for holiday and formatting behavior.
- Tools must not silently fall back to the server timezone.

## LangGraph Shape

Use idiomatic LangGraph JS tool-calling primitives for v1.

The implementation should use:

- `tool(...)` from `@langchain/core/tools`
- Zod schemas for tool inputs
- `model.bindTools(...)`
- `ToolNode` from `@langchain/langgraph/prebuilt`
- `StateGraph` when stateful candidate gating matters

The existing `api/src/temporal/tools.ts` file is an implementation contract, not the final LangGraph tool definition layer. The eventual LangGraph adapter should wrap those implementations in LangChain tools.

Example shape:

```ts
const parseExpressionTool = tool(async (input) => implementations.parseExpression(input), {
  name: "parse_expression",
  description: "Generate candidate date/time interpretations from user text.",
  schema: z.object({
    text: z.string(),
    calendarContext: CalendarContextSchema,
  }),
});

const modelWithTools = model.bindTools(availableToolsForState(state));
const toolNode = new ToolNode(availableToolsForState(state));
```

Use dynamic tool availability for the candidate gate. `finalize_candidate` should not be exposed until state contains at least one enriched candidate.

The graph should still be small:

1. `preflight`
2. `agent_step`
3. `tool_node`
4. `candidate_enrichment_step`
5. `validation_step`
6. `finalize`

Stop conditions:

- candidate validates successfully
- agent asks for clarification
- max attempts reached
- tool result is invalid or unsafe

Suggested limits:

- max 3 agent attempts
- max 10 tool batches
- fail closed when confidence is low

## Candidate Gate

The agent should not be able to finalize an arbitrary timestamp in one step.

Instead, finalization is gated:

1. The agent proposes a candidate timestamp.
2. The graph records that candidate in state.
3. The graph automatically enriches the candidate with facts and formatted previews.
4. The graph validates the enriched candidate.
5. The agent receives the enriched candidate and validation feedback.
6. The agent may either propose another candidate or finalize one previously proposed candidate.

The finalization action must only accept an existing candidate ID from graph state. If the agent tries to finalize a timestamp that was not previously proposed and enriched, the graph should reject it.

This gives the model calendar intuition without trusting unsupported freehand answers.

## Tool Catalog

Agent-facing tools should stay broad and few. Internal graph nodes should handle predictable enrichment and validation work automatically.

### `parse_expression`

Broad candidate generation from user text.

Expected implementation:

- strict ISO / Discord timestamp detection
- `chrono-node` for broad natural language parsing
- custom refiners for product-specific weekday semantics

### `resolve_calendar_query`

Broad deterministic calendar lookup.

This is the preferred agent-facing tool instead of many narrowly-scoped tools.

Expected implementation:

- resolve holiday phrases when supported
- resolve weekday phrases when supported
- return candidate dates plus source notes
- use product policy internally where applicable

### Internal weekday policy

The system still needs explicit semantics for `this`, `next`, `last`, and bare weekday expressions, but that does not need to be a first-class agent tool.

Product policy should be explicit and tested:

- bare weekday means the nearest upcoming occurrence
- `this <weekday>` means the current week frame
- `next <weekday>` means the following week frame, not tomorrow when tomorrow is that weekday
- `last <weekday>` means the previous week frame

### Internal holiday resolution

Resolves standard holidays like Easter, Thanksgiving, Good Friday, Mardi Gras, and substitute holidays.

This can live behind `resolve_calendar_query` unless experience shows that a specialized holiday tool is useful.

Expected implementation:

- use a deterministic holiday library where possible
- use local algorithms for well-known computable holidays when useful
- use web lookup only for non-standard external event facts

### `shift_datetime`

Applies relative date math in timezone-aware fashion.

Expected implementation:

- `@js-temporal/polyfill`
- preserve timezone semantics across DST boundaries

### `propose_candidate`

Agent action for saying, "this is the timestamp I currently believe is correct."

The graph must not treat this as final. It records the candidate and then runs automatic enrichment.

### `finalize_candidate`

Agent action for accepting a previously proposed candidate.

The graph only accepts candidate IDs that already exist in state and have gone through enrichment.

This tool should only be bound after at least one candidate is finalizable.

### Internal `format_candidate`

Formats a candidate back into human-readable text so the agent can sanity-check it.

This can be called automatically by the graph after `propose_candidate` instead of forcing the agent to ask for it.

### Internal `candidate_facts`

Returns facts like weekday, ISO date, week number, month, year, and timezone for a candidate.

This should also be called automatically by the graph after `propose_candidate`.

### `validate_candidate`

Deterministically validates one candidate against the original input and calendar context.

Checks include:

- weekday agreement
- qualifier agreement
- timezone correctness
- precision agreement
- DST ambiguity
- round-trip readability

### `sandbox_eval`

Optional fallback for rare one-off calculation experiments.

This should not be required for ordinary weekday math, holiday math, timezone arithmetic, or timestamp formatting.

### `web_lookup`

Optional fallback for external facts.

Use for event-specific or venue-specific information, not standard calendar math.

## Response Contract

The parse endpoint should eventually return more than an epoch:

```ts
type TemporalParseResponse = {
  status: "resolved" | "ambiguous" | "needs_clarification" | "failed";
  epoch?: number;
  suggestedFormatIndex?: number;
  confidence: number;
  method:
    | "deterministic"
    | "agent+tools"
    | "agent+tools+sandbox"
    | "agent+tools+web"
    | "fallback";
  canonical?: {
    isoInstant: string;
    zonedDateTime: string;
    timeZone: string;
    precision: "date" | "time" | "datetime" | "relative";
    weekday?: string;
  };
  assumptions: string[];
  ambiguity: string[];
  validation: {
    passed: boolean;
    warnings: string[];
    checks: string[];
  };
  clarificationQuestion?: string;
};
```

## Implementation Plan

1. Add temporal contracts and tool skeletons under `api/src/temporal/`.
2. Implement candidate facts and formatting first.
3. Add candidate proposal and finalization gates.
4. Implement deterministic validation.
5. Implement weekday policy and tests behind the calendar resolver.
6. Replace prose normalization with LangGraph tool calls.
7. Add a LangGraph `StateGraph` with `ToolNode`, dynamic tool binding, and up to 10 tool batches.
8. Add holiday resolution behind the generic calendar resolver.
9. Consider sandbox and web lookup as optional fallback tools.

## Observability

Add Langfuse once the loop is wired in.

Langfuse integrates with LangChain/LangGraph through LangChain callbacks. The graph invocation can pass a callback handler so LLM calls, tool calls, retries, and validation loops are traceable.

Initial trace metadata should include:

- user timezone
- input length
- selected candidate ID
- candidate count
- tool pass count
- final status
- validation warnings

## Reuse Plan

Keep this repo-local first.

Once used by both HammerOverlay and a second event-ingest workflow, promote the durable pieces into the shared toolbox:

- an OpenCode skill named `temporal-coalescing`
- shared docs in `basics-agentic-dogfooding`
- optionally a shared package if the code shape stabilizes
