import { createDeterministicTemporalToolImplementations } from './tools';
import { parseCalendarContext } from './deterministic';
import { runTemporalCoalescingGraph, type TemporalGraphOptions } from './graph';
import type { TemporalParseResponse } from './types';

export async function parseTemporalExpression(params: {
  text: string;
  timeZone: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiReasoningEffort?: string;
  langfuse?: TemporalGraphOptions['langfuse'];
  referenceInstant?: string;
}): Promise<TemporalParseResponse> {
  const implementations = createDeterministicTemporalToolImplementations();
  const options: TemporalGraphOptions = params.openaiApiKey === undefined
    ? { implementations }
    : { openaiApiKey: params.openaiApiKey, implementations };
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
