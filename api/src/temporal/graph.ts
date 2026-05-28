import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { END, MessagesAnnotation, StateGraph, START } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { Temporal } from '@js-temporal/polyfill';
import * as z from 'zod';
import type { AgentDecision, CalendarContext, Candidate, EnrichedCandidate, TemporalAgentContext, TemporalClarificationAlternative, TemporalAgentTraceStep, TemporalFeatureFlags, TemporalFinalValidation, TemporalParseRequest, TemporalParseResponse } from './types';
import type { TemporalToolImplementations } from './tools';
import { candidateFromProposal, candidateToEpoch, collectTemporalAgentContext } from './deterministic';

const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
const DEFAULT_OPENAI_REASONING_EFFORT = 'low';

export const DEFAULT_TEMPORAL_GRAPH_LIMITS = {
  maxAgentAttempts: 3,
  // Counts individual ToolMessages, not LLM round trips. Parallel tool calls
  // consume one budget unit per tool result.
  maxToolCalls: 20,
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

const PlanDeltaSchema = z.object({
  years: z.number().int().nullable(),
  months: z.number().int().nullable(),
  weeks: z.number().int().nullable(),
  days: z.number().int().nullable(),
  hours: z.number().int().nullable(),
  minutes: z.number().int().nullable(),
});

const TemporalPlanStepSchema = z.object({
  operation: z.enum([
    'resolve_calendar_query',
    'resolve_holiday',
    'resolve_clock_time',
    'shift_datetime',
    'set_clock_time',
    'propose_candidate',
  ]),
  query: z.string().nullable(),
  text: z.string().nullable(),
  holidayName: z.string().nullable(),
  year: z.number().int().min(1900).max(2200).nullable(),
  baseStep: z.number().int().min(0).nullable(),
  time: TimeOfDaySchema.nullable(),
  timeStep: z.number().int().min(0).nullable(),
  delta: PlanDeltaSchema,
  isoInstant: z.string().nullable(),
  epochSeconds: z.number().int().nullable(),
  timeZone: z.string().nullable(),
  precision: z.enum(['date', 'time', 'datetime', 'relative']).nullable(),
  assumptions: z.array(z.string()),
});

const TemporalPlanSchema = z.object({
  label: z.string(),
  rationale: z.string(),
  assumptions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  finalStep: z.number().int().min(0).nullable(),
  steps: z.array(TemporalPlanStepSchema).min(1).max(6),
});

const TemporalPlanPlannerSchema = z.object({
  outcome: z.enum(['plans', 'clarification', 'no_plan']),
  reason: z.string(),
  clarificationQuestion: z.string().nullable(),
  plans: z.array(TemporalPlanSchema).max(4),
});

const FinalValidationSchema = z.object({
  accepted: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  missingOrContradictedSignals: z.array(z.string()).default([]),
});

type LangfuseHandler = BaseCallbackHandler & { last_trace_id: string | null };
type TemporalPlan = z.infer<typeof TemporalPlanSchema>;
type TemporalPlanStep = z.infer<typeof TemporalPlanStepSchema>;
type RawTemporalPlanStep = z.input<typeof TemporalPlanStepSchema>;
type RawTemporalPlan = {
  label: string;
  rationale: string;
  assumptions?: string[] | undefined;
  confidence?: number | undefined;
  finalStep?: number | null | undefined;
  steps: RawTemporalPlanStep[];
};
type TemporalPlanStepOutput =
  | { kind: 'candidate'; candidate: Candidate }
  | { kind: 'time'; time: { hour: number; minute: number } };
type UnindexedTraceStep = Omit<TemporalAgentTraceStep, 'index'>;
type LangfuseCallbackParams = {
  sessionId?: string;
  userId?: string;
  tags?: string[];
  traceMetadata?: Record<string, unknown>;
  baseUrl?: string;
};

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
  maxToolCalls?: number;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiReasoningEffort?: string;
  features?: TemporalFeatureFlags;
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
  const fallback = await deterministicParse(request, options.implementations, options.features);
  if (!options.openaiApiKey) {
    attachTopLevelTiming(fallback, totalStartedAt, undefined, undefined, options.features);
    return fallback;
  }

  if (shouldShortCircuitDeterministic(fallback)) {
    fallback.debug = fallback.debug ?? {};
    fallback.debug.shortCircuitReason = fallback.status === 'needs_clarification'
      ? 'deterministic_clarification_ready'
      : 'deterministic_resolved_validation_passed';
    attachTopLevelTiming(fallback, totalStartedAt, fallback.debug.deterministicDurationMs, undefined, options.features);
    return fallback;
  }

  const maxToolCalls = options.maxToolCalls ?? DEFAULT_TEMPORAL_GRAPH_LIMITS.maxToolCalls;
  const agentStartedAt = nowMs();

  if (planIrEnabled(options.features)) {
    const planResult = await runPlanIrPath(request, options);
    attachTopLevelTiming(planResult, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt), options.features);
    return planResult;
  }

  try {
    const agentResult = await runAgentGraph(request, options, maxToolCalls);
    if (agentResult) {
      attachTopLevelTiming(agentResult, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt), options.features);
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
    attachTopLevelTiming(response, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt), options.features);
    return response;
  }

  attachTopLevelTiming(fallback, totalStartedAt, fallback.debug?.deterministicDurationMs, elapsedMs(agentStartedAt), options.features);
  return fallback;
}

async function runAgentGraph(
  request: TemporalParseRequest,
  options: TemporalGraphOptions,
  maxToolCalls: number,
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
  const autoFinalizeSoleCandidate = (rationale: string) => {
    const autoFinalized = onlyFinalizableCandidate(enrichedCandidates);
    if (autoFinalized === null || blocksAutoFinalize(autoFinalized, request.text)) {
      return false;
    }
    finalizedCandidateId = autoFinalized.candidate.id;
    finalizedRationale = rationale;
    trace.push({
      index: trace.length + 1,
      type: 'router',
      name: 'auto_finalize_candidate',
      output: compactEnrichedCandidate(autoFinalized),
    });
    return true;
  };

  const parseExpressionTool = tool(
    async (input) => {
      const startedAt = nowMs();
      const parsed = await options.implementations.parseExpression({
        text: input.text,
        calendarContext: toCalendarContext(input.calendarContext),
        ...(options.features === undefined ? {} : { features: options.features }),
      });
      const enriched = await Promise.all(parsed.candidates.map((candidate) => enrichCandidate(candidate, request, options.implementations)));
      if (enriched.length > 0) {
        markCandidate();
      }
      for (const candidate of enriched) {
        enrichedCandidates.set(candidate.candidate.id, candidate);
      }
      const output = { parserNotes: parsed.parserNotes, candidates: enriched.map(compactEnrichedCandidate) };
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
        ...(options.features === undefined ? {} : { features: options.features }),
      });
      const enriched = await Promise.all(resolved.candidates.map((candidate) => enrichCandidate(candidate, request, options.implementations)));
      if (enriched.length > 0) {
        markCandidate();
      }
      for (const candidate of enriched) {
        enrichedCandidates.set(candidate.candidate.id, candidate);
      }
      const output = { source: resolved.source, notes: resolved.notes, candidates: enriched.map(compactEnrichedCandidate) };
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
      const output = { source: resolved.source, notes: resolved.notes, candidates: enriched.map(compactEnrichedCandidate) };
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
      const output = compactEnrichedCandidate(enriched);
      recordTool('shift_datetime', input, output, startedAt);
      return JSON.stringify(output);
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
      const output = compactEnrichedCandidate(enriched);
      recordTool('set_clock_time', input, output, startedAt);
      return JSON.stringify(output);
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
      const output = compactEnrichedCandidate(enriched);
      recordTool('propose_candidate', input, output, startedAt);
      return JSON.stringify(output);
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
      clarificationResponseRef.current = null;
      const output = { accepted: true, candidate: compactEnrichedCandidate(candidate) };
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
      if (finalizedCandidateId) {
        const output = { accepted: false, error: 'A candidate has already been finalized; not asking for clarification.' };
        recordTool('ask_clarification', input, output, startedAt);
        return JSON.stringify(output);
      }

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
        ? { accepted: true, question: input.question, alternatives: alternatives.map(compactClarificationAlternative) }
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
    if (countToolMessages(state.messages) >= maxToolCalls) {
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
    .addConditionalEdges('toolNode', () => {
      if (finalizedCandidateId || clarificationResponseRef.current) {
        return END;
      }
      if (autoFinalizeSoleCandidate('Auto-finalized the only validated candidate after a tool pass.')) {
        return END;
      }
      return 'llmCall';
    }, ['llmCall', END])
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

  if (!finalizedCandidateId) {
    if (!autoFinalizeSoleCandidate('Auto-finalized the only validated candidate after the agent stopped without calling finalize_candidate.')) {
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

      const response = responseFromUnfinalizedAgent(enrichedCandidates.size, toolPasses, agentAttempts, trace, getLangfuseTraceId(langfuseHandler));
      attachAgentDebug(response);
      return response;
    }
  }

  const finalizedId = finalizedCandidateId;
  if (finalizedId === null) {
    return null;
  }

  const finalized = enrichedCandidates.get(finalizedId);
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
      'agent+tools',
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

async function runPlanIrPath(
  request: TemporalParseRequest,
  options: TemporalGraphOptions,
): Promise<TemporalParseResponse> {
  if (!options.openaiApiKey) {
    return responseFromFailedPlanIr('Plan IR requires an OpenAI API key.', [], 0, 0, 0);
  }

  const planStartedAt = nowMs();
  const modelName = options.openaiModel ?? DEFAULT_OPENAI_MODEL;
  const reasoningEffort = options.openaiReasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
  const trace: TemporalAgentTraceStep[] = [];
  const agentContext = collectTemporalAgentContext(request);
  const langfuseHandler = await createLangfuseHandler(options, request);
  const callbacks = langfuseHandler === null ? undefined : [langfuseHandler];
  const model = createChatModel(options.openaiApiKey, modelName, reasoningEffort);
  const planner = model.withStructuredOutput(TemporalPlanPlannerSchema);
  const system = planIrSystemPrompt(request, agentContext);
  const human = JSON.stringify({ text: request.text, calendarContext: request.calendarContext });

  let firstLlmResponseMs: number | undefined;
  let firstCandidateMs: number | undefined;
  const attachPlanDebug = (response: TemporalParseResponse) => {
    response.debug = response.debug ?? {};
    response.debug.model = modelName;
    response.debug.reasoningEffort = reasoningEffort;
    response.debug.trace = response.debug.trace ?? trace;
    if (firstLlmResponseMs !== undefined) {
      response.debug.firstLlmResponseMs = firstLlmResponseMs;
    }
    if (firstCandidateMs !== undefined) {
      response.debug.firstCandidateMs = firstCandidateMs;
    }
    response.debug.finalResponseMs = elapsedMs(planStartedAt);
    const traceId = getLangfuseTraceId(langfuseHandler);
    if (traceId !== undefined) {
      response.debug.langfuseTraceId = traceId;
    }
  };

  const llmStartedAt = nowMs();
  const planResult = await planner.invoke([
    new SystemMessage(system),
    new HumanMessage(human),
  ], callbacks === undefined ? undefined : { callbacks, runName: 'temporal-plan-ir' });
  firstLlmResponseMs = elapsedMs(planStartedAt);
  trace.push({
    index: trace.length + 1,
    type: 'llm',
    name: 'plan_ir_planner',
    durationMs: elapsedMs(llmStartedAt),
    input: {
      messageCount: 2,
      systemPromptChars: system.length,
      totalMessageChars: system.length + human.length,
    },
    output: summarizeValue(planResult),
  });

  const plans = (planResult.plans ?? []).map(normalizeTemporalPlan);
  if (planResult.outcome === 'no_plan' || plans.length === 0) {
    const response = responseFromFailedPlanIr(planResult.reason, trace, 0, 0, 1, getLangfuseTraceId(langfuseHandler));
    attachPlanDebug(response);
    return response;
  }

  const executions = await Promise.all(plans.map((plan, index) => executeTemporalPlan(plan, index, request, options)));
  for (const execution of executions) {
    appendTrace(trace, execution.trace);
  }

  const toolPasses = executions.reduce((total, execution) => total + execution.toolPasses, 0);
  const candidates = executions.filter((execution): execution is PlanExecution & { enriched: EnrichedCandidate } => execution.enriched !== undefined);
  if (candidates.length > 0) {
    firstCandidateMs = executions.reduce((min, execution) => {
      if (execution.firstCandidateMs === undefined) {
        return min;
      }
      return min === undefined ? execution.firstCandidateMs : Math.min(min, execution.firstCandidateMs);
    }, undefined as number | undefined);
  }

  const finalizable = candidates.filter((execution) => execution.enriched.finalizable);
  if (finalizable.length === 0) {
    const reason = planResult.reason || 'Plan IR did not produce a validation-passing candidate.';
    const errors = executions.map((execution) => execution.error).filter((error): error is string => error !== undefined);
    const response = responseFromFailedPlanIr([reason, ...errors].join(' '), trace, candidates.length, toolPasses, 1, getLangfuseTraceId(langfuseHandler));
    attachPlanDebug(response);
    return response;
  }

  const uniqueEpochs = [...new Set(finalizable.map((execution) => String(candidateToEpoch(execution.enriched.candidate))))];
  if (planResult.outcome === 'clarification' || uniqueEpochs.length > 1) {
    const response = responseFromPlanClarification(
      planResult.clarificationQuestion ?? 'Which interpretation did you mean?',
      finalizable,
      trace,
      candidates.length,
      toolPasses,
      1,
      getLangfuseTraceId(langfuseHandler),
      request.text,
    );
    attachPlanDebug(response);
    return response;
  }

  const selected = finalizable[0]!;
  trace.push({
    index: trace.length + 1,
    type: 'router',
    name: 'plan_ir_select_candidate',
    output: { plan: selected.plan.label, candidate: compactEnrichedCandidate(selected.enriched) },
  });

  const finalValidationStartedAt = nowMs();
  const finalValidation = await validateFinalAnswer(model, request, selected.enriched, selected.plan.rationale, trace, callbacks);
  trace.push({
    index: trace.length + 1,
    type: 'final_validation',
    name: 'plan_ir_final_validation',
    durationMs: elapsedMs(finalValidationStartedAt),
    output: finalValidation,
  });
  if (!finalValidation.accepted) {
    const response = responseFromRejectedFinalValidation(
      selected.enriched,
      finalValidation,
      candidates.length,
      toolPasses,
      1,
      trace,
      'agent+plan',
      getLangfuseTraceId(langfuseHandler),
    );
    attachPlanDebug(response);
    return response;
  }

  const response = responseFromEnrichedCandidate(
    selected.enriched,
    'agent+plan',
    Math.min(0.9, Math.max(0.5, finalValidation.confidence, selected.plan.confidence)),
    selected.plan.rationale,
    candidates.length,
    toolPasses,
    1,
    trace,
    finalValidation,
    getLangfuseTraceId(langfuseHandler),
    request.text,
  );
  attachPlanDebug(response);
  return response;
}

type PlanExecution = {
  plan: TemporalPlan;
  planIndex: number;
  enriched?: EnrichedCandidate;
  error?: string;
  trace: UnindexedTraceStep[];
  toolPasses: number;
  firstCandidateMs?: number;
};

async function executeTemporalPlan(
  plan: TemporalPlan,
  planIndex: number,
  request: TemporalParseRequest,
  options: TemporalGraphOptions,
): Promise<PlanExecution> {
  const startedAt = nowMs();
  const trace: UnindexedTraceStep[] = [];
  const executions = new Map<number, Promise<TemporalPlanStepOutput>>();

  const recordTool = (stepIndex: number, step: TemporalPlanStep, output: unknown, stepStartedAt: number) => {
    trace.push({
      type: 'tool',
      name: step.operation,
      durationMs: elapsedMs(stepStartedAt),
      input: summarizeValue({ planIndex, plan: plan.label, stepIndex, step }),
      output: summarizeValue(output),
    });
  };

  const executeStep = (stepIndex: number): Promise<TemporalPlanStepOutput> => {
    const existing = executions.get(stepIndex);
    if (existing !== undefined) {
      return existing;
    }
    const step = plan.steps[stepIndex];
    if (step === undefined) {
      throw new Error(`Plan ${plan.label} references missing step ${stepIndex}.`);
    }
    const execution = executePlanStep(step, stepIndex, executeStep, request, options, recordTool);
    executions.set(stepIndex, execution);
    return execution;
  };

  try {
    const outputs = await Promise.all(plan.steps.map((_, stepIndex) => executeStep(stepIndex)));
    const finalOutput = finalPlanOutput(plan, outputs);
    if (finalOutput.kind !== 'candidate') {
      throw new Error(`Plan ${plan.label} final output was ${finalOutput.kind}, not a candidate.`);
    }

    const enriched = await enrichCandidate(finalOutput.candidate, request, options.implementations);
    trace.push({
      type: 'router',
      name: 'plan_ir_final_step',
      output: { planIndex, plan: plan.label, candidate: compactEnrichedCandidate(enriched) },
    });
    return {
      plan,
      planIndex,
      enriched,
      trace,
      toolPasses: trace.filter((step) => step.type === 'tool').length,
      firstCandidateMs: elapsedMs(startedAt),
    };
  } catch (error) {
    trace.push({
      type: 'router',
      name: 'plan_ir_plan_failed',
      output: { planIndex, plan: plan.label, error: errorMessage(error) },
    });
    return {
      plan,
      planIndex,
      error: errorMessage(error),
      trace,
      toolPasses: trace.filter((step) => step.type === 'tool').length,
    };
  }
}

async function executePlanStep(
  step: TemporalPlanStep,
  stepIndex: number,
  executeStep: (stepIndex: number) => Promise<TemporalPlanStepOutput>,
  request: TemporalParseRequest,
  options: TemporalGraphOptions,
  recordTool: (stepIndex: number, step: TemporalPlanStep, output: unknown, startedAt: number) => void,
): Promise<TemporalPlanStepOutput> {
  const startedAt = nowMs();
  switch (step.operation) {
    case 'resolve_calendar_query': {
      const query = requirePlanString(step.query, step, 'query');
      const resolved = await options.implementations.resolveCalendarQuery({
        query,
        calendarContext: request.calendarContext,
        ...(options.features === undefined ? {} : { features: options.features }),
      });
      const candidate = resolved.candidates[0];
      recordTool(stepIndex, step, resolved, startedAt);
      if (candidate === undefined) {
        throw new Error(`resolve_calendar_query returned no candidates for ${query}.`);
      }
      return { kind: 'candidate', candidate };
    }
    case 'resolve_holiday': {
      const holidayName = requirePlanString(step.holidayName, step, 'holidayName');
      const holidayInput: Parameters<TemporalToolImplementations['resolveHoliday']>[0] = {
        holidayName,
        calendarContext: request.calendarContext,
      };
      if (step.year !== null) {
        holidayInput.year = step.year;
      }
      if (step.time !== null) {
        holidayInput.time = step.time;
      }
      const resolved = await options.implementations.resolveHoliday(holidayInput);
      const candidate = resolved.candidates[0];
      recordTool(stepIndex, step, resolved, startedAt);
      if (candidate === undefined) {
        throw new Error(`resolve_holiday returned no candidates for ${holidayName}.`);
      }
      return { kind: 'candidate', candidate };
    }
    case 'resolve_clock_time': {
      const text = requirePlanString(step.text ?? step.query, step, 'text');
      const resolved = await options.implementations.resolveClockTime({ text, calendarContext: request.calendarContext });
      const clock = resolved.candidates[0];
      recordTool(stepIndex, step, resolved, startedAt);
      if (clock === undefined) {
        throw new Error(`resolve_clock_time returned no candidates for ${text}.`);
      }
      return { kind: 'time', time: { hour: clock.hour, minute: clock.minute } };
    }
    case 'shift_datetime': {
      const baseStep = requirePlanNumber(step.baseStep, step, 'baseStep');
      const [base, time] = await Promise.all([
        candidateOutputFromPlanStep(baseStep, executeStep),
        timeFromPlanStep(step, executeStep),
      ]);
      const shiftInput: Parameters<TemporalToolImplementations['shiftDateTime']>[0] = {
        base: { zonedDateTime: base.candidate.zonedDateTime },
        delta: cleanDelta(step.delta),
        calendarContext: request.calendarContext,
      };
      if (time !== undefined) {
        shiftInput.time = time;
      }
      const candidate = await options.implementations.shiftDateTime(shiftInput);
      recordTool(stepIndex, step, candidate, startedAt);
      return { kind: 'candidate', candidate };
    }
    case 'set_clock_time': {
      const baseStep = requirePlanNumber(step.baseStep, step, 'baseStep');
      const [base, time] = await Promise.all([
        candidateOutputFromPlanStep(baseStep, executeStep),
        timeFromPlanStep(step, executeStep),
      ]);
      if (time === undefined) {
        throw new Error('set_clock_time requires either time or timeStep.');
      }
      const candidate = await options.implementations.setClockTime({
        base: { zonedDateTime: base.candidate.zonedDateTime },
        time,
        calendarContext: request.calendarContext,
      });
      recordTool(stepIndex, step, candidate, startedAt);
      return { kind: 'candidate', candidate };
    }
    case 'propose_candidate': {
      const isoInstant = step.isoInstant ?? epochSecondsToIso(step.epochSeconds);
      const candidate = candidateFromProposal({
        isoInstant,
        timeZone: step.timeZone ?? request.calendarContext.timeZone,
        precision: requirePlanPrecision(step.precision, step),
        assumptions: [...planStepAssumptions(step)],
      });
      recordTool(stepIndex, step, candidate, startedAt);
      return { kind: 'candidate', candidate };
    }
  }
}

async function candidateOutputFromPlanStep(
  stepIndex: number,
  executeStep: (stepIndex: number) => Promise<TemporalPlanStepOutput>,
): Promise<Extract<TemporalPlanStepOutput, { kind: 'candidate' }>> {
  const output = await executeStep(stepIndex);
  if (output.kind !== 'candidate') {
    throw new Error(`Step ${stepIndex} produced ${output.kind}, not a candidate.`);
  }
  return output;
}

async function timeFromPlanStep(
  step: TemporalPlanStep,
  executeStep: (stepIndex: number) => Promise<TemporalPlanStepOutput>,
): Promise<{ hour: number; minute: number } | undefined> {
  if (step.time !== null) {
    return step.time;
  }
  if (step.timeStep === null) {
    return undefined;
  }
  const output = await executeStep(step.timeStep);
  if (output.kind !== 'time') {
    throw new Error(`Step ${step.timeStep} produced ${output.kind}, not a time.`);
  }
  return output.time;
}

function finalPlanOutput(plan: TemporalPlan, outputs: TemporalPlanStepOutput[]): TemporalPlanStepOutput {
  if (plan.finalStep !== null) {
    const output = outputs[plan.finalStep];
    if (output?.kind === 'candidate') {
      return output;
    }
  }

  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const output = outputs[index];
    if (output?.kind === 'candidate') {
      return output;
    }
  }
  throw new Error(`Plan ${plan.label} did not produce a candidate.`);
}

function planStepAssumptions(step: TemporalPlanStep): string[] {
  const assumptions = step.assumptions ?? [];
  return assumptions.length > 0 ? assumptions : ['Plan IR proposed an explicit candidate.'];
}

function normalizeTemporalPlan(plan: RawTemporalPlan): TemporalPlan {
  const normalized: TemporalPlan = {
    label: plan.label,
    rationale: plan.rationale,
    assumptions: plan.assumptions ?? [],
    confidence: plan.confidence ?? 0.7,
    finalStep: plan.finalStep ?? null,
    steps: plan.steps.map(normalizeTemporalPlanStep),
  };
  return normalized;
}

function normalizeTemporalPlanStep(step: RawTemporalPlanStep): TemporalPlanStep {
  return {
    ...step,
    assumptions: step.assumptions ?? [],
  };
}

function requirePlanString(value: string | null, step: TemporalPlanStep, field: string): string {
  if (value === null || value.trim() === '') {
    throw new Error(`${step.operation} requires ${field}.`);
  }
  return value;
}

function requirePlanNumber(value: number | null, step: TemporalPlanStep, field: string): number {
  if (value === null) {
    throw new Error(`${step.operation} requires ${field}.`);
  }
  return value;
}

function requirePlanPrecision(value: Candidate['precision'] | null, step: TemporalPlanStep): Candidate['precision'] {
  if (value === null) {
    throw new Error(`${step.operation} requires precision.`);
  }
  return value;
}

function appendTrace(trace: TemporalAgentTraceStep[], entries: UnindexedTraceStep[]): void {
  for (const entry of entries) {
    trace.push({ index: trace.length + 1, ...entry });
  }
}

function responseFromPlanClarification(
  question: string,
  executions: Array<PlanExecution & { enriched: EnrichedCandidate }>,
  trace: TemporalAgentTraceStep[],
  candidateCount: number,
  toolPasses: number,
  agentAttempts: number,
  langfuseTraceId: string | undefined,
  originalText: string,
): TemporalParseResponse {
  const alternatives = executions
    .filter((execution) => canUseForClarification(execution.enriched))
    .map((execution) => alternativeFromEnrichedCandidate(execution.plan.label, execution.enriched, 'agent+plan', 0.75, originalText))
    .sort((a, b) => a.epoch - b.epoch);
  const debug: NonNullable<TemporalParseResponse['debug']> = { candidateCount, agentAttempts, toolPasses, trace };
  if (langfuseTraceId !== undefined) {
    debug.langfuseTraceId = langfuseTraceId;
  }
  const response: TemporalParseResponse = {
    status: alternatives.length > 1 ? 'needs_clarification' : 'failed',
    confidence: 0,
    method: 'agent+plan',
    assumptions: [],
    ambiguity: alternatives.length > 1 ? [question] : ['Plan IR produced multiple candidates but not enough usable clarification alternatives.'],
    validation: {
      passed: false,
      warnings: alternatives.length > 1 ? [question] : ['Plan IR clarification failed.'],
      checks: ['plan_ir_clarification'],
    },
    debug,
  };
  if (alternatives.length > 1) {
    response.clarificationQuestion = question;
    response.clarificationAlternatives = alternatives;
  }
  return response;
}

function responseFromFailedPlanIr(
  reason: string,
  trace: TemporalAgentTraceStep[],
  candidateCount: number,
  toolPasses: number,
  agentAttempts: number,
  langfuseTraceId?: string,
): TemporalParseResponse {
  const debug: NonNullable<TemporalParseResponse['debug']> = { candidateCount, agentAttempts, toolPasses, trace };
  if (langfuseTraceId !== undefined) {
    debug.langfuseTraceId = langfuseTraceId;
  }
  return {
    status: 'failed',
    confidence: 0,
    method: 'agent+plan',
    assumptions: [],
    ambiguity: [reason],
    validation: {
      passed: false,
      warnings: [reason],
      checks: ['plan_ir'],
    },
    debug,
  };
}

async function deterministicParse(
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
  features?: TemporalFeatureFlags,
): Promise<TemporalParseResponse> {
  const startedAt = nowMs();
  const parsed = await implementations.parseExpression({
    text: request.text,
    calendarContext: request.calendarContext,
    ...(features === undefined ? {} : { features }),
  });
  const candidate = parsed.candidates[0];
  if (!candidate) {
    const needsClarification = parsed.parserNotes.some((note) => note.includes('unresolved time signal'));
    const warning = parsed.parserNotes[0] ?? 'No deterministic parse candidate found.';
    const clarificationAlternatives = needsClarification ? await bareHourAlternatives(request, implementations, features) : [];
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
  features?: TemporalFeatureFlags,
): Promise<TemporalClarificationAlternative[]> {
  const trailingHour = trailingBareHour(request.text);
  if (trailingHour === null || trailingHour < 1 || trailingHour > 12) {
    return [];
  }

  const prefix = request.text.trim().replace(/\b\d{1,2}\s*$/, '').trimEnd();
  const alternatives = await Promise.all([
    clarificationAlternative(`${prefix} ${trailingHour}am`, `${trailingHour} AM`, request, implementations, features),
    clarificationAlternative(`${prefix} ${trailingHour}pm`, `${trailingHour} PM`, request, implementations, features),
  ]);
  return alternatives.filter((alternative): alternative is TemporalClarificationAlternative => alternative !== null);
}

async function clarificationAlternative(
  text: string,
  label: string,
  request: TemporalParseRequest,
  implementations: TemporalToolImplementations,
  features?: TemporalFeatureFlags,
): Promise<TemporalClarificationAlternative | null> {
  const parsed = await implementations.parseExpression({
    text,
    calendarContext: request.calendarContext,
    ...(features === undefined ? {} : { features }),
  });
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

function compactEnrichedCandidate(enriched: EnrichedCandidate): Record<string, unknown> {
  return cleanUndefined({
    candidate: {
      id: enriched.candidate.id,
      isoInstant: enriched.candidate.isoInstant,
      zonedDateTime: enriched.candidate.zonedDateTime,
      timeZone: enriched.candidate.timeZone,
      precision: enriched.candidate.precision,
      provenance: enriched.candidate.provenance,
      assumptions: enriched.candidate.assumptions,
    },
    facts: compactCandidateFacts(enriched.facts),
    validation: enriched.validation,
    finalizable: enriched.finalizable,
  });
}

function compactCandidateFacts(facts: EnrichedCandidate['facts']): Record<string, unknown> | undefined {
  if (facts === undefined) {
    return undefined;
  }
  return cleanUndefined({
    weekday: facts.weekday,
    isoDate: facts.isoDate,
    isoInstant: facts.isoInstant,
    dayOfWeek: facts.dayOfWeek,
    weekOfYear: facts.weekOfYear,
    month: facts.month,
    year: facts.year,
    timeZone: facts.timeZone,
  });
}

function compactClarificationAlternative(alternative: TemporalClarificationAlternative): Record<string, unknown> {
  return {
    label: alternative.label,
    epoch: alternative.epoch,
    suggestedFormatIndex: alternative.suggestedFormatIndex,
    confidence: alternative.confidence,
    method: alternative.method,
  };
}

function onlyFinalizableCandidate(enrichedCandidates: Map<string, EnrichedCandidate>): EnrichedCandidate | null {
  const finalizable = [...enrichedCandidates.values()].filter((candidate) => candidate.finalizable);
  return finalizable.length === 1 ? finalizable[0]! : null;
}

function blocksAutoFinalize(enriched: EnrichedCandidate, originalText: string): boolean {
  return enriched.candidate.precision === 'date' && hasTrailingNonYearNumber(originalText);
}

function hasTrailingNonYearNumber(text: string): boolean {
  const match = /\b(\d{1,4})\s*$/.exec(text.trim());
  if (!match?.[1]) {
    return false;
  }
  const value = Number(match[1]);
  return !(match[1].length === 4 && value >= 1900 && value <= 2200);
}

function responseFromRejectedFinalValidation(
  enriched: EnrichedCandidate,
  finalValidation: TemporalFinalValidation,
  candidateCount: number,
  toolPasses: number,
  agentAttempts: number,
  trace: TemporalAgentTraceStep[],
  method: TemporalParseResponse['method'],
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
    method,
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
- If factual context has chrono.candidate plus unparsedText that is a relative modifier, use shift_datetime directly with base.zonedDateTime from chrono.candidate and the modifier's delta. Do not rediscover the same chrono candidate through parse_expression first.
- For holidays, call resolve_holiday and trust holiday_library candidates; do not propose holiday dates from memory.
- If factual context contains holiday hints, use them to choose resolve_holiday arguments instead of guessing holiday names or dates.
- If full-expression parsing fails or returns a rejected partial candidate, decompose the expression with tools.
- If the input has an obvious typo in a temporal word, interpret the intended temporal word yourself, state it as an assumption, and call candidate-producing tools directly. Do not spend a tool call asking deterministic parsers to parse the misspelled raw text.
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

function planIrSystemPrompt(request: TemporalParseRequest, agentContext: TemporalAgentContext): string {
  return `You convert fuzzy temporal text into small executable plans for a deterministic calendar executor.

Return only structured output matching the schema. Do not answer with prose.
Every plan step must include every schema field. Set fields that do not apply to null. For delta, set unused units to null.

Available plan operations:
- resolve_calendar_query: use for corrected or explicit anchor phrases the deterministic parser can parse, such as "tomorrow", "next saturday", or "May 24 at 13:37".
- resolve_holiday: use for holiday names; include year and normalized time when the user specified them.
- resolve_clock_time: use for conventional explicit clock text like "13:37", "1pm", "noon", or "one hour past noon and 10 minutes".
- shift_datetime: apply calendar arithmetic to a prior candidate step. Use baseStep for the anchor. Use time or timeStep when the final clock is known.
- set_clock_time: apply a normalized clock time to a prior candidate step.
- propose_candidate: last resort for explicit epoch/ISO timestamps only; do not guess remembered holiday dates or weekday math.

Planning rules:
- Emit up to four independent plans. The executor evaluates plans in parallel and also runs independent step dependencies in parallel.
- Prefer one clear plan when the input has one intended meaning.
- Use outcome "clarification" with alternative plans when AM/PM, "next weekday", or shorthand ambiguity materially changes the timestamp.
- Phrases like "sunday after next" are ambiguous. Do not choose one silently; emit clarification plans for plausible readings such as the weekday one week after the upcoming bare weekday and the weekday two weeks after the upcoming bare weekday. For this ambiguity, anchor on resolve_calendar_query with the bare weekday text like "sunday", not "next sunday".
- For dependent compositions, resolve the anchor and clock independently when possible, then combine with shift_datetime or set_clock_time.
- For typos in temporal words, correct the phrase in resolve_calendar_query and include the correction in the plan rationale.
- For fuzzy cultural clock text, infer the semantic clock only when the phrase is stable. For leet/l33t/133t time, use 13:37.
- Preserve every date, time, holiday, weekday, offset, and timezone signal. If you cannot express the full meaning with the operations, use outcome "no_plan".
- finalStep should be a zero-based index pointing to the candidate-producing step that represents the final answer. Use null to let the executor use the last candidate step.

Calendar context:
${JSON.stringify(request.calendarContext)}

Factual context:
${JSON.stringify(agentContext)}

Original input:
${request.text}`;
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

function shouldShortCircuitDeterministic(response: TemporalParseResponse): boolean {
  if (response.status === 'needs_clarification' && (response.clarificationAlternatives?.length ?? 0) > 0) {
    return true;
  }

  return response.status === 'resolved'
    && response.epoch !== undefined
    && response.method === 'deterministic'
    && response.validation.passed
    && response.ambiguity.length === 0;
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
  features?: TemporalFeatureFlags,
): void {
  response.debug = response.debug ?? {};
  if (features !== undefined) {
    response.debug.featureFlags = compactFeatureFlags(features);
  }
  if (deterministicDurationMs !== undefined) {
    response.debug.deterministicDurationMs = deterministicDurationMs;
  }
  if (agentDurationMs !== undefined) {
    response.debug.agentDurationMs = agentDurationMs;
  }
  response.debug.totalDurationMs = elapsedMs(totalStartedAt);
}

function compactFeatureFlags(features: TemporalFeatureFlags): TemporalFeatureFlags {
  const compact: TemporalFeatureFlags = {};
  if (features.ordinalWeekdayGrammar !== undefined) {
    compact.ordinalWeekdayGrammar = features.ordinalWeekdayGrammar;
  }
  if (features.planIr !== undefined) {
    compact.planIr = features.planIr;
  }
  return compact;
}

function planIrEnabled(features: TemporalFeatureFlags | undefined): boolean {
  return features?.planIr === true;
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
  const { CallbackHandler } = await import('@langfuse/langchain');
  const params: LangfuseCallbackParams = {
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
  if (options.langfuse.baseUrl !== undefined) {
    params.baseUrl = options.langfuse.baseUrl;
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
  years?: number | null | undefined;
  months?: number | null | undefined;
  weeks?: number | null | undefined;
  days?: number | null | undefined;
  hours?: number | null | undefined;
  minutes?: number | null | undefined;
}): { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number } {
  const delta: { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number } = {};
  if (input.years !== undefined && input.years !== null) {
    delta.years = input.years;
  }
  if (input.months !== undefined && input.months !== null) {
    delta.months = input.months;
  }
  if (input.weeks !== undefined && input.weeks !== null) {
    delta.weeks = input.weeks;
  }
  if (input.days !== undefined && input.days !== null) {
    delta.days = input.days;
  }
  if (input.hours !== undefined && input.hours !== null) {
    delta.hours = input.hours;
  }
  if (input.minutes !== undefined && input.minutes !== null) {
    delta.minutes = input.minutes;
  }
  return delta;
}

function epochSecondsToIso(epochSeconds: number | null | undefined): string {
  if (epochSeconds === undefined || epochSeconds === null) {
    throw new Error('Either isoInstant or epochSeconds is required.');
  }
  return new Date(epochSeconds * 1000).toISOString();
}
