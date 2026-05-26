# Temporal Coalescing API

This folder contains the LangGraph-backed temporal parsing flow and deterministic fallback used by the API endpoint.

`src/index.ts` calls `parseTemporalExpression`, which uses deterministic temporal tools by default and the agent/tool graph when an OpenAI API key is configured.

Key files:

1. `types.ts`
2. `tools.ts`
3. deterministic tool implementations
4. `graph.ts` LangGraph implementation
5. endpoint integration
