import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { END, MessagesAnnotation, StateGraph, START } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import * as z from 'zod';
import type { AgentDecision, CalendarContext, Candidate, EnrichedCandidate, TemporalParseRequest, TemporalParseResponse } from './types';
import type { TemporalToolImplementations } from './tools';
import { candidateFromProposal, candidateToEpoch } from './deterministic';

export const DEFAULT_TEMPORAL_GRAPH_LIMITS = {
  maxAgentAttempts: 3,
  maxToolPasses: 10,
} as const;

const CalendarContextSchema = z.object({
  referenceInstant: z.string(),
  timeZone: z.string(),
  locale: z.string().optional(),
  country: z.string().optional(),
  subdivision: z.string().optional(),
});

export interface TemporalGraphState {
  request: TemporalParseRequest;
  agentAttempts: number;
  toolPasses: number;
  candidates: EnrichedCandidate[];
  finalizableCandidateIds: string[];
  decisions: AgentDecision[];
  validationFeedback: string[];
}

export interface TemporalGraphOptions {
  maxAgentAttempts?: number;
  maxToolPasses?: number;
  openaiApiKey?: string;
  implementations: TemporalToolImplementations;
}

export function createInitialTemporalGraphState(request: TemporalParseRequest): TemporalGraphState {
  return {
    request,
    agentAttempts: 0,
    toolPasses: 0,
    candidates: [],
    finalizableCandidateIds: [],
    decisions: [],
    validationFeedback: [],
  };
}

export async function runTemporalCoalescingGraph(
  request: TemporalParseRequest,
  options: TemporalGraphOptions,
): Promise<TemporalParseResponse> {
  const fallback = await deterministicParse(request, options.implementations);
  if (!options.openaiApiKey) {
    return fallback;
  }

  const maxToolPasses = options.maxToolPasses ?? DEFAULT_TEMPORAL_GRAPH_LIMITS.maxToolPasses;

  try {
    const agentResult = await runAgentGraph(request, options, maxToolPasses);
    if (agentResult) {
      return agentResult;
    }
  } catch (error) {
    return {
      ...fallback,
      method: fallback.method === 'deterministic' ? 'fallback' : fallback.method,
      validation: {
        ...fallback.validation,
        warnings: [...fallback.validation.warnings, `Agent graph failed; used deterministic fallback: ${errorMessage(error)}`],
      },
    };
  }

  return fallback;
}

async function runAgentGraph(
  request: TemporalParseRequest,
  options: TemporalGraphOptions,
  maxToolPasses: number,
): Promise<TemporalParseResponse | null> {
  if (!options.openaiApiKey) {
    return null;
  }

  const enrichedCandidates = new Map<string, EnrichedCandidate>();
  let finalizedCandidateId: string | null = null;
  let finalizedRationale = '';

  const parseExpressionTool = tool(
    async (input) => JSON.stringify(await options.implementations.parseExpression({
      text: input.text,
      calendarContext: toCalendarContext(input.calendarContext),
    })),
    {
      name: 'parse_expression',
      description: 'Generate candidate date/time interpretations from user text using deterministic parsing.',
      schema: z.object({ text: z.string(), calendarContext: CalendarContextSchema }),
    },
  );

  const resolveCalendarQueryTool = tool(
    async (input) => JSON.stringify(await options.implementations.resolveCalendarQuery({
      query: input.query,
      calendarContext: toCalendarContext(input.calendarContext),
    })),
    {
      name: 'resolve_calendar_query',
      description: 'Resolve a broad calendar query, including weekday phrases or known calendar expressions, into candidates.',
      schema: z.object({ query: z.string(), calendarContext: CalendarContextSchema }),
    },
  );

  const shiftDateTimeTool = tool(
    async (input) => JSON.stringify(await options.implementations.shiftDateTime({
      base: input.base,
      delta: cleanDelta(input.delta),
      calendarContext: toCalendarContext(input.calendarContext),
    })),
    {
      name: 'shift_datetime',
      description: 'Apply timezone-aware date/time arithmetic to a base instant, date, or zoned date-time.',
      schema: z.object({
        base: z.union([
          z.object({ isoInstant: z.string() }),
          z.object({ plainDate: z.string(), timeZone: z.string() }),
          z.object({ zonedDateTime: z.string() }),
        ]),
        delta: z.object({
          years: z.number().optional(),
          months: z.number().optional(),
          weeks: z.number().optional(),
          days: z.number().optional(),
          hours: z.number().optional(),
          minutes: z.number().optional(),
        }),
        calendarContext: CalendarContextSchema,
      }),
    },
  );

  const proposeCandidateTool = tool(
    async (input) => {
      const isoInstant = input.isoInstant ?? epochSecondsToIso(input.epochSeconds);
      const candidate = candidateFromProposal({
        isoInstant,
        timeZone: input.timeZone ?? request.calendarContext.timeZone,
        precision: input.precision,
        assumptions: input.assumptions,
      });
      const enriched = await enrichCandidate(candidate, request, options.implementations);
      enrichedCandidates.set(enriched.candidate.id, enriched);
      return JSON.stringify(enriched);
    },
    {
      name: 'propose_candidate',
      description: 'Propose a candidate timestamp. The graph will enrich and validate it; this does not finalize the answer.',
      schema: z.object({
        isoInstant: z.string().optional(),
        epochSeconds: z.number().optional(),
        timeZone: z.string().optional(),
        precision: z.enum(['date', 'time', 'datetime', 'relative']),
        assumptions: z.array(z.string()).default([]),
        rationale: z.string(),
      }).refine((value) => value.isoInstant !== undefined || value.epochSeconds !== undefined, {
        message: 'Either isoInstant or epochSeconds is required.',
      }),
    },
  );

  const finalizeCandidateTool = tool(
    async (input) => {
      const candidate = enrichedCandidates.get(input.candidateId);
      if (!candidate || !candidate.finalizable) {
        return JSON.stringify({ accepted: false, error: 'Candidate must be proposed, enriched, and validation-passing before finalization.' });
      }
      finalizedCandidateId = input.candidateId;
      finalizedRationale = input.rationale;
      return JSON.stringify({ accepted: true, candidate });
    },
    {
      name: 'finalize_candidate',
      description: 'Finalize one candidate that was previously proposed and validated. Only use candidate IDs returned by propose_candidate.',
      schema: z.object({ candidateId: z.string(), rationale: z.string() }),
    },
  );

  const tools = [
    parseExpressionTool,
    resolveCalendarQueryTool,
    shiftDateTimeTool,
    proposeCandidateTool,
    finalizeCandidateTool,
  ];
  const model = new ChatOpenAI({ apiKey: options.openaiApiKey, model: 'gpt-4o-mini', temperature: 0 });
  const modelWithTools = model.bindTools(tools);

  const llmCall = async (state: typeof MessagesAnnotation.State) => {
    const result = await modelWithTools.invoke([new SystemMessage(systemPrompt(request)), ...state.messages]);
    return { messages: [result] };
  };
  const toolNode = new ToolNode(tools);
  const shouldContinue = (state: typeof MessagesAnnotation.State) => {
    const lastMessage = state.messages.at(-1);
    if (finalizedCandidateId) {
      return END;
    }
    if (countToolMessages(state.messages) >= maxToolPasses) {
      return END;
    }
    if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
      return 'toolNode';
    }
    return END;
  };
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('llmCall', llmCall)
    .addNode('toolNode', toolNode)
    .addEdge(START, 'llmCall')
    .addConditionalEdges('llmCall', shouldContinue, ['toolNode', END])
    .addEdge('toolNode', 'llmCall')
    .compile();

  const finalState = await graph.invoke({ messages: [new HumanMessage(userPrompt(request))] });
  const toolPasses = countToolMessages(finalState.messages);
  const agentAttempts = countAgentMessages(finalState.messages);

  if (!finalizedCandidateId) {
    return null;
  }

  const finalized = enrichedCandidates.get(finalizedCandidateId);
  if (!finalized) {
    return null;
  }

  return responseFromEnrichedCandidate(finalized, 'agent+tools', 0.9, finalizedRationale, enrichedCandidates.size, toolPasses, agentAttempts);
}

async function deterministicParse(
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
): Promise<TemporalParseResponse> {
  const parsed = await implementations.parseExpression({ text: request.text, calendarContext: request.calendarContext });
  const candidate = parsed.candidates[0];
  if (!candidate) {
    return {
      status: 'failed',
      confidence: 0,
      method: 'fallback',
      assumptions: [],
      ambiguity: [],
      validation: { passed: false, warnings: parsed.parserNotes, checks: [] },
      debug: { candidateCount: 0 },
    };
  }

  const enriched = await enrichCandidate(candidate, request, implementations);
  return responseFromEnrichedCandidate(enriched, 'deterministic', 0.75, 'Deterministic temporal parse.', 1, 0, 0);
}

async function enrichCandidate(
  candidate: Candidate,
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
): Promise<EnrichedCandidate> {
  const [facts, shortFormat, fullFormat, weekdayFormat, discordFormat, validation] = await Promise.all([
    implementations.candidateFacts({ candidate, calendarContext: request.calendarContext }),
    implementations.formatCandidate({ candidate, calendarContext: request.calendarContext, style: 'short' }),
    implementations.formatCandidate({ candidate, calendarContext: request.calendarContext, style: 'full' }),
    implementations.formatCandidate({ candidate, calendarContext: request.calendarContext, style: 'weekday-check' }),
    implementations.formatCandidate({ candidate, calendarContext: request.calendarContext, style: 'discord-preview' }),
    implementations.validateCandidate({ originalText: request.text, candidate, calendarContext: request.calendarContext }),
  ]);

  return {
    candidate,
    facts,
    formats: [
      { style: 'short', formatted: shortFormat },
      { style: 'full', formatted: fullFormat },
      { style: 'weekday-check', formatted: weekdayFormat },
      { style: 'discord-preview', formatted: discordFormat },
    ],
    validation: {
      passed: validation.passed,
      warnings: [...validation.warnings, ...validation.errors, ...validation.ambiguity],
      checks: ['candidate_facts', 'format_candidate', 'validate_candidate'],
    },
    finalizable: validation.passed,
  };
}

function responseFromEnrichedCandidate(
  enriched: EnrichedCandidate,
  method: TemporalParseResponse['method'],
  confidence: number,
  rationale: string,
  candidateCount: number,
  toolPasses: number,
  agentAttempts: number,
): TemporalParseResponse {
  const validation = enriched.validation ?? { passed: false, warnings: ['Candidate was not validated.'], checks: [] };
  const canonical: NonNullable<TemporalParseResponse['canonical']> = {
    isoInstant: enriched.candidate.isoInstant,
    zonedDateTime: enriched.candidate.zonedDateTime,
    timeZone: enriched.candidate.timeZone,
    precision: enriched.candidate.precision,
  };
  if (enriched.facts !== undefined) {
    canonical.weekday = enriched.facts.weekday;
  }
  const response: TemporalParseResponse = {
    status: validation.passed ? 'resolved' : 'ambiguous',
    epoch: candidateToEpoch(enriched.candidate),
    suggestedFormatIndex: suggestedFormatIndex(enriched.candidate.precision),
    confidence: validation.passed ? confidence : Math.min(confidence, 0.4),
    method,
    canonical,
    assumptions: rationale ? [...enriched.candidate.assumptions, rationale] : enriched.candidate.assumptions,
    ambiguity: validation.passed ? [] : validation.warnings,
    validation,
    debug: { chosenCandidateId: enriched.candidate.id, candidateCount, agentAttempts, toolPasses },
  };

  return response;
}

function systemPrompt(request: TemporalParseRequest): string {
  return `You are a precise temporal coalescing agent. Your job is to convert fuzzy user time text into one correct timestamp.

Rules:
- Use tools for calendar facts and parsing; do not rely on memory for weekday math.
- Prefer parse_expression or resolve_calendar_query first.
- For holidays, always use parse_expression or resolve_calendar_query and trust holiday_library candidates; do not propose holiday dates from memory.
- You must call propose_candidate before finalize_candidate.
- Only finalize candidate IDs returned by propose_candidate.
- If the user mentions a weekday, use tool output and formatted candidate facts to verify the proposed timestamp actually lands on that weekday.
- If validation rejects a candidate, try another candidate or stop.
- Keep assumptions explicit.

Calendar context:
${JSON.stringify(request.calendarContext)}`;
}

function userPrompt(request: TemporalParseRequest): string {
  return `Resolve this time expression into one timestamp: ${request.text}`;
}

function countToolMessages(messages: BaseMessage[]): number {
  return messages.filter((message) => message.getType() === 'tool').length;
}

function countAgentMessages(messages: BaseMessage[]): number {
  return messages.filter((message) => message.getType() === 'ai').length;
}

function suggestedFormatIndex(precision: Candidate['precision']): number {
  if (precision === 'date') {
    return 1;
  }
  if (precision === 'time') {
    return 2;
  }
  if (precision === 'relative') {
    return 6;
  }
  return 4;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCalendarContext(input: z.infer<typeof CalendarContextSchema>): CalendarContext {
  const calendarContext: CalendarContext = {
    referenceInstant: input.referenceInstant,
    timeZone: input.timeZone,
  };
  if (input.locale !== undefined) {
    calendarContext.locale = input.locale;
  }
  if (input.country !== undefined) {
    calendarContext.country = input.country;
  }
  if (input.subdivision !== undefined) {
    calendarContext.subdivision = input.subdivision;
  }
  return calendarContext;
}

function cleanDelta(input: {
  years?: number | undefined;
  months?: number | undefined;
  weeks?: number | undefined;
  days?: number | undefined;
  hours?: number | undefined;
  minutes?: number | undefined;
}): { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number } {
  const delta: { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number } = {};
  if (input.years !== undefined) {
    delta.years = input.years;
  }
  if (input.months !== undefined) {
    delta.months = input.months;
  }
  if (input.weeks !== undefined) {
    delta.weeks = input.weeks;
  }
  if (input.days !== undefined) {
    delta.days = input.days;
  }
  if (input.hours !== undefined) {
    delta.hours = input.hours;
  }
  if (input.minutes !== undefined) {
    delta.minutes = input.minutes;
  }
  return delta;
}

function epochSecondsToIso(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined) {
    throw new Error('Either isoInstant or epochSeconds is required.');
  }
  return new Date(epochSeconds * 1000).toISOString();
}
