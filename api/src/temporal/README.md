# Temporal Coalescing API Skeleton

This folder contains the contracts for the planned LangGraph-backed temporal parsing flow.

The files are intentionally not wired into `src/index.ts` yet. The current endpoint should continue to behave as-is until the deterministic tools and validator are implemented.

Implementation order:

1. `types.ts`
2. `tools.ts`
3. deterministic tool implementations
4. `graph.ts` LangGraph implementation
5. endpoint integration
