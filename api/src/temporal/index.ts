import { createDeterministicTemporalToolImplementations } from './tools';
import { parseCalendarContext } from './deterministic';
import { runTemporalCoalescingGraph, type TemporalGraphOptions } from './graph';
import type { TemporalFeatureFlags, TemporalModelCostConfig, TemporalParseResponse, TemporalPlanIrEndpointConfig } from './types';

export async function parseTemporalExpression(params: {
  text: string;
  timeZone: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiReasoningEffort?: string;
  langfuse?: TemporalGraphOptions['langfuse'];
  referenceInstant?: string;
  features?: TemporalFeatureFlags;
  planIrEndpoint?: TemporalPlanIrEndpointConfig;
  modelCost?: TemporalModelCostConfig;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<TemporalParseResponse> {
  const implementations = createDeterministicTemporalToolImplementations();
  const options: TemporalGraphOptions = params.openaiApiKey === undefined
    ? { implementations }
    : { openaiApiKey: params.openaiApiKey, implementations };
  if (params.features !== undefined) {
    options.features = params.features;
  }
  if (params.planIrEndpoint !== undefined) {
    options.planIrEndpoint = params.planIrEndpoint;
  }
  if (params.modelCost !== undefined) {
    options.modelCost = params.modelCost;
  }
  if (params.requestId !== undefined) {
    options.requestId = params.requestId;
  }
  if (params.signal !== undefined) {
    options.signal = params.signal;
  }
  if (params.openaiModel !== undefined && 'openaiApiKey' in options) {
    options.openaiModel = params.openaiModel;
  }
  if (params.openaiReasoningEffort !== undefined && 'openaiApiKey' in options) {
    options.openaiReasoningEffort = params.openaiReasoningEffort;
  }
  if (params.langfuse !== undefined && 'openaiApiKey' in options) {
    options.langfuse = params.langfuse;
  }
  return runTemporalCoalescingGraph(
    {
      text: params.text,
      calendarContext: parseCalendarContext(params.timeZone, params.referenceInstant),
    },
    options,
  );
}
