import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { END, MessagesAnnotation, StateGraph, START } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { Temporal } from '@js-temporal/polyfill';
import * as z from 'zod';
import type { AgentDecision, CalendarContext, Candidate, EnrichedCandidate, TemporalAgentContext, TemporalClarificationAlternative, TemporalAgentTraceStep, TemporalFinalValidation, TemporalParseRequest, TemporalParseResponse } from './types';
import type { TemporalToolImplementations } from './tools';
import { candidateFromProposal, candidateToEpoch, collectTemporalAgentContext } from './deterministic';

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_OPENAI_REASONING_EFFORT = 'low';

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

const WEEKDAY_TEXT_PATTERN = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const TimeOfDaySchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const AgentBaseDateTimeSchema = z.union([
  z.object({ candidateId: z.string() }),
  z.object({ isoInstant: z.string() }),
  z.object({ plainDate: z.string(), timeZone: z.string() }),
  z.object({ zonedDateTime: z.string() }),
]);

const FinalValidationSchema = z.object({
  accepted: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  missingOrContradictedSignals: z.array(z.string()).default([]),
});

type LangfuseHandler = BaseCallbackHandler & { last_trace_id: string | null };

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
  openaiModel?: string;
  openaiReasoningEffort?: string;
  langfuse?: {
    enabled: boolean;
    sessionId?: string;
    userId?: string;
    baseUrl?: string;
    tags?: string[];
  };
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
  const totalStartedAt = nowMs();
  const fallback = await deterministicParse(request, options.implementations);
  if (!options.openaiApiKey) {
    attachTopLevelTiming(fallback, totalStartedAt);
    return fallback;
  }

  const maxToolPasses = options.maxToolPasses ?? DEFAULT_TEMPORAL_GRAPH_LIMITS.maxToolPasses;
  const agentStartedAt = nowMs();

  try {
    const agentResult = await runAgentGraph(request, options, maxToolPasses);
    if (agentResult) {
      attachTopLevelTiming(agentResult, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt));
      return agentResult;
    }
  } catch (error) {
    const response: TemporalParseResponse = {
      ...fallback,
      method: fallback.method === 'deterministic' ? 'fallback' : fallback.method,
      validation: {
        ...fallback.validation,
        warnings: [...fallback.validation.warnings, `Agent graph failed; used deterministic fallback: ${errorMessage(error)}`],
      },
    };
    attachTopLevelTiming(response, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt));
    return response;
  }

  attachTopLevelTiming(fallback, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt));
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
  const agentProposedCandidateIds = new Set<string>();
  const agentGraphStartedAt = nowMs();
  const modelName = options.openaiModel ?? DEFAULT_OPENAI_MODEL;
  const reasoningEffort = options.openaiReasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
  let firstLlmResponseMs: number | undefined;
  let firstCandidateMs: number | undefined;
  let finalizedCandidateId: string | null = null;
  let finalizedRationale = '';
  const clarificationResponseRef: { current: TemporalParseResponse | null } = { current: null };
  const trace: TemporalAgentTraceStep[] = [];
  const agentContext = collectTemporalAgentContext(request);
  const langfuseHandler = await createLangfuseHandler(options, request);
  const callbacks = langfuseHandler === null ? undefined : [langfuseHandler];

  const recordTool = (name: string, input: unknown, output: unknown, startedAt: number) => {
    trace.push({ index: trace.length + 1, type: 'tool', name, durationMs: elapsedMs(startedAt), input: summarizeValue(input), output: summarizeValue(output) });
  };
  const markCandidate = () => {
    firstCandidateMs ??= elapsedMs(agentGraphStartedAt);
  };
  const attachAgentDebug = (response: TemporalParseResponse) => {
    response.debug = response.debug ?? {};
    response.debug.model = modelName;
    response.debug.reasoningEffort = reasoningEffort;
    if (firstLlmResponseMs !== undefined) {
      response.debug.firstLlmResponseMs = firstLlmResponseMs;
    }
    if (firstCandidateMs !== undefined) {
      response.debug.firstCandidateMs = firstCandidateMs;
    }
    response.debug.finalResponseMs = elapsedMs(agentGraphStartedAt);
  };

  const parseExpressionTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const parsed = await options.implementations.parseExpression({
        text: input.text,
        calendarContext: toCalendarContext(input.calendarContext),
      });
      const enriched = await Promise.all(parsed.candidates.map((candidate) => enrichCandidate(candidate, request, options.implementations)));
      if (enriched.length > 0) {
        markCandidate();
      }
      for (const candidate of enriched) {
        enrichedCandidates.set(candidate.candidate.id, candidate);
      }
      const output = { ...parsed, candidates: enriched };
      recordTool('parse_expression', input, output, startedAt);
      return JSON.stringify(output);
    },
    {
      name: 'parse_expression',
      description: 'Generate, enrich, and validate candidate date/time interpretations from user text using deterministic parsing.',
      schema: z.object({ text: z.string(), calendarContext: CalendarContextSchema }),
    },
  );

  const resolveCalendarQueryTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const resolved = await options.implementations.resolveCalendarQuery({
        query: input.query,
        calendarContext: toCalendarContext(input.calendarContext),
      });
      const enriched = await Promise.all(resolved.candidates.map((candidate) => enrichCandidate(candidate, request, options.implementations)));
      if (enriched.length > 0) {
        markCandidate();
      }
      for (const candidate of enriched) {
        enrichedCandidates.set(candidate.candidate.id, candidate);
      }
      const output = { ...resolved, candidates: enriched };
      recordTool('resolve_calendar_query', input, output, startedAt);
      return JSON.stringify(output);
    },
    {
      name: 'resolve_calendar_query',
      description: 'Resolve a broad calendar query, including weekday phrases or known calendar expressions, into candidates.',
      schema: z.object({ query: z.string(), calendarContext: CalendarContextSchema }),
    },
  );

  const resolveHolidayTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const holidayInput: Parameters<TemporalToolImplementations['resolveHoliday']>[0] = {
        holidayName: input.holidayName,
        calendarContext: toCalendarContext(input.calendarContext),
      };
      if (input.year !== undefined) {
        holidayInput.year = input.year;
      }
      if (input.time !== undefined) {
        holidayInput.time = input.time;
      }

      const resolved = await options.implementations.resolveHoliday(holidayInput);
      const enriched = await Promise.all(resolved.candidates.map((candidate) => enrichCandidate(candidate, request, options.implementations)));
      if (enriched.length > 0) {
        markCandidate();
      }
      for (const candidate of enriched) {
        enrichedCandidates.set(candidate.candidate.id, candidate);
      }
      const output = { ...resolved, candidates: enriched };
      recordTool('resolve_holiday', input, output, startedAt);
      return JSON.stringify(output);
    },
    {
      name: 'resolve_holiday',
      description: 'Resolve a named holiday from calendar data. Use this for holiday expressions; do not propose holiday dates from memory.',
      schema: z.object({
        holidayName: z.string(),
        year: z.number().int().min(1900).max(2200).optional(),
        time: TimeOfDaySchema.optional(),
        calendarContext: CalendarContextSchema,
      }),
    },
  );

  const resolveClockTimeTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const output = await options.implementations.resolveClockTime({
        text: input.text,
        calendarContext: toCalendarContext(input.calendarContext),
      });
      recordTool('resolve_clock_time', input, output, startedAt);
      return JSON.stringify(output);
    },
    {
      name: 'resolve_clock_time',
      description: 'Parse explicit conventional clock-time text such as noon, midnight, 13:37, or 1:37pm into 24-hour time candidates.',
      schema: z.object({ text: z.string(), calendarContext: CalendarContextSchema }),
    },
  );

  const shiftDateTimeTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const candidate = await options.implementations.shiftDateTime({
        base: resolveAgentBase(input.base, enrichedCandidates),
        delta: cleanDelta(input.delta),
        ...(input.time === undefined ? {} : { time: input.time }),
        calendarContext: toCalendarContext(input.calendarContext),
      });
      const enriched = await enrichCandidate(candidate, request, options.implementations);
      markCandidate();
      enrichedCandidates.set(enriched.candidate.id, enriched);
      recordTool('shift_datetime', input, enriched, startedAt);
      return JSON.stringify(enriched);
    },
    {
      name: 'shift_datetime',
      description: 'Apply timezone-aware date/time arithmetic to a base instant, date, or zoned date-time. If a normalized clock time is already known, include time to set it on the shifted date in the same tool call.',
      schema: z.object({
        base: AgentBaseDateTimeSchema,
        delta: z.object({
          years: z.number().optional(),
          months: z.number().optional(),
          weeks: z.number().optional(),
          days: z.number().optional(),
          hours: z.number().optional(),
          minutes: z.number().optional(),
        }),
        time: TimeOfDaySchema.optional(),
        calendarContext: CalendarContextSchema,
      }),
    },
  );

  const setClockTimeTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const candidate = await options.implementations.setClockTime({
        base: resolveAgentBase(input.base, enrichedCandidates),
        time: input.time,
        calendarContext: toCalendarContext(input.calendarContext),
      });
      const enriched = await enrichCandidate(candidate, request, options.implementations);
      markCandidate();
      enrichedCandidates.set(enriched.candidate.id, enriched);
      recordTool('set_clock_time', input, enriched, startedAt);
      return JSON.stringify(enriched);
    },
    {
      name: 'set_clock_time',
      description: 'Apply a normalized 24-hour clock time to the date from a candidate, instant, plain date, or zoned date-time.',
      schema: z.object({
        base: AgentBaseDateTimeSchema,
        time: TimeOfDaySchema,
        calendarContext: CalendarContextSchema,
      }),
    },
  );

  const proposeCandidateTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const isoInstant = input.isoInstant ?? epochSecondsToIso(input.epochSeconds);
      const candidate = candidateFromProposal({
        isoInstant,
        timeZone: input.timeZone ?? request.calendarContext.timeZone,
        precision: input.precision,
        assumptions: input.assumptions,
      });
      const enriched = await enrichCandidate(candidate, request, options.implementations);
      markCandidate();
      enrichedCandidates.set(enriched.candidate.id, enriched);
      agentProposedCandidateIds.add(enriched.candidate.id);
      recordTool('propose_candidate', input, enriched, startedAt);
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
      const startedAt = nowMs();
      const candidate = enrichedCandidates.get(input.candidateId);
      if (!candidate || !candidate.finalizable) {
        const output = { accepted: false, error: 'Candidate must be proposed or resolved by a tool, enriched, and validation-passing before finalization.' };
        recordTool('finalize_candidate', input, output, startedAt);
        return JSON.stringify(output);
      }
      finalizedCandidateId = input.candidateId;
      finalizedRationale = input.rationale;
      const output = { accepted: true, candidate };
      recordTool('finalize_candidate', input, output, startedAt);
      return JSON.stringify(output);
    },
    {
      name: 'finalize_candidate',
      description: 'Finalize one candidate that was previously proposed or resolved by a tool and validated. Only use candidate IDs returned by tool output.',
      schema: z.object({ candidateId: z.string(), rationale: z.string() }),
    },
  );

  const askClarificationTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const alternatives = input.alternatives
        .map((alternative) => {
          const enriched = enrichedCandidates.get(alternative.candidateId);
          if (!enriched || !canUseForClarification(enriched)) {
            return null;
          }
          return alternativeFromEnrichedCandidate(
            conciseClarificationLabel(alternative.label, enriched),
            enriched,
            'agent+tools',
            0.8,
            request.text,
          );
        })
        .filter((alternative): alternative is TemporalClarificationAlternative => alternative !== null);
      const output = alternatives.length === input.alternatives.length
        ? { accepted: true, question: input.question, alternatives }
        : { accepted: false, error: 'All clarification alternatives must reference existing usable candidate IDs.' };
      recordTool('ask_clarification', input, output, startedAt);
      if (output.accepted) {
        clarificationResponseRef.current = {
          status: 'needs_clarification',
          confidence: 0,
          method: 'agent+tools',
          assumptions: [],
          ambiguity: [input.rationale],
          validation: {
            passed: false,
            warnings: [input.rationale],
            checks: ['agent_clarification'],
          },
          clarificationQuestion: input.question,
          clarificationAlternatives: alternatives,
          debug: { candidateCount: enrichedCandidates.size, agentAttempts: 0, toolPasses: 0, trace },
        };
      }
      return JSON.stringify(output);
    },
    {
      name: 'ask_clarification',
      description: 'Ask the user to choose between one or more plausible timestamp candidates. Only use candidate IDs returned by previous candidate-producing tools. Labels should be short choice text, not full formatted dates. Candidates can be validation-passing or candidates whose only validation issue is the ambiguity being clarified.',
      schema: z.object({
        question: z.string(),
        rationale: z.string(),
        alternatives: z.array(z.object({
          label: z.string(),
          candidateId: z.string(),
        })).min(1),
      }),
    },
  );

  const tools = [
    parseExpressionTool,
    resolveCalendarQueryTool,
    resolveHolidayTool,
    resolveClockTimeTool,
    shiftDateTimeTool,
    setClockTimeTool,
    proposeCandidateTool,
    finalizeCandidateTool,
    askClarificationTool,
  ];
  const model = createChatModel(options.openaiApiKey, modelName, reasoningEffort);
  const modelWithTools = model.bindTools(tools, { parallel_tool_calls: true });

  const llmCall = async (state: typeof MessagesAnnotation.State) => {
    const startedAt = nowMs();
    const system = systemPrompt(request, agentContext);
    const messages = [new SystemMessage(system), ...state.messages];
    const result = await modelWithTools.invoke(messages, callbacks === undefined ? undefined : { callbacks });
    firstLlmResponseMs ??= elapsedMs(agentGraphStartedAt);
    trace.push({
      index: trace.length + 1,
      type: 'llm',
      name: 'agent',
      durationMs: elapsedMs(startedAt),
      input: {
        messageCount: messages.length,
        systemPromptChars: system.length,
        totalMessageChars: messageContentChars(messages),
      },
      output: summarizeAiMessage(result),
    });
    return { messages: [result] };
  };
  const toolNode = new ToolNode(tools);
  const shouldContinue = (state: typeof MessagesAnnotation.State) => {
    const lastMessage = state.messages.at(-1);
    if (finalizedCandidateId || clarificationResponseRef.current) {
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

  const finalState = await graph.invoke(
    { messages: [new HumanMessage(userPrompt(request))] },
    callbacks === undefined
      ? undefined
      : {
          callbacks,
          runName: 'temporal-coalescing-graph',
          tags: ['temporal-parse'],
          metadata: {
            model: modelName,
            timeZone: request.calendarContext.timeZone,
          },
        },
  );
  const toolPasses = countToolMessages(finalState.messages);
  const agentAttempts = countAgentMessages(finalState.messages);

  if (clarificationResponseRef.current) {
    const response = clarificationResponseRef.current;
    response.debug = response.debug ?? {};
    response.debug.candidateCount = enrichedCandidates.size;
    response.debug.agentAttempts = agentAttempts;
    response.debug.toolPasses = toolPasses;
    response.debug.trace = trace;
    attachAgentDebug(response);
    return response;
  }

  if (!finalizedCandidateId) {
    const response = responseFromUnfinalizedAgent(enrichedCandidates.size, toolPasses, agentAttempts, trace, getLangfuseTraceId(langfuseHandler));
    attachAgentDebug(response);
    return response;
  }

  const finalized = enrichedCandidates.get(finalizedCandidateId);
  if (!finalized) {
    return null;
  }

  const finalValidationStartedAt = nowMs();
  const runFinalValidation = shouldRunFinalValidation(finalized, agentProposedCandidateIds);
  const finalValidation = runFinalValidation
    ? await validateFinalAnswer(model, request, finalized, finalizedRationale, trace, callbacks)
    : skippedFinalValidation(finalized);
  trace.push({
    index: trace.length + 1,
    type: 'final_validation',
    name: runFinalValidation ? 'llm_final_validation' : 'skipped_final_validation',
    durationMs: elapsedMs(finalValidationStartedAt),
    output: finalValidation,
  });
  if (!finalValidation.accepted) {
    const response = responseFromRejectedFinalValidation(
      finalized,
      finalValidation,
      enrichedCandidates.size,
      toolPasses,
      agentAttempts,
      trace,
      getLangfuseTraceId(langfuseHandler),
    );
    attachAgentDebug(response);
    return response;
  }

  const response = responseFromEnrichedCandidate(
    finalized,
    'agent+tools',
    Math.min(0.9, Math.max(0.5, finalValidation.confidence)),
    finalizedRationale,
    enrichedCandidates.size,
    toolPasses,
    agentAttempts,
    trace,
    finalValidation,
    getLangfuseTraceId(langfuseHandler),
    request.text,
  );
  attachAgentDebug(response);
  return response;
}

async function deterministicParse(
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
): Promise<TemporalParseResponse> {
  const startedAt = nowMs();
  const parsed = await implementations.parseExpression({ text: request.text, calendarContext: request.calendarContext });
  const candidate = parsed.candidates[0];
  if (!candidate) {
    const needsClarification = parsed.parserNotes.some((note) => note.includes('unresolved time signal'));
    const warning = parsed.parserNotes[0] ?? 'No deterministic parse candidate found.';
    const clarificationAlternatives = needsClarification ? await bareHourAlternatives(request, implementations) : [];
    const response: TemporalParseResponse = {
      status: needsClarification ? 'needs_clarification' : 'failed',
      confidence: 0,
      method: 'fallback',
      assumptions: [],
      ambiguity: needsClarification ? [warning] : [],
      validation: { passed: false, warnings: parsed.parserNotes, checks: needsClarification ? ['deterministic_preflight'] : [] },
      debug: { candidateCount: 0, deterministicDurationMs: elapsedMs(startedAt) },
    };
    if (needsClarification) {
      response.clarificationQuestion = clarificationAlternatives.length > 0
        ? 'Which time did you mean?'
        : 'Please include AM or PM, or use 24-hour time like 13:00.';
      if (clarificationAlternatives.length > 0) {
        response.clarificationAlternatives = clarificationAlternatives;
      }
    }
    return response;
  }

  const enriched = await enrichCandidate(candidate, request, implementations);
  const response = responseFromEnrichedCandidate(
    enriched,
    'deterministic',
    0.75,
    'Deterministic temporal parse.',
    1,
    0,
    0,
    undefined,
    undefined,
    undefined,
    request.text,
  );
  response.debug = response.debug ?? {};
  response.debug.deterministicDurationMs = elapsedMs(startedAt);
  return response;
}

async function bareHourAlternatives(
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
): Promise<TemporalClarificationAlternative[]> {
  const trailingHour = trailingBareHour(request.text);
  if (trailingHour === null || trailingHour < 1 || trailingHour > 12) {
    return [];
  }

  const prefix = request.text.trim().replace(/\b\d{1,2}\s*$/, '').trimEnd();
  const alternatives = await Promise.all([
    clarificationAlternative(`${prefix} ${trailingHour}am`, `${trailingHour} AM`, request, implementations),
    clarificationAlternative(`${prefix} ${trailingHour}pm`, `${trailingHour} PM`, request, implementations),
  ]);
  return alternatives.filter((alternative): alternative is TemporalClarificationAlternative => alternative !== null);
}

async function clarificationAlternative(
  text: string,
  label: string,
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
): Promise<TemporalClarificationAlternative | null> {
  const parsed = await implementations.parseExpression({ text, calendarContext: request.calendarContext });
  const candidate = parsed.candidates[0];
  if (!candidate) {
    return null;
  }

  const enriched = await enrichCandidate(candidate, { ...request, text }, implementations);
  if (!enriched.finalizable) {
    return null;
  }

  return alternativeFromEnrichedCandidate(label, enriched, 'deterministic', 0.85, text);
}

function alternativeFromEnrichedCandidate(
  label: string,
  enriched: EnrichedCandidate,
  method: TemporalClarificationAlternative['method'],
  confidence: number,
  originalText: string,
): TemporalClarificationAlternative {
  const canonical: TemporalClarificationAlternative['canonical'] = {
    isoInstant: enriched.candidate.isoInstant,
    zonedDateTime: enriched.candidate.zonedDateTime,
    timeZone: enriched.candidate.timeZone,
    precision: enriched.candidate.precision,
  };
  if (enriched.facts !== undefined) {
    canonical.weekday = enriched.facts.weekday;
  }

  return {
    label,
    epoch: candidateToEpoch(enriched.candidate),
    suggestedFormatIndex: suggestedFormatIndex(originalText, enriched.candidate.precision),
    confidence,
    method,
    canonical,
    assumptions: enriched.candidate.assumptions,
  };
}

function canUseForClarification(enriched: EnrichedCandidate): boolean {
  if (enriched.finalizable) {
    return true;
  }

  const warnings = enriched.validation?.warnings ?? [];
  return enriched.candidate.precision === 'datetime'
    && warnings.length > 0
    && warnings.every((warning) => /trailing bare number|unresolved time signal/i.test(warning));
}

function conciseClarificationLabel(label: string, enriched: EnrichedCandidate): string {
  const trimmed = label.trim();
  if (trimmed.length > 0 && trimmed.length <= 24 && !/[,-]/.test(trimmed)) {
    return trimmed;
  }

  const zdt = Temporal.ZonedDateTime.from(enriched.candidate.zonedDateTime);
  if (enriched.candidate.precision === 'datetime' || enriched.candidate.precision === 'time') {
    return formatClockLabel(zdt);
  }
  if (enriched.candidate.precision === 'date') {
    return `${zdt.month}/${zdt.day}`;
  }
  return trimmed.length > 0 ? trimmed.slice(0, 24) : 'Use this time';
}

function formatClockLabel(zdt: Temporal.ZonedDateTime): string {
  const hour12 = zdt.hour % 12 || 12;
  const suffix = zdt.hour < 12 ? 'AM' : 'PM';
  return `${hour12}:${String(zdt.minute).padStart(2, '0')} ${suffix}`;
}

function trailingBareHour(text: string): number | null {
  const match = /\b(\d{1,2})\s*$/.exec(text.trim());
  if (!match?.[1]) {
    return null;
  }
  return Number(match[1]);
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
  trace?: TemporalAgentTraceStep[],
  finalValidation?: TemporalFinalValidation,
  langfuseTraceId?: string,
  originalText = '',
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
  const debug: NonNullable<TemporalParseResponse['debug']> = { chosenCandidateId: enriched.candidate.id, candidateCount, agentAttempts, toolPasses };
  if (trace !== undefined) {
    debug.trace = trace;
  }
  if (finalValidation !== undefined) {
    debug.finalValidation = finalValidation;
  }
  if (langfuseTraceId !== undefined) {
    debug.langfuseTraceId = langfuseTraceId;
  }
  const response: TemporalParseResponse = {
    status: validation.passed ? 'resolved' : 'ambiguous',
    epoch: candidateToEpoch(enriched.candidate),
    suggestedFormatIndex: suggestedFormatIndex(originalText, enriched.candidate.precision),
    confidence: validation.passed ? confidence : Math.min(confidence, 0.4),
    method,
    canonical,
    assumptions: rationale ? [...enriched.candidate.assumptions, rationale] : enriched.candidate.assumptions,
    ambiguity: validation.passed ? [] : validation.warnings,
    validation,
    debug,
  };

  return response;
}

function responseFromRejectedFinalValidation(
  enriched: EnrichedCandidate,
  finalValidation: TemporalFinalValidation,
  candidateCount: number,
  toolPasses: number,
  agentAttempts: number,
  trace: TemporalAgentTraceStep[],
  langfuseTraceId?: string,
): TemporalParseResponse {
  const warning = `Final LLM validation rejected candidate: ${finalValidation.reason}`;
  const debug: NonNullable<TemporalParseResponse['debug']> = {
    chosenCandidateId: enriched.candidate.id,
    candidateCount,
    agentAttempts,
    toolPasses,
    trace,
    finalValidation,
  };
  if (langfuseTraceId !== undefined) {
    debug.langfuseTraceId = langfuseTraceId;
  }
  return {
    status: 'needs_clarification',
    confidence: Math.min(finalValidation.confidence, 0.3),
    method: 'agent+tools',
    assumptions: enriched.candidate.assumptions,
    ambiguity: [warning, ...finalValidation.missingOrContradictedSignals],
    validation: {
      passed: false,
      warnings: [warning, ...finalValidation.missingOrContradictedSignals],
      checks: [...(enriched.validation?.checks ?? []), 'llm_final_validation'],
    },
    debug,
  };
}

function responseFromUnfinalizedAgent(
  candidateCount: number,
  toolPasses: number,
  agentAttempts: number,
  trace: TemporalAgentTraceStep[],
  langfuseTraceId?: string,
): TemporalParseResponse {
  const warning = 'Agent did not produce a validated final candidate.';
  const debug: NonNullable<TemporalParseResponse['debug']> = { candidateCount, agentAttempts, toolPasses, trace };
  if (langfuseTraceId !== undefined) {
    debug.langfuseTraceId = langfuseTraceId;
  }
  return {
    status: 'failed',
    confidence: 0,
    method: 'agent+tools',
    assumptions: [],
    ambiguity: [warning],
    validation: {
      passed: false,
      warnings: [warning],
      checks: ['agent_tool_chain'],
    },
    debug,
  };
}

function shouldRunFinalValidation(finalized: EnrichedCandidate, agentProposedCandidateIds: Set<string>): boolean {
  if (agentProposedCandidateIds.has(finalized.candidate.id)) {
    return true;
  }
  return finalized.candidate.provenance === 'shift_math' || finalized.candidate.provenance === 'sandbox';
}

function skippedFinalValidation(finalized: EnrichedCandidate): TemporalFinalValidation {
  return {
    accepted: true,
    confidence: 0.9,
    reason: `Skipped independent LLM validation because ${finalized.candidate.provenance} produced a deterministic candidate that passed built-in validation.`,
    missingOrContradictedSignals: [],
  };
}

async function validateFinalAnswer(
  model: ChatOpenAI,
  request: TemporalParseRequest,
  finalized: EnrichedCandidate,
  rationale: string,
  trace: TemporalAgentTraceStep[],
  callbacks: BaseCallbackHandler[] | undefined,
): Promise<TemporalFinalValidation> {
  const validator = model.withStructuredOutput(FinalValidationSchema);
  const result = await validator.invoke([
    new SystemMessage(`You are an independent final validation pass for a temporal parser.

Your job is not to be generous. Reject candidates that dropped, contradicted, or guessed around temporal signals in the original input.

Validation rules:
- Accept only if the candidate preserves every date and time signal in the input or states a reasonable ambiguity/assumption.
- Reject if a date-only noon default is used while the input contains a possible time signal, including an unconsumed bare number like "1" after a date phrase.
- Reject if the candidate's displayed date, weekday, timezone, or clock time conflicts with the user's text.
- Do not reject solely because the final weekday differs from a mentioned weekday when the input uses that weekday as an anchor for a relative offset, such as "day after next Saturday" or "two days before Friday". In those cases, validate the full phrase semantics instead of requiring the anchor weekday to equal the final weekday.
- Reject when AM/PM ambiguity, fuzzy shorthand, or trailing tokens materially affect the timestamp and were not handled by the agent.
- Do not reject solely because a weekday qualifier like "next Saturday" has multiple colloquial interpretations when the deterministic tool chain resolved it and the candidate weekday is correct.
- Do not reject solely because leetspeak is obfuscated. If the input uses a leet/l33t/133t time phrase and the agent explicitly interprets it as the cultural clock phrase 13:37, treat that interpretation as supported.
- Do not return a corrected timestamp; only accept or reject this exact candidate.`),
    new HumanMessage(JSON.stringify({
      originalText: request.text,
      calendarContext: request.calendarContext,
      candidate: finalized.candidate,
      facts: finalized.facts,
      formats: finalized.formats,
      deterministicValidation: finalized.validation,
      agentRationale: rationale,
      agentTrace: trace,
    })),
  ], callbacks === undefined ? undefined : { callbacks, runName: 'temporal-final-validation' });
  return {
    accepted: result.accepted,
    confidence: result.confidence,
    reason: result.reason,
    missingOrContradictedSignals: result.missingOrContradictedSignals ?? [],
  };
}

function systemPrompt(request: TemporalParseRequest, agentContext: TemporalAgentContext): string {
  return `You are a precise temporal coalescing agent. Your job is to convert fuzzy user time text into one correct timestamp.

Rules:
- Use tools for calendar facts and parsing; do not rely on memory for weekday math.
- The tool executor supports multiple independent tool calls in one assistant turn. On the first tool pass, call all independent tools that are useful instead of discovering one fact per turn.
- Do not call finalize_candidate in the same assistant turn as a candidate-producing tool; wait for candidate IDs from tool output.
- Do not call a dependent tool in parallel with the tool that produces its base candidate ID. For example, shift_datetime must wait for the candidate it shifts unless you provide an explicit base instant/date.
- Use factual context as a hint, not as a final answer. Candidate IDs still must come from tools before finalization.
- If chrono context has unparsedText, treat the chrono candidate as incomplete until the remaining text has been accounted for.
- For holidays, call resolve_holiday and trust holiday_library candidates; do not propose holiday dates from memory.
- If factual context contains holiday hints, use them to choose resolve_holiday arguments instead of guessing holiday names or dates.
- If full-expression parsing fails or returns a rejected partial candidate, decompose the expression with tools.
- For relative compositions, resolve or choose an anchor, then apply shift_datetime. If the intended normalized clock time is already known, pass time to shift_datetime instead of calling set_clock_time afterward.
- Use resolve_clock_time only for conventional explicit clock syntax. For fuzzy clock wording, you may infer the intended normalized 24-hour time yourself, pass it to shift_datetime or set_clock_time, and state that assumption.
- When inferring a fuzzy clock token, first decide whether the token is wordplay, slang, or a cultural time phrase rather than a literal clock string.
- Preserve all available signal. Do not silently discard trailing characters or default minutes to :00 when the token appears to include minute information.
- For obfuscated cultural clock phrases, preserve the intended phrase meaning. For example, leetspeak references to "leet time" mean 13:37, not a literal parse of the visible digits.
- For example, "day after a week from tomorrow" means anchor "tomorrow" plus weeks: 1 and days: 1.
- Tool outputs contain validated candidates under candidate; use candidate.id for follow-up tool base references or finalization.
- You must call propose_candidate or a candidate-resolving tool before finalize_candidate.
- If there are multiple materially plausible timestamps, propose or resolve each plausible candidate first, then call ask_clarification with those candidate IDs instead of finalizing one.
- Do not call ask_clarification in the same assistant turn as candidate-producing tools; wait for candidate IDs from tool output.
- Clarification alternative labels should be concise choices like "4:30 AM" or "Tuesday". Do not include full formatted dates in labels because the UI displays candidate previews separately.
- For ambiguous bare, shorthand, or compact clock text without AM/PM, do not choose AM or PM silently. Offer clarification choices when the meridiem materially changes the timestamp.
- For holiday expressions, call resolve_holiday and finalize the returned validated candidate.
- Only finalize candidate IDs returned by propose_candidate, parse_expression, resolve_calendar_query, resolve_holiday, shift_datetime, or set_clock_time.
- If the user mentions a weekday, use tool output and formatted candidate facts to verify the proposed timestamp actually lands on that weekday.
- If validation rejects a candidate, try another candidate or stop.
- Keep assumptions explicit.

Calendar context:
${JSON.stringify(request.calendarContext)}

Factual context:
${JSON.stringify(agentContext)}

Original input:
${request.text}`;
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

function messageContentChars(messages: BaseMessage[]): number {
  return messages.reduce((total, message) => total + contentChars(message.content), 0);
}

function contentChars(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + contentChars(part), 0);
  }
  if (content === undefined || content === null) {
    return 0;
  }
  return JSON.stringify(content).length;
}

function suggestedFormatIndex(text: string, precision: Candidate['precision']): number {
  if (/\b(in|ago)\b/i.test(text)) {
    return 6;
  }
  if (precision === 'datetime' && WEEKDAY_TEXT_PATTERN.test(text)) {
    return 5;
  }
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

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
}

function attachTopLevelTiming(
  response: TemporalParseResponse,
  totalStartedAt: number,
  deterministicDurationMs?: number,
  agentDurationMs?: number,
): void {
  response.debug = response.debug ?? {};
  if (deterministicDurationMs !== undefined) {
    response.debug.deterministicDurationMs = deterministicDurationMs;
  }
  if (agentDurationMs !== undefined) {
    response.debug.agentDurationMs = agentDurationMs;
  }
  response.debug.totalDurationMs = elapsedMs(totalStartedAt);
}

function createChatModel(apiKey: string, model: string, reasoningEffort: string): ChatOpenAI {
  if (model.startsWith('gpt-5')) {
    return new ChatOpenAI({ apiKey, model, reasoning: { effort: normalizeReasoningEffort(reasoningEffort), summary: 'auto' }, useResponsesApi: true });
  }
  return new ChatOpenAI({ apiKey, model, temperature: 0 });
}

async function createLangfuseHandler(options: TemporalGraphOptions, request: TemporalParseRequest): Promise<LangfuseHandler | null> {
  if (options.langfuse?.enabled !== true) {
    return null;
  }
  if (options.langfuse.baseUrl !== undefined && process.env['LANGFUSE_BASE_URL'] === undefined) {
    process.env['LANGFUSE_BASE_URL'] = options.langfuse.baseUrl;
  }
  const { CallbackHandler } = await import('@langfuse/langchain');
  const params: {
    sessionId?: string;
    userId?: string;
    tags?: string[];
    traceMetadata?: Record<string, unknown>;
  } = {
    tags: ['temporal-parse', ...(options.langfuse.tags ?? [])],
    traceMetadata: {
      timeZone: request.calendarContext.timeZone,
      referenceInstant: request.calendarContext.referenceInstant,
      model: options.openaiModel ?? DEFAULT_OPENAI_MODEL,
    },
  };
  if (options.langfuse.sessionId !== undefined) {
    params.sessionId = options.langfuse.sessionId;
  }
  if (options.langfuse.userId !== undefined) {
    params.userId = options.langfuse.userId;
  }
  return new CallbackHandler(params) as LangfuseHandler;
}

function getLangfuseTraceId(handler: LangfuseHandler | null): string | undefined {
  return handler?.last_trace_id ?? undefined;
}

function normalizeReasoningEffort(effort: string): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'none' || effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  return 'low';
}

function summarizeAiMessage(message: AIMessage): unknown {
  return cleanUndefined({
    content: summarizeValue(message.content),
    toolCalls: message.tool_calls?.map((call) => ({ name: call.name, args: summarizeValue(call.args), id: call.id })),
    reasoning: summarizeValue((message.additional_kwargs as { reasoning?: unknown }).reasoning),
  });
}

function summarizeValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map(summarizeValue);
  }

  const record = value as Record<string, unknown>;
  if (isCandidateLike(record)) {
    return summarizeCandidateRecord(record);
  }
  if (isEnrichedCandidateLike(record)) {
    return summarizeEnrichedCandidateRecord(record);
  }
  if (Array.isArray(record['candidates'])) {
    return cleanUndefined({
      ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'candidates')),
      candidates: record['candidates'].map(summarizeValue),
    });
  }

  return cleanUndefined(Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, summarizeValue(entry)]),
  ));
}

function isCandidateLike(record: Record<string, unknown>): boolean {
  return typeof record['id'] === 'string' && typeof record['isoInstant'] === 'string' && typeof record['zonedDateTime'] === 'string';
}

function isEnrichedCandidateLike(record: Record<string, unknown>): boolean {
  return record['candidate'] !== undefined && typeof record['finalizable'] === 'boolean';
}

function summarizeCandidateRecord(record: Record<string, unknown>): Record<string, unknown> {
  return cleanUndefined({
    id: record['id'],
    isoInstant: record['isoInstant'],
    zonedDateTime: record['zonedDateTime'],
    precision: record['precision'],
    provenance: record['provenance'],
    assumptions: record['assumptions'],
  });
}

function summarizeEnrichedCandidateRecord(record: Record<string, unknown>): Record<string, unknown> {
  return cleanUndefined({
    candidate: summarizeValue(record['candidate']),
    facts: summarizeValue(record['facts']),
    validation: summarizeValue(record['validation']),
    finalizable: record['finalizable'],
  });
}

function cleanUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
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

function resolveAgentBase(
  input: z.infer<typeof AgentBaseDateTimeSchema>,
  enrichedCandidates: Map<string, EnrichedCandidate>,
): Parameters<TemporalToolImplementations['shiftDateTime']>[0]['base'] {
  if ('candidateId' in input) {
    const enriched = enrichedCandidates.get(input.candidateId);
    if (!enriched) {
      throw new Error(`Unknown candidateId ${input.candidateId}.`);
    }
    return { zonedDateTime: enriched.candidate.zonedDateTime };
  }
  return input;
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
