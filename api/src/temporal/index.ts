import { createDeterministicTemporalToolImplementations } from './tools';
import { parseCalendarContext } from './deterministic';
import { runTemporalCoalescingGraph } from './graph';
import type { TemporalParseResponse } from './types';

export async function parseTemporalExpression(params: {
  text: string;
  timeZone: string;
  openaiApiKey?: string;
  referenceInstant?: string;
}): Promise<TemporalParseResponse> {
  const implementations = createDeterministicTemporalToolImplementations();
  const options = params.openaiApiKey === undefined
    ? { implementations }
    : { openaiApiKey: params.openaiApiKey, implementations };
  return runTemporalCoalescingGraph(
    {
      text: params.text,
      calendarContext: parseCalendarContext(params.timeZone, params.referenceInstant),
    },
    options,
  );
}
