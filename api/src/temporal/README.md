# Temporal Coalescing API Skeleton

This folder contains the contracts for the planned LangGraph-backed temporal parsing flow.

The files are intentionally not wired into `src/index.ts` yet. The current endpoint should continue to behave as-is until the deterministic tools and validator are implemented.

Implementation order:

1. `types.ts`
2. `policy.ts`
3. `tools.ts`
4. deterministic tool implementations
5. `graph.ts` LangGraph Functional API implementation
6. endpoint integration
