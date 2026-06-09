import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';
import { parseTemporalExpression } from '../src/temporal';
import { parseCalendarContext } from '../src/temporal/deterministic';
import { executeTemporalPlanPlannerOutput } from '../src/temporal/graph';
import { parseTemporalPlanPlannerOutput, PLAN_WEEKDAYS, TEMPORAL_PLAN_MAX_PLANS, TEMPORAL_PLAN_MAX_STEPS } from '../src/temporal/plan-ir';
import { createDeterministicTemporalToolImplementations } from '../src/temporal/tools';
import type { TemporalAgentTraceStep, TemporalFeatureFlags, TemporalParseResponse } from '../src/temporal/types';

type ExpectedResolved = {
  status: 'resolved';
  epoch?: number;
  suggestedFormatIndex?: number;
  range?: ExpectedRange;
};

type ExpectedClarification = {
  status: 'needs_clarification';
  alternativeEpochs: number[];
  alternativeRanges?: ExpectedRange[];
};

type ExpectedRange = {
  startEpoch: number;
  endEpoch: number;
  startFormatIndex?: number;
  endFormatIndex?: number;
};

type ExpectedFailed = {
  status: 'failed';
};

type TemporalEvalCase = {
  id: string;
  text: string;
  category: string;
  expected: ExpectedResolved | ExpectedClarification | ExpectedFailed;
  referenceInstant?: string;
  timeZone?: string;
  required?: boolean;
};

type ModelSpec = {
  runner: 'agent' | 'single_call' | 'deterministic';
  provider: 'openai';
  model: string;
  reasoningEffort: string;
};

type DeterministicSpec = {
  runner: 'deterministic';
  provider: 'local';
  model: 'deterministic';
  reasoningEffort: 'none';
};

type TrainedPlanSpec = {
  runner: 'trained_plan';
  provider: 'local';
  model: string;
  reasoningEffort: 'none';
  predictionsPath: string;
};

type EndpointPlanSpec = {
  runner: 'endpoint_plan';
  provider: string;
  model: string;
  reasoningEffort: 'none';
  baseUrl: string;
  apiKey?: string;
  api: 'chat' | 'completions';
  transport: 'openai' | 'runpod_queue';
  instructionPreset: 'detailed' | 'minimal';
  promptFormat: 'custom' | 'chat';
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  responseFormat: 'none' | 'json_schema' | 'structured_outputs_json';
  extraBody?: Record<string, unknown>;
};

type EvalRunnerSpec = ModelSpec | DeterministicSpec | TrainedPlanSpec | EndpointPlanSpec;

type EvalExperimentSpec = {
  label: string;
  featureFlags: TemporalFeatureFlags;
};

type EvalParsed = {
  status: TemporalParseResponse['status'];
  kind?: TemporalParseResponse['kind'];
  epoch?: number;
  suggestedFormatIndex?: number;
  range?: TemporalParseResponse['range'];
  confidence: number;
  method: string;
  clarificationAlternatives?: Array<{ epoch: number; range?: TemporalParseResponse['range'] }>;
  debug?: TemporalParseResponse['debug'];
};

type EvalResult = {
  experimentLabel: string;
  featureFlags: TemporalFeatureFlags;
  runner: EvalRunnerSpec['runner'];
  model: string;
  provider: string;
  reasoningEffort: string;
  caseId: string;
  repeat: number;
  text: string;
  category: string;
  required: boolean;
  passed: boolean;
  durationMs: number;
  status?: string;
  kind?: string;
  epoch?: number;
  suggestedFormatIndex?: number;
  range?: TemporalParseResponse['range'];
  confidence?: number;
  method?: string;
  instructionPreset?: string;
  error?: string;
  mismatch?: string;
  metrics?: {
    agentAttempts?: number;
    toolPasses?: number;
    totalDurationMs?: number;
    agentDurationMs?: number;
    deterministicDurationMs?: number;
    firstLlmResponseMs?: number;
    firstCandidateMs?: number;
    finalResponseMs?: number;
    llmDurationMs: number;
    toolDurationMs: number;
    finalValidationDurationMs: number;
    firstCorrectDisplayMs?: number;
    llmTurns: number;
    toolCallCount: number;
    finalValidationCount: number;
    toolSequence: string[];
    toolCounts: Record<string, number>;
    maxSystemPromptChars: number;
    maxTotalMessageChars: number;
  };
};

type TrainedPlanPrediction = {
  id?: string;
  caseId?: string;
  predicted?: unknown;
  predictionDurationMs?: number;
  model?: string;
  instructionPreset?: string;
  error?: string;
};

const referenceInstant = process.env['TEMPORAL_EVAL_NOW'] ?? '2026-05-24T12:00:00Z';
const timeZone = process.env['TEMPORAL_EVAL_TZ'] ?? 'America/New_York';
const openaiApiKey = nonBlank(process.env['OPENAI_API_KEY']);
const requireEval = isTruthy(process.env['TEMPORAL_EVAL_REQUIRE_OPENAI']);
const modelSpecs = parseModelSpecs(process.env['TEMPORAL_EVAL_MODELS']);
const trainedPlanPredictionsPath = process.env['TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS'];
const trainedPlanModelName = process.env['TEMPORAL_EVAL_TRAINED_PLAN_MODEL'] ?? 'trained-plan-ir';
const baselineSpecs = parseBaselineSpecs(process.env['TEMPORAL_EVAL_BASELINES']);
const experimentSpecs = parseExperimentSpecs(process.env['TEMPORAL_EVAL_EXPERIMENTS']);
const outputPath = process.env['TEMPORAL_EVAL_OUTPUT'];
const evalInputOutputPath = process.env['TEMPORAL_EVAL_EXPORT_INPUT'];
const limit = parsePositiveInt(process.env['TEMPORAL_EVAL_LIMIT']);
const repeats = parsePositiveInt(process.env['TEMPORAL_EVAL_REPEATS']) ?? 1;
const blockingRunners = splitList(process.env['TEMPORAL_EVAL_BLOCKING_RUNNERS'] ?? 'agent');
const includeExhaustiveRelativeOffsetEvals = isTruthy(process.env['TEMPORAL_EVAL_EXHAUSTIVE_RELATIVE_OFFSETS']);
let trainedPlanPredictionCache: Promise<Map<string, TrainedPlanPrediction>> | undefined;

const ENDPOINT_PLAN_INSTRUCTION_PRESETS = {
  detailed: 'Translate the temporal user input into compact Temporal Plan-IR JSON. Return JSON only. For time ranges, set plan kind=time_range with startStep and endStep candidate steps; the end must be after the start, so explicitly shift overnight end times. For explicit timezone text, emit resolve_timezone and reference it with timeZoneStep, or put an exact IANA/fixed-offset timezone string in timeZone. Use IANA/regional timezone intent for names like Eastern time, UK time, or Japan time; use fixed offsets only for explicit UTC/GMT offsets. For ambiguous abbreviations such as CST, IST, or BST, return clarification instead of choosing silently. For explicit 24-hour clock text like 13:37, preserve that clock text exactly; do not append am or pm. For Discord timestamps or bare 10/13/16/19 digit epoch-like numbers, pass the timestamp text to resolve_calendar_query. For negative or unsupported-length bare epoch-like numbers, return no_plan. For up to five repeated day-after modifiers before tomorrow, resolve tomorrow and emit one shift_datetime days delta equal to the repetition count; for longer chains return no_plan.',
  minimal: 'Translate the temporal user input into compact Temporal Plan-IR JSON. Return JSON only.',
} as const;

const SingleCallResponseSchema = z.object({
  status: z.enum(['resolved', 'needs_clarification', 'failed']),
  epoch: z.number().int().nullable(),
  suggestedFormatIndex: z.number().int().min(0).max(6).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  alternatives: z.array(z.object({
    label: z.string(),
    epoch: z.number().int(),
  })),
});

const CompactTemporalPlanPlannerJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'plans'],
  properties: {
    outcome: { type: 'string', enum: ['plans', 'clarification', 'no_plan'] },
    reason: { type: 'string' },
    clarificationQuestion: { type: ['string', 'null'] },
    plans: {
      type: 'array',
      maxItems: TEMPORAL_PLAN_MAX_PLANS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'steps'],
        properties: {
          kind: { type: 'string', enum: ['instant', 'time_range'] },
          label: { type: 'string' },
          rationale: { type: 'string' },
          assumptions: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          finalStep: { type: ['integer', 'null'], minimum: 0 },
          startStep: { type: ['integer', 'null'], minimum: 0 },
          endStep: { type: ['integer', 'null'], minimum: 0 },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: TEMPORAL_PLAN_MAX_STEPS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['op'],
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'resolve_calendar_query',
                    'resolve_weekday_anchor',
                    'resolve_holiday',
                    'resolve_clock_time',
                    'resolve_timezone',
                    'interpret_clock_phrase',
                    'shift_datetime',
                    'set_clock_time',
                    'combine_date_time',
                    'propose_candidate',
                  ],
                },
                query: { type: 'string' },
                text: { type: 'string' },
                holidayName: { type: 'string' },
                weekday: { type: 'string', enum: PLAN_WEEKDAYS },
                weekdayAnchor: { type: 'string', enum: ['upcoming', 'this', 'next', 'last', 'next_ambiguous', 'after_next_ambiguous'] },
                year: { type: 'integer', minimum: 1900, maximum: 2200 },
                baseStep: { type: 'integer', minimum: 0 },
                time: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['hour', 'minute'],
                  properties: {
                    hour: { type: 'integer', minimum: 0, maximum: 23 },
                    minute: { type: 'integer', minimum: 0, maximum: 59 },
                  },
                },
                timeStep: { type: 'integer', minimum: 0 },
                timeZoneStep: { type: 'integer', minimum: 0 },
                delta: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    years: { type: 'integer' },
                    months: { type: 'integer' },
                    weeks: { type: 'integer' },
                    days: { type: 'integer' },
                    hours: { type: 'integer' },
                    minutes: { type: 'integer' },
                  },
                },
                isoInstant: { type: 'string' },
                epochSeconds: { type: 'integer' },
                timeZone: { type: 'string' },
                precision: { type: 'string', enum: ['date', 'time', 'datetime', 'relative'] },
                assumptions: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
} as const;

type BareHourDateAnchorEvalSpec = {
  id: string;
  text: string;
  plainDate: { year: number; month: number; day: number };
  hour: number;
  minute?: number;
  referenceInstant?: string;
  timeZone?: string;
};

type RelativeOffsetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';

type RelativeOffsetDirection = 'ago' | 'from_now' | 'in';

type RelativeOffsetEvalSpec = {
  amount: number;
  unit: RelativeOffsetUnit;
  direction: RelativeOffsetDirection;
};

type BoundarySnapMode = 'ceil' | 'ceil_strict' | 'floor_strict' | 'nearest';

type BoundarySnapEvalSpec = {
  referenceInstant: string;
  timeZone: string;
  delta?: Temporal.DurationLike;
  boundaryMinutes: number;
  mode: BoundarySnapMode;
};

const relativeOffsetUnits: RelativeOffsetUnit[] = ['minutes', 'hours', 'days', 'weeks', 'months', 'years'];
const dateLikeRelativeOffsetUnits = new Set<RelativeOffsetUnit>(['days', 'weeks', 'months', 'years']);
const boundarySnapReferenceInstant = '2026-06-02T18:55:00Z';
const boundarySnapTimeZone = 'America/New_York';

function relativeOffsetEvalCases(): TemporalEvalCase[] {
  const specs: RelativeOffsetEvalSpec[] = [
    ...relativeOffsetSpecs([1, 60, 100], ['days'], ['from_now', 'ago', 'in']),
    ...relativeOffsetSpecs([2, 60, 100], ['weeks'], ['from_now', 'ago']),
    ...relativeOffsetSpecs([1, 12, 60, 100], ['months'], ['from_now', 'ago']),
    ...relativeOffsetSpecs([1, 10, 60, 100], ['years'], ['from_now', 'ago']),
    ...relativeOffsetSpecs([1, 60, 100], ['hours', 'minutes'], ['from_now', 'ago']),
  ];
  return specs.map(relativeOffsetEvalCase);
}

function exhaustiveRelativeOffsetEvalCases(): TemporalEvalCase[] {
  const specs: RelativeOffsetEvalSpec[] = [];
  for (let amount = 1; amount <= 100; amount += 1) {
    specs.push(...relativeOffsetSpecs([amount], relativeOffsetUnits, ['from_now', 'ago', 'in']));
  }
  return specs.map((spec) => ({
    ...relativeOffsetEvalCase(spec),
    id: `exhaustive-${relativeOffsetEvalCase(spec).id}`,
    category: 'relative-offset-exhaustive',
    required: false,
  }));
}

function relativeOffsetSpecs(amounts: number[], units: RelativeOffsetUnit[], directions: RelativeOffsetDirection[]): RelativeOffsetEvalSpec[] {
  return amounts.flatMap((amount) => units.flatMap((unit) => directions.map((direction) => ({ amount, unit, direction }))));
}

function relativeOffsetEvalCase(spec: RelativeOffsetEvalSpec): TemporalEvalCase {
  return {
    id: `relative-offset-${spec.direction.replace('_', '-')}-${spec.amount}-${spec.unit}`,
    text: relativeOffsetText(spec),
    category: 'relative-offset-numeric',
    expected: {
      status: 'resolved',
      epoch: epochForRelativeOffset(spec, referenceInstant, timeZone),
      suggestedFormatIndex: 6,
    },
  };
}

function relativeOffsetText(spec: RelativeOffsetEvalSpec): string {
  const unitText = pluralUnit(spec.amount, spec.unit);
  if (spec.direction === 'ago') {
    return `${spec.amount} ${unitText} ago`;
  }
  if (spec.direction === 'in') {
    return `in ${spec.amount} ${unitText}`;
  }
  return `${spec.amount} ${unitText} from now`;
}

function pluralUnit(amount: number, unit: RelativeOffsetUnit): string {
  return amount === 1 ? unit.slice(0, -1) : unit;
}

function epochForRelativeOffset(spec: RelativeOffsetEvalSpec, caseReferenceInstant: string, zone: string): number {
  const signedAmount = spec.direction === 'ago' ? -spec.amount : spec.amount;
  let target = Temporal.Instant.from(caseReferenceInstant).toZonedDateTimeISO(zone).add(relativeOffsetDuration(spec.unit, signedAmount));
  if (dateLikeRelativeOffsetUnits.has(spec.unit)) {
    target = target.with({ hour: 12, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  }
  return Math.floor(Number(target.epochMilliseconds) / 1000);
}

function relativeOffsetDuration(unit: RelativeOffsetUnit, amount: number): Temporal.DurationLike {
  switch (unit) {
    case 'minutes':
      return { minutes: amount };
    case 'hours':
      return { hours: amount };
    case 'days':
      return { days: amount };
    case 'weeks':
      return { weeks: amount };
    case 'months':
      return { months: amount };
    case 'years':
      return { years: amount };
  }
}

function boundarySnapEvalCases(): TemporalEvalCase[] {
  return [
    {
      id: 'boundary-snap-relative-hour-word',
      text: 'in five hours on the hour',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ delta: { hours: 5 }, boundaryMinutes: 60, mode: 'ceil', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 6 },
    },
    {
      id: 'boundary-snap-relative-top-of-hour',
      text: 'in 5 hours at the top of the hour',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ delta: { hours: 5 }, boundaryMinutes: 60, mode: 'ceil', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 6 },
    },
    {
      id: 'boundary-snap-nearest-hour',
      text: 'round to nearest hour',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ boundaryMinutes: 60, mode: 'nearest', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 4 },
    },
    {
      id: 'boundary-snap-nearest-quarter',
      text: 'round to nearest 15 minutes',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ boundaryMinutes: 15, mode: 'nearest', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 4 },
    },
    {
      id: 'boundary-snap-relative-nearest-quarter',
      text: 'in 23 minutes round to nearest 15 minutes',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ delta: { minutes: 23 }, boundaryMinutes: 15, mode: 'nearest', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 6 },
    },
    {
      id: 'boundary-snap-next-hour',
      text: 'next hour',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ boundaryMinutes: 60, mode: 'ceil_strict', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 4 },
    },
    {
      id: 'boundary-snap-previous-hour',
      text: 'previous hour',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ boundaryMinutes: 60, mode: 'floor_strict', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 4 },
    },
    {
      id: 'boundary-snap-hour-after-next',
      text: 'the hour after next',
      category: 'boundary-snap',
      referenceInstant: boundarySnapReferenceInstant,
      timeZone: boundarySnapTimeZone,
      expected: { status: 'resolved', epoch: epochForBoundarySnap({ delta: { hours: 1 }, boundaryMinutes: 60, mode: 'ceil_strict', referenceInstant: boundarySnapReferenceInstant, timeZone: boundarySnapTimeZone }), suggestedFormatIndex: 4 },
    },
  ];
}

function epochForBoundarySnap(spec: BoundarySnapEvalSpec): number {
  const reference = Temporal.Instant.from(spec.referenceInstant).toZonedDateTimeISO(spec.timeZone);
  const shifted = spec.delta === undefined ? reference : reference.add(spec.delta);
  const snapped = snapBoundaryForEval(shifted, spec.boundaryMinutes, spec.mode);
  return Math.floor(Number(snapped.epochMilliseconds) / 1000);
}

function epochForFirstOfMonth(caseReferenceInstant: string, zone: string, relativeMonth?: 'this' | 'next' | 'last', plainTime = '12:00'): number {
  const reference = Temporal.Instant.from(caseReferenceInstant).toZonedDateTimeISO(zone);
  let targetDate = reference.toPlainDate().with({ day: 1 });
  if (relativeMonth === 'next') {
    targetDate = targetDate.add({ months: 1 });
  } else if (relativeMonth === 'last') {
    targetDate = targetDate.subtract({ months: 1 });
  }
  let target = targetDate.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(plainTime) });
  if (relativeMonth === undefined && Temporal.Instant.compare(target.toInstant(), reference.toInstant()) <= 0) {
    targetDate = targetDate.add({ months: 1 });
    target = targetDate.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(plainTime) });
  }
  return Math.floor(Number(target.epochMilliseconds) / 1000);
}

function snapBoundaryForEval(zonedDateTime: Temporal.ZonedDateTime, boundaryMinutes: number, mode: BoundarySnapMode): Temporal.ZonedDateTime {
  const floor = floorBoundaryForEval(zonedDateTime, boundaryMinutes);
  const isExact = Temporal.Instant.compare(zonedDateTime.toInstant(), floor.toInstant()) === 0;
  if (mode === 'floor_strict') {
    return isExact ? floor.subtract({ minutes: boundaryMinutes }) : floor;
  }

  const next = floor.add({ minutes: boundaryMinutes });
  if (mode === 'ceil') {
    return isExact ? floor : next;
  }
  if (mode === 'ceil_strict') {
    return next;
  }

  const previousDistanceMs = Number(zonedDateTime.epochMilliseconds) - Number(floor.epochMilliseconds);
  const nextDistanceMs = Number(next.epochMilliseconds) - Number(zonedDateTime.epochMilliseconds);
  return nextDistanceMs <= previousDistanceMs ? next : floor;
}

function floorBoundaryForEval(zonedDateTime: Temporal.ZonedDateTime, boundaryMinutes: number): Temporal.ZonedDateTime {
  const totalMinutes = zonedDateTime.hour * 60 + zonedDateTime.minute;
  const floorTotalMinutes = Math.floor(totalMinutes / boundaryMinutes) * boundaryMinutes;
  return zonedDateTime.with({
    hour: Math.floor(floorTotalMinutes / 60),
    minute: floorTotalMinutes % 60,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
}

function shorthandRelativeEvalCases(): TemporalEvalCase[] {
  return [
    {
      id: 'relative-shorthand-tom-date',
      text: 'tom',
      category: 'relative-shorthand',
      expected: { status: 'resolved', epoch: epochForReferenceDateShift({ days: 1, hour: 12, minute: 0 }), suggestedFormatIndex: 1 },
    },
    {
      id: 'relative-shorthand-tmw-date',
      text: 'tmw',
      category: 'relative-shorthand',
      expected: { status: 'resolved', epoch: epochForReferenceDateShift({ days: 1, hour: 12, minute: 0 }), suggestedFormatIndex: 1 },
    },
    {
      id: 'relative-shorthand-tom-clock',
      text: 'tom at 5pm',
      category: 'relative-shorthand',
      expected: { status: 'resolved', epoch: epochForReferenceDateShift({ days: 1, hour: 17, minute: 0 }), suggestedFormatIndex: 4 },
    },
    {
      id: 'relative-shorthand-tmw-clock',
      text: 'tmw at 5pm',
      category: 'relative-shorthand',
      expected: { status: 'resolved', epoch: epochForReferenceDateShift({ days: 1, hour: 17, minute: 0 }), suggestedFormatIndex: 4 },
    },
  ];
}

function epochForReferenceDateShift(spec: { days: number; hour: number; minute: number }, caseReferenceInstant = referenceInstant, zone = timeZone): number {
  const shiftedDate = Temporal.Instant.from(caseReferenceInstant).toZonedDateTimeISO(zone).toPlainDate().add({ days: spec.days });
  return epochForLocalDateTime({ year: shiftedDate.year, month: shiftedDate.month, day: shiftedDate.day }, spec.hour, spec.minute, zone);
}

function bareHourDateAnchorEvalCases(): TemporalEvalCase[] {
  const monthDayHourSweep: BareHourDateAnchorEvalSpec[] = Array.from({ length: 12 }, (_, index) => {
    const hour = index + 1;
    const day = index + 10;
    return {
      id: `month-day-bare-hour-sweep-${hour}`,
      text: `june ${day} ${hour}`,
      plainDate: { year: 2026, month: 6, day },
      hour,
    };
  });
  return [
    ...monthDayHourSweep,
    {
      id: 'month-day-at-bare-hour-matrix',
      text: 'july 8 at 7',
      plainDate: { year: 2026, month: 7, day: 8 },
      hour: 7,
    },
    {
      id: 'full-date-bare-hour-matrix',
      text: 'July 15 2026 8',
      plainDate: { year: 2026, month: 7, day: 15 },
      hour: 8,
    },
    {
      id: 'iso-date-bare-hour-matrix',
      text: '2026-07-16 9',
      plainDate: { year: 2026, month: 7, day: 16 },
      hour: 9,
    },
    {
      id: 'month-day-bare-compact-minute-matrix',
      text: 'june 21 930',
      plainDate: { year: 2026, month: 6, day: 21 },
      hour: 9,
      minute: 30,
    },
  ].map(bareHourDateAnchorEvalCase);
}

function bareHourDateAnchorEvalCase(spec: BareHourDateAnchorEvalSpec): TemporalEvalCase {
  const caseTimeZone = spec.timeZone ?? timeZone;
  const minute = spec.minute ?? 0;
  const amHour = spec.hour === 12 ? 0 : spec.hour;
  const pmHour = spec.hour === 12 ? 12 : spec.hour + 12;
  return {
    id: spec.id,
    text: spec.text,
    category: 'date-bare-hour-clarification',
    ...(spec.referenceInstant === undefined ? {} : { referenceInstant: spec.referenceInstant }),
    ...(spec.timeZone === undefined ? {} : { timeZone: spec.timeZone }),
    expected: {
      status: 'needs_clarification',
      alternativeEpochs: [
        epochForLocalDateTime(spec.plainDate, amHour, minute, caseTimeZone),
        epochForLocalDateTime(spec.plainDate, pmHour, minute, caseTimeZone),
      ],
    },
  };
}

function epochForLocalDateTime(plainDate: { year: number; month: number; day: number }, hour: number, minute: number, zone: string): number {
  const zonedDateTime = Temporal.ZonedDateTime.from({
    timeZone: zone,
    year: plainDate.year,
    month: plainDate.month,
    day: plainDate.day,
    hour,
    minute,
  });
  return Math.floor(Number(zonedDateTime.epochMilliseconds) / 1000);
}

function timezoneEvalCases(): TemporalEvalCase[] {
  return [
    {
      id: 'timezone-iana-los-angeles',
      text: 'tomorrow at 5pm America/Los_Angeles',
      category: 'timezone-explicit-iana',
      expected: { status: 'resolved', epoch: epochForLocalDateTime({ year: 2026, month: 5, day: 25 }, 17, 0, 'America/Los_Angeles'), suggestedFormatIndex: 4 },
    },
    {
      id: 'timezone-named-uk-time',
      text: 'tomorrow at 5pm UK time',
      category: 'timezone-named-region',
      expected: { status: 'resolved', epoch: epochForLocalDateTime({ year: 2026, month: 5, day: 25 }, 17, 0, 'Europe/London'), suggestedFormatIndex: 4 },
    },
    {
      id: 'timezone-offset-utc-plus-two',
      text: 'tomorrow at 5pm UTC+2',
      category: 'timezone-fixed-offset',
      expected: { status: 'resolved', epoch: epochForLocalDateTime({ year: 2026, month: 5, day: 25 }, 17, 0, '+02:00'), suggestedFormatIndex: 4 },
    },
    {
      id: 'timezone-ambiguous-cst',
      text: 'tomorrow at 5pm CST',
      category: 'timezone-ambiguous-abbreviation',
      expected: { status: 'needs_clarification', alternativeEpochs: [] },
    },
    {
      id: 'timezone-dst-gap-fail-closed',
      text: '2026-03-08 at 2:30am Eastern time',
      category: 'timezone-dst-gap',
      expected: { status: 'failed' },
    },
  ];
}

function timeRangeEvalCases(): TemporalEvalCase[] {
  return [
    {
      id: 'range-relative-same-day-hyphen',
      text: 'tomorrow 3pm-5pm',
      category: 'time-range-relative',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 25 }, 15, 0, { year: 2026, month: 5, day: 25 }, 17, 0, timeZone, 4, 2) },
    },
    {
      id: 'range-relative-same-day-from-to',
      text: 'tomorrow from 3pm to 5pm',
      category: 'time-range-relative',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 25 }, 15, 0, { year: 2026, month: 5, day: 25 }, 17, 0, timeZone, 4, 2) },
    },
    {
      id: 'range-weekday-same-day',
      text: 'Friday 8pm-10:30pm',
      category: 'time-range-weekday',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 29 }, 20, 0, { year: 2026, month: 5, day: 29 }, 22, 30, timeZone, 5, 2) },
    },
    {
      id: 'range-explicit-date-same-day',
      text: 'May 29 2026 8pm-10:30pm',
      category: 'time-range-explicit-date',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 29 }, 20, 0, { year: 2026, month: 5, day: 29 }, 22, 30, timeZone, 4, 2) },
    },
    {
      id: 'range-24h-same-day',
      text: 'tomorrow 13:00-15:30',
      category: 'time-range-24h',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 25 }, 13, 0, { year: 2026, month: 5, day: 25 }, 15, 30, timeZone, 4, 2) },
    },
    {
      id: 'range-overnight-explicit',
      text: 'Friday 11pm-1am',
      category: 'time-range-overnight',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 29 }, 23, 0, { year: 2026, month: 5, day: 30 }, 1, 0, timeZone, 5, 5) },
    },
    {
      id: 'range-timezone-named-uk',
      text: 'tomorrow 3pm-5pm UK time',
      category: 'time-range-timezone',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 25 }, 15, 0, { year: 2026, month: 5, day: 25 }, 17, 0, 'Europe/London', 4, 2) },
    },
    {
      id: 'range-timezone-fixed-offset',
      text: 'tomorrow 3pm-5pm UTC+2',
      category: 'time-range-timezone',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 25 }, 15, 0, { year: 2026, month: 5, day: 25 }, 17, 0, '+02:00', 4, 2) },
    },
    {
      id: 'range-timezone-iana',
      text: 'May 25 2026 3pm-5pm America/Los_Angeles',
      category: 'time-range-timezone',
      expected: { status: 'resolved', range: rangeExpected({ year: 2026, month: 5, day: 25 }, 15, 0, { year: 2026, month: 5, day: 25 }, 17, 0, 'America/Los_Angeles', 4, 2) },
    },
    {
      id: 'range-next-weekday-clarification',
      text: 'next saturday 3pm-5pm',
      category: 'time-range-clarification',
      expected: {
        status: 'needs_clarification',
        alternativeEpochs: [],
        alternativeRanges: [
          rangeExpected({ year: 2026, month: 5, day: 30 }, 15, 0, { year: 2026, month: 5, day: 30 }, 17, 0, timeZone, 5, 2),
          rangeExpected({ year: 2026, month: 6, day: 6 }, 15, 0, { year: 2026, month: 6, day: 6 }, 17, 0, timeZone, 5, 2),
        ],
      },
    },
    {
      id: 'range-date-span-unsupported',
      text: 'Tuesday through Thursday',
      category: 'time-range-unsupported-date-span',
      expected: { status: 'failed' },
    },
    {
      id: 'range-schedule-block-unsupported',
      text: 'Tuesday through Thursday 3pm-5pm',
      category: 'time-range-unsupported-schedule-block',
      expected: { status: 'failed' },
    },
  ];
}

function rangeExpected(
  startDate: { year: number; month: number; day: number },
  startHour: number,
  startMinute: number,
  endDate: { year: number; month: number; day: number },
  endHour: number,
  endMinute: number,
  zone: string,
  startFormatIndex?: number,
  endFormatIndex?: number,
): ExpectedRange {
  return {
    startEpoch: epochForLocalDateTime(startDate, startHour, startMinute, zone),
    endEpoch: epochForLocalDateTime(endDate, endHour, endMinute, zone),
    ...(startFormatIndex === undefined ? {} : { startFormatIndex }),
    ...(endFormatIndex === undefined ? {} : { endFormatIndex }),
  };
}

const evalCases: TemporalEvalCase[] = [
  {
    id: 'relative-date-default-noon',
    text: 'tomorrow',
    category: 'deterministic-baseline',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 1 },
  },
  {
    id: 'month-boundary-first-of-month',
    text: 'first of the month',
    category: 'month-boundary',
    referenceInstant: boundarySnapReferenceInstant,
    timeZone: boundarySnapTimeZone,
    expected: { status: 'resolved', epoch: epochForFirstOfMonth(boundarySnapReferenceInstant, boundarySnapTimeZone), suggestedFormatIndex: 1 },
  },
  {
    id: 'month-boundary-first-of-this-month',
    text: 'first of this month',
    category: 'month-boundary-next-last',
    referenceInstant: boundarySnapReferenceInstant,
    timeZone: boundarySnapTimeZone,
    expected: { status: 'resolved', epoch: epochForFirstOfMonth(boundarySnapReferenceInstant, boundarySnapTimeZone, 'this'), suggestedFormatIndex: 1 },
  },
  {
    id: 'month-boundary-first-of-next-month',
    text: 'first of next month',
    category: 'month-boundary-next-last',
    referenceInstant: boundarySnapReferenceInstant,
    timeZone: boundarySnapTimeZone,
    expected: { status: 'resolved', epoch: epochForFirstOfMonth(boundarySnapReferenceInstant, boundarySnapTimeZone, 'next'), suggestedFormatIndex: 1 },
  },
  {
    id: 'month-boundary-first-of-last-month',
    text: 'first of last month',
    category: 'month-boundary-next-last',
    referenceInstant: boundarySnapReferenceInstant,
    timeZone: boundarySnapTimeZone,
    expected: { status: 'resolved', epoch: epochForFirstOfMonth(boundarySnapReferenceInstant, boundarySnapTimeZone, 'last'), suggestedFormatIndex: 1 },
  },
  {
    id: 'month-boundary-leading-clock-first-of-last-month',
    text: '5pm the first of last month',
    category: 'month-boundary-explicit-clock',
    referenceInstant: boundarySnapReferenceInstant,
    timeZone: boundarySnapTimeZone,
    expected: { status: 'resolved', epoch: epochForFirstOfMonth(boundarySnapReferenceInstant, boundarySnapTimeZone, 'last', '17:00'), suggestedFormatIndex: 4 },
  },
  ...shorthandRelativeEvalCases(),
  ...relativeOffsetEvalCases(),
  ...boundarySnapEvalCases(),
  ...timezoneEvalCases(),
  ...timeRangeEvalCases(),
  ...(includeExhaustiveRelativeOffsetEvals ? exhaustiveRelativeOffsetEvalCases() : []),
  {
    id: 'bare-hour-clarification',
    text: 'tom 430',
    category: 'clarification',
    expected: { status: 'needs_clarification', alternativeEpochs: [1779697800, 1779741000] },
  },
  {
    id: 'weekday-bare-hour-clarification',
    text: 'saturday at 3',
    category: 'clarification',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780124400, 1780167600] },
  },
  {
    id: 'anchor-offset-date',
    text: 'day after next saturday',
    category: 'agent-composition',
    expected: { status: 'resolved', epoch: 1780243200, suggestedFormatIndex: 6 },
  },
  {
    id: 'anchor-offset-clock',
    text: 'day after next saturday at 13:37',
    category: 'agent-composition',
    expected: { status: 'resolved', epoch: 1780249020, suggestedFormatIndex: 5 },
  },
  {
    id: 'direct-discord-timestamp',
    text: '<t:1779724800:F>',
    category: 'explicit-epoch',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 4 },
  },
  {
    id: 'direct-epoch-seconds',
    text: '1779724800',
    category: 'explicit-epoch',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 4 },
  },
  {
    id: 'direct-epoch-milliseconds',
    text: '1779724800000',
    category: 'explicit-epoch',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 4 },
  },
  {
    id: 'direct-epoch-microseconds',
    text: '1779724800000000',
    category: 'explicit-epoch',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 4 },
  },
  {
    id: 'direct-epoch-nanoseconds',
    text: '1779724800000000000',
    category: 'explicit-epoch',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 4 },
  },
  {
    id: 'direct-epoch-zero',
    text: '0',
    category: 'explicit-epoch',
    expected: { status: 'resolved', epoch: 0, suggestedFormatIndex: 4 },
  },
  {
    id: 'negative-epoch-rejected',
    text: '-1',
    category: 'explicit-epoch-rejection',
    expected: { status: 'failed' },
  },
  {
    id: 'huge-epoch-rejected',
    text: '999999999999999999999999999999',
    category: 'explicit-epoch-rejection',
    expected: { status: 'failed' },
  },
  {
    id: 'anchor-offset-fuzzy-clock',
    text: 'day after next saturday at l33t time',
    category: 'fuzzy-clock',
    expected: { status: 'resolved', epoch: 1780249020, suggestedFormatIndex: 5 },
  },
  {
    id: 'weekday-fuzzy-clock',
    text: 'next saturday at l33t time',
    category: 'fuzzy-clock',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780162620, 1780767420] },
  },
  {
    id: 'compound-typo-cultural-clock',
    text: 'day after a week from tomorrow at 133t time',
    category: 'plan-ir-composition',
    expected: { status: 'resolved', epoch: 1780421820, suggestedFormatIndex: 4 },
  },
  {
    id: 'chained-day-after-tomorrow-5',
    text: 'the day after the day after the day after the day after the day after tomorrow',
    category: 'recursive-composition',
    expected: { status: 'resolved', epoch: 1780156800 },
  },
  {
    id: 'iso-date-space-time',
    text: '2026-05-29 20:00',
    category: 'date-format-variance',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'month-name-date-time',
    text: 'May 29 2026 8pm',
    category: 'date-format-variance',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'us-slash-date-time',
    text: '05/29/2026 8pm',
    category: 'date-format-variance',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'day-month-slash-date-time',
    text: '29/05/2026 20:00',
    category: 'date-format-variance',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'weekday-typo-short-tu-clock',
    text: '10pm tu',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1779847200 },
  },
  {
    id: 'weekday-typo-added-letter-tuee-clock',
    text: 'tuee 7pm',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1779836400 },
  },
  {
    id: 'weekday-typo-missing-tail-wedn-clock',
    text: 'wedn 6pm',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1779919200 },
  },
  {
    id: 'weekday-typo-missing-vowel-thrs-clock',
    text: 'thrs 9pm',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1780016400 },
  },
  {
    id: 'weekday-typo-added-letter-frii-clock',
    text: 'frii 5pm',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1780088400 },
  },
  {
    id: 'weekday-typo-added-tail-satdy-clock',
    text: 'satdy 2pm',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1780164000 },
  },
  {
    id: 'relative-typo-tmrw-explicit-clock-spacing',
    text: 'TMRW   4:30pm',
    category: 'relative-typo-whitespace',
    expected: { status: 'resolved', epoch: 1779741000, suggestedFormatIndex: 4 },
  },
  {
    id: 'relative-typo-tomorrrow-24h-clock',
    text: 'tomorrrow 16:30',
    category: 'relative-typo-clock-format',
    expected: { status: 'resolved', epoch: 1779741000, suggestedFormatIndex: 4 },
  },
  {
    id: 'relative-typo-tmrw-bare-compact-clock',
    text: 'tmrw 430',
    category: 'relative-typo-clarification',
    expected: { status: 'needs_clarification', alternativeEpochs: [1779697800, 1779741000] },
  },
  {
    id: 'next-weekday-typo-fri-clock-clarification',
    text: 'nextt fri 8pm',
    category: 'weekday-typo-boundary-ambiguity',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780099200, 1780704000] },
  },
  {
    id: 'next-weekday-typo-satdy-clock-clarification',
    text: 'nextt satdy at 5pm',
    category: 'weekday-typo-boundary-ambiguity',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780174800, 1780779600] },
  },
  {
    id: 'anchor-offset-typo-weekday-relative-clock',
    text: 'day aftr next satturday at 13:37',
    category: 'typo-composition',
    expected: { status: 'resolved', epoch: 1780249020, suggestedFormatIndex: 4 },
  },
  {
    id: 'date-spacing-month-name-clock',
    text: 'May   29     2026    8pm',
    category: 'normalization-whitespace',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'date-uppercase-month-clock',
    text: 'MAY 29 2026 8PM',
    category: 'normalization-casing',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'date-dot-separator-clock',
    text: '2026.05.29 20:00',
    category: 'date-separator-variance',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'date-space-separated-ymd-clock',
    text: '2026   05   29   20:00',
    category: 'date-separator-variance',
    expected: { status: 'resolved', epoch: 1780099200, suggestedFormatIndex: 4 },
  },
  {
    id: 'month-typo-september-clock',
    text: 'septmber 3 2026 10pm',
    category: 'month-typo',
    expected: { status: 'resolved', epoch: 1788487200, suggestedFormatIndex: 4 },
  },
  {
    id: 'diagnostic-month-typo-suffix-bare-minute-clarification',
    text: 'first of Febuarysdf 2:30',
    category: 'diagnostic-month-typo-bare-minute',
    required: false,
    expected: {
      status: 'needs_clarification',
      alternativeEpochs: [
        epochForLocalDateTime({ year: 2027, month: 2, day: 1 }, 2, 30, timeZone),
        epochForLocalDateTime({ year: 2027, month: 2, day: 1 }, 14, 30, timeZone),
      ],
    },
  },
  {
    id: 'month-abbrev-dot-clock-separator',
    text: 'jun 3 2026 10.00pm',
    category: 'clock-separator-variance',
    expected: { status: 'resolved', epoch: 1780538400, suggestedFormatIndex: 4 },
  },
  {
    id: 'weekday-typo-full-monnday-clock',
    text: 'monnday 9am',
    category: 'weekday-typo',
    expected: { status: 'resolved', epoch: 1779714000, suggestedFormatIndex: 4 },
  },
  {
    id: 'event-post-multiline-typo-weekday-times',
    text: 'Club night:\nFrii May 29\nDoors 8pm\nMain set 10:30pm',
    category: 'event-post-typo-multiline',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780099200, 1780108200] },
  },
  {
    id: 'event-post-month-typo-two-times',
    text: 'fri mayy 29 doors 8pm main 10:30pm',
    category: 'event-post-typo-multi-time',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780099200, 1780108200] },
  },
  {
    id: 'recursive-relative-typo-tomorow-2',
    text: 'the day after the day after tomorow',
    category: 'recursive-typo-composition',
    expected: { status: 'resolved', epoch: 1779897600 },
  },
  {
    id: 'weekday-after-next-clarification',
    text: 'sunday after next',
    category: 'clarification',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780848000, 1781452800] },
  },
  {
    id: 'explicit-year-holiday',
    text: 'easter 2026 noon',
    category: 'holiday',
    expected: { status: 'resolved', epoch: 1775404800, suggestedFormatIndex: 4 },
  },
  {
    id: 'future-year-holiday',
    text: 'easter 2028',
    category: 'holiday',
    expected: { status: 'resolved', epoch: 1839513600, suggestedFormatIndex: 1 },
  },
  {
    id: 'ordinal-weekday-next-month-clock',
    text: 'first sunday of next month at 1pm',
    category: 'calendar-grammar',
    expected: { status: 'resolved', epoch: 1780851600, suggestedFormatIndex: 5 },
  },
  {
    id: 'ordinal-weekday-explicit-month-name',
    text: 'first tuesday of July',
    category: 'calendar-grammar',
    referenceInstant: '2026-06-03T12:00:00Z',
    timeZone: 'America/New_York',
    expected: { status: 'resolved', epoch: epochForLocalDateTime({ year: 2026, month: 7, day: 7 }, 12, 0, 'America/New_York'), suggestedFormatIndex: 1 },
  },
  {
    id: 'ordinal-weekday-explicit-month-name-rollover',
    text: 'first tuesday of July',
    category: 'calendar-grammar',
    referenceInstant: '2026-08-01T12:00:00Z',
    timeZone: 'America/New_York',
    expected: { status: 'resolved', epoch: epochForLocalDateTime({ year: 2027, month: 7, day: 6 }, 12, 0, 'America/New_York'), suggestedFormatIndex: 1 },
  },
  {
    id: 'ordinal-weekday-shift-relative-noon',
    text: 'the day after the first sunday of next month at one hour past noon and 10 minutes',
    category: 'calendar-grammar',
    expected: { status: 'resolved', epoch: 1780938600, suggestedFormatIndex: 5 },
  },
  {
    id: 'relative-anchor-bare-minute-clarification',
    text: 'day after tomorrow 11:34',
    category: 'bare-minute-clarification',
    expected: {
      status: 'needs_clarification',
      alternativeEpochs: [
        epochForReferenceDateShift({ days: 2, hour: 11, minute: 34 }),
        epochForReferenceDateShift({ days: 2, hour: 23, minute: 34 }),
      ],
    },
  },
  {
    id: 'weekday-leading-bare-minute-clarification',
    text: '4:30 Tuesday',
    category: 'bare-minute-clarification',
    expected: {
      status: 'needs_clarification',
      alternativeEpochs: [
        epochForLocalDateTime({ year: 2026, month: 5, day: 26 }, 4, 30, timeZone),
        epochForLocalDateTime({ year: 2026, month: 5, day: 26 }, 16, 30, timeZone),
      ],
    },
  },
  {
    id: 'next-weekday-clock-clarification',
    text: 'next saturday at 5pm',
    category: 'weekday-boundary-ambiguity',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780174800, 1780779600] },
  },
  {
    id: 'simple-weekday-shortcut-pressure',
    text: 'next tuesday',
    category: 'weekday-boundary-ambiguity',
    expected: { status: 'needs_clarification', alternativeEpochs: [1779811200, 1780416000] },
  },
  {
    id: 'current-week-next-weekday-bare-clarification',
    text: 'next saturday',
    category: 'weekday-boundary-ambiguity',
    referenceInstant: '2026-05-29T16:00:00Z',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780156800, 1780761600] },
  },
  {
    id: 'event-post-text-start-end',
    text: 'Club night: Friday May 29, doors 8pm, main set 10:30pm',
    category: 'future-event-extraction-pressure',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780099200, 1780108200] },
  },
  {
    id: 'weekday-short-ambiguous-clock-suffix-six-way',
    text: 'tu 5pma',
    category: 'diagnostic-ambiguous-manual-input',
    referenceInstant: '2026-06-02T04:50:00Z',
    timeZone: 'America/New_York',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780390800, 1780434000, 1780477200, 1780520400, 1780995600, 1781038800] },
  },
  {
    id: 'bare-24h-hour-before-target',
    text: '19',
    category: 'bare-24h-hour',
    expected: { status: 'resolved', epoch: 1779663600, suggestedFormatIndex: 4 },
  },
  {
    id: 'bare-24h-hour-after-target-rollover',
    text: '19',
    category: 'bare-24h-hour',
    referenceInstant: '2026-05-25T01:00:00Z',
    timeZone: 'America/New_York',
    expected: { status: 'resolved', epoch: 1779750000, suggestedFormatIndex: 4 },
  },
  ...bareHourDateAnchorEvalCases(),
  {
    id: 'month-day-bare-hour-clarification',
    text: 'may 5 5',
    category: 'date-bare-hour-clarification',
    referenceInstant: '2026-06-02T04:50:00Z',
    timeZone: 'America/New_York',
    expected: { status: 'needs_clarification', alternativeEpochs: [1809507600, 1809550800] },
  },
];

async function main() {
  const runnerSpecs: EvalRunnerSpec[] = [...modelSpecs, ...baselineSpecs];
  const cases = limit === undefined ? evalCases : evalCases.slice(0, limit);
  if (evalInputOutputPath !== undefined) {
    await writeEvalInputRows(cases, evalInputOutputPath);
  }
  if (runnerSpecs.length === 0) {
    if (requireEval) {
      throw new Error('TEMPORAL_EVAL_MODELS or TEMPORAL_EVAL_BASELINES is required when TEMPORAL_EVAL_REQUIRE_OPENAI=1.');
    }
    console.log('Skipping temporal model eval because TEMPORAL_EVAL_MODELS and TEMPORAL_EVAL_BASELINES are not configured.');
    return;
  }

  if (runnerSpecs.some(requiresOpenAi) && openaiApiKey === undefined) {
    if (requireEval) {
      throw new Error('OPENAI_API_KEY is required when TEMPORAL_EVAL_REQUIRE_OPENAI=1.');
    }
    console.log('Skipping OpenAI temporal eval runners because OPENAI_API_KEY is not configured.');
  }

  const results: EvalResult[] = [];
  for (const modelSpec of runnerSpecs.filter((spec) => !requiresOpenAi(spec) || openaiApiKey !== undefined)) {
    for (const experimentSpec of experimentSpecs) {
      for (const evalCase of cases) {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          results.push(await runCase(modelSpec, experimentSpec, evalCase, repeat));
        }
      }
    }
  }

  printSummary(results);
  if (outputPath !== undefined) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ referenceInstant, timeZone, experiments: experimentSpecs, results }, null, 2)}\n`, 'utf8');
    console.log(`Wrote temporal eval results to ${outputPath}`);
  }

  if (results.some((result) => result.required && !result.passed && blockingRunners.includes(result.runner))) {
    process.exitCode = 1;
  }
}

function requiresOpenAi(modelSpec: EvalRunnerSpec): modelSpec is ModelSpec {
  return modelSpec.runner === 'agent' || modelSpec.runner === 'single_call';
}

async function runCase(modelSpec: EvalRunnerSpec, experimentSpec: EvalExperimentSpec, evalCase: TemporalEvalCase, repeat: number): Promise<EvalResult> {
  const startedAt = Date.now();
  const predictionInstructionPreset = await instructionPresetForCase(modelSpec, evalCase.id);
  try {
    const parsed = await runEvalRunner(modelSpec, experimentSpec, evalCase);
    const durationMs = Date.now() - startedAt;
    const mismatch = evaluateParsed(evalCase, parsed);
    return {
      experimentLabel: experimentSpec.label,
      featureFlags: experimentSpec.featureFlags,
      runner: modelSpec.runner,
      model: modelSpec.model,
      provider: modelSpec.provider,
      reasoningEffort: modelSpec.reasoningEffort,
      caseId: evalCase.id,
      repeat,
      text: evalCase.text,
      category: evalCase.category,
      required: evalCase.required ?? true,
      passed: mismatch === undefined,
      durationMs,
      status: parsed.status,
      kind: parsed.kind,
      epoch: parsed.epoch,
      suggestedFormatIndex: parsed.suggestedFormatIndex,
      range: parsed.range,
      confidence: parsed.confidence,
      method: parsed.method,
      instructionPreset: parsed.debug?.instructionPreset ?? predictionInstructionPreset,
      mismatch,
      metrics: metricsFromResponse(parsed, evalCase, durationMs),
    };
  } catch (error) {
    return {
      experimentLabel: experimentSpec.label,
      featureFlags: experimentSpec.featureFlags,
      runner: modelSpec.runner,
      model: modelSpec.model,
      provider: modelSpec.provider,
      reasoningEffort: modelSpec.reasoningEffort,
      caseId: evalCase.id,
      repeat,
      text: evalCase.text,
      category: evalCase.category,
      required: evalCase.required ?? true,
      passed: false,
      durationMs: Date.now() - startedAt,
      instructionPreset: predictionInstructionPreset,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function instructionPresetForCase(modelSpec: EvalRunnerSpec, caseId: string): Promise<string | undefined> {
  if (modelSpec.runner === 'endpoint_plan') {
    return modelSpec.instructionPreset;
  }
  if (modelSpec.runner === 'trained_plan') {
    try {
      return (await trainedPlanPredictionForCase(modelSpec, caseId)).instructionPreset;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function runEvalRunner(modelSpec: EvalRunnerSpec, experimentSpec: EvalExperimentSpec, evalCase: TemporalEvalCase): Promise<EvalParsed> {
  const caseReferenceInstant = evalCase.referenceInstant ?? referenceInstant;
  const caseTimeZone = evalCase.timeZone ?? timeZone;
  if (modelSpec.runner === 'deterministic') {
    return parseTemporalExpression({ text: evalCase.text, timeZone: caseTimeZone, referenceInstant: caseReferenceInstant, features: experimentSpec.featureFlags });
  }

  if (modelSpec.runner === 'trained_plan') {
    return runTrainedPlanPrediction(modelSpec, experimentSpec, evalCase);
  }

  if (modelSpec.runner === 'endpoint_plan') {
    return runEndpointPlanPrediction(modelSpec, experimentSpec, evalCase);
  }

  if (modelSpec.runner === 'single_call') {
    return runSingleCallBaseline(modelSpec, experimentSpec, evalCase);
  }

  return parseTemporalExpression({
    text: evalCase.text,
    timeZone: caseTimeZone,
    referenceInstant: caseReferenceInstant,
    openaiApiKey: openaiApiKey!,
    openaiModel: modelSpec.model,
    openaiReasoningEffort: modelSpec.reasoningEffort,
    features: experimentSpec.featureFlags,
    langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
  });
}

async function runTrainedPlanPrediction(modelSpec: TrainedPlanSpec, experimentSpec: EvalExperimentSpec, evalCase: TemporalEvalCase): Promise<EvalParsed> {
  const prediction = await trainedPlanPredictionForCase(modelSpec, evalCase.id);
  if (prediction.error !== undefined) {
    throw new Error(prediction.error);
  }
  const predicted = parsePredictedPlanIr(prediction.predicted);
  const caseReferenceInstant = evalCase.referenceInstant ?? referenceInstant;
  const caseTimeZone = evalCase.timeZone ?? timeZone;
  const response = await executeTemporalPlanPlannerOutput(
    predicted,
    { text: evalCase.text, calendarContext: parseCalendarContext(caseTimeZone, caseReferenceInstant) },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      features: experimentSpec.featureFlags,
      ...(openaiApiKey === undefined ? {} : {
        openaiApiKey,
        openaiModel: process.env['OPENAI_MODEL'] ?? 'gpt-5.5',
        openaiReasoningEffort: process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
        langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
      }),
      method: 'agent+plan',
      modelName: prediction.model ?? modelSpec.model,
      planningDurationMs: prediction.predictionDurationMs,
    },
  );
  response.debug = response.debug ?? {};
  response.debug.reasoningEffort = modelSpec.reasoningEffort;
  response.debug.instructionPreset = prediction.instructionPreset;
  response.debug.featureFlags = experimentSpec.featureFlags;
  return response;
}

async function runEndpointPlanPrediction(modelSpec: EndpointPlanSpec, experimentSpec: EvalExperimentSpec, evalCase: TemporalEvalCase): Promise<EvalParsed> {
  const caseReferenceInstant = evalCase.referenceInstant ?? referenceInstant;
  const caseTimeZone = evalCase.timeZone ?? timeZone;
  const prompt = formatEndpointPlanPrompt({
    text: evalCase.text,
    referenceInstant: caseReferenceInstant,
    timeZone: caseTimeZone,
  }, modelSpec.instructionPreset, modelSpec.promptFormat);
  const llmStartedAt = Date.now();
  const completion = await invokeOpenAiCompatibleEndpoint(modelSpec, prompt);
  const planningDurationMs = Date.now() - llmStartedAt;
  let predicted: ReturnType<typeof parsePredictedPlanIr>;
  try {
    predicted = parsePredictedPlanIr(completion.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Endpoint Plan-IR parse failed: ${message}. Content preview: ${completion.content.slice(0, 1000)}`);
  }
  const response = await executeTemporalPlanPlannerOutput(
    predicted,
    { text: evalCase.text, calendarContext: parseCalendarContext(caseTimeZone, caseReferenceInstant) },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      features: experimentSpec.featureFlags,
      ...(openaiApiKey === undefined ? {} : {
        openaiApiKey,
        openaiModel: process.env['OPENAI_MODEL'] ?? 'gpt-5.5',
        openaiReasoningEffort: process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
        langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
      }),
      method: 'agent+plan',
      modelName: modelSpec.model,
      planningDurationMs,
    },
  );
  const llmTrace: TemporalAgentTraceStep = {
    index: 1,
    type: 'llm',
    name: `${modelSpec.api}_endpoint_plan`,
    durationMs: planningDurationMs,
    input: {
      endpoint: endpointUrl(modelSpec),
      messageCount: modelSpec.api === 'chat' ? 1 : 0,
      systemPromptChars: 0,
      totalMessageChars: prompt.length,
      responseFormat: modelSpec.responseFormat,
      promptFormat: modelSpec.promptFormat,
    },
    output: {
      content: completion.content,
      finishReason: completion.finishReason,
      usage: completion.usage,
    },
  };
  response.debug = response.debug ?? {};
  response.debug.reasoningEffort = modelSpec.reasoningEffort;
  response.debug.instructionPreset = modelSpec.instructionPreset;
  response.debug.promptFormat = modelSpec.promptFormat;
  response.debug.featureFlags = experimentSpec.featureFlags;
  response.debug.firstLlmResponseMs = planningDurationMs;
  response.debug.trace = reindexTrace([llmTrace, ...(response.debug.trace ?? [])]);
  return response;
}

async function runSingleCallBaseline(modelSpec: ModelSpec, experimentSpec: EvalExperimentSpec, evalCase: TemporalEvalCase): Promise<EvalParsed> {
  const startedAt = Date.now();
  const caseReferenceInstant = evalCase.referenceInstant ?? referenceInstant;
  const caseTimeZone = evalCase.timeZone ?? timeZone;
  const system = `Convert natural language temporal text into one exact timestamp or an explicit clarification request.

Return JSON matching the requested schema only.
Use epoch seconds for all timestamps.
Reference instant: ${caseReferenceInstant}
Time zone: ${caseTimeZone}
Discord format indexes: 0 short date, 1 long date, 2 short time, 3 long time, 4 short date/time, 5 long date/time, 6 relative.
If AM/PM, "next weekday", or another phrase is materially ambiguous, return needs_clarification with alternatives.
Do not call tools. Do not explain outside the schema.`;
  const human = JSON.stringify({ text: evalCase.text, referenceInstant: caseReferenceInstant, timeZone: caseTimeZone });
  const model = createChatModel(modelSpec.model, modelSpec.reasoningEffort).withStructuredOutput(SingleCallResponseSchema);
  const result = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const durationMs = Date.now() - startedAt;
  const parsed: EvalParsed = {
    status: result.status,
    confidence: result.confidence,
    method: 'single-call',
    debug: {
      model: modelSpec.model,
      reasoningEffort: modelSpec.reasoningEffort,
      featureFlags: experimentSpec.featureFlags,
      totalDurationMs: durationMs,
      agentDurationMs: durationMs,
      firstLlmResponseMs: durationMs,
      finalResponseMs: durationMs,
      trace: [{
        index: 1,
        type: 'llm',
        name: 'single_call',
        durationMs,
        input: {
          messageCount: 2,
          systemPromptChars: system.length,
          totalMessageChars: system.length + human.length,
        },
        output: result,
      }],
    },
  };
  if (result.epoch !== null) {
    parsed.epoch = result.epoch;
  }
  if (result.suggestedFormatIndex !== null) {
    parsed.suggestedFormatIndex = result.suggestedFormatIndex;
  }
  if (result.status !== 'failed') {
    parsed.debug!.firstCandidateMs = durationMs;
  }
  if (result.alternatives.length > 0) {
    parsed.clarificationAlternatives = result.alternatives.map((alternative) => ({ epoch: alternative.epoch }));
  }
  return parsed;
}

type EndpointCompletion = {
  content: string;
  finishReason?: string;
  usage?: unknown;
};

async function invokeOpenAiCompatibleEndpoint(modelSpec: EndpointPlanSpec, prompt: string): Promise<EndpointCompletion> {
  if (modelSpec.transport === 'runpod_queue') {
    return invokeRunPodQueueEndpoint(modelSpec, prompt);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelSpec.timeoutMs);
  try {
    const payload = endpointPayload(modelSpec, prompt);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (modelSpec.apiKey !== undefined) {
      headers['Authorization'] = `Bearer ${modelSpec.apiKey}`;
    }
    const response = await fetch(endpointUrl(modelSpec), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
    }
    const body = JSON.parse(bodyText) as OpenAiCompatibleResponse;
    return endpointCompletionFromResponse(body, modelSpec.api);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Endpoint request timed out after ${modelSpec.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type RunPodQueueResponse = {
  status?: unknown;
  output?: unknown;
  error?: unknown;
};

async function invokeRunPodQueueEndpoint(modelSpec: EndpointPlanSpec, prompt: string): Promise<EndpointCompletion> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelSpec.timeoutMs);
  try {
    const payload = endpointPayload(modelSpec, prompt);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (modelSpec.apiKey !== undefined) {
      headers['Authorization'] = `Bearer ${modelSpec.apiKey}`;
    }
    const response = await fetch(runPodQueueUrl(modelSpec), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: {
          openai_route: openAiRoute(modelSpec),
          openai_input: payload,
        },
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`RunPod queue returned HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
    }
    const body = JSON.parse(bodyText) as RunPodQueueResponse;
    if (body.status !== 'COMPLETED') {
      throw new Error(`RunPod queue returned status ${String(body.status)}: ${JSON.stringify(body.error ?? body).slice(0, 1000)}`);
    }
    if (!isJsonObject(body.output)) {
      throw new Error(`RunPod queue response did not include object output: ${JSON.stringify(body).slice(0, 1000)}`);
    }
    return endpointCompletionFromResponse(body.output as OpenAiCompatibleResponse, modelSpec.api);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`RunPod queue request timed out after ${modelSpec.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type OpenAiCompatibleResponse = {
  choices?: Array<{
    text?: unknown;
    finish_reason?: unknown;
    message?: {
      content?: unknown;
    };
  }>;
  usage?: unknown;
};

function endpointCompletionFromResponse(body: OpenAiCompatibleResponse, api: EndpointPlanSpec['api']): EndpointCompletion {
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new Error('Endpoint response did not include choices[0].');
  }
  const content = api === 'chat' ? choice.message?.content : choice.text;
  if (typeof content !== 'string') {
    throw new Error(`Endpoint response did not include string ${api === 'chat' ? 'choices[0].message.content' : 'choices[0].text'}.`);
  }
  return {
    content: content.trim(),
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    usage: body.usage,
  };
}

function endpointPayload(modelSpec: EndpointPlanSpec, prompt: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: modelSpec.model,
    temperature: modelSpec.temperature,
  };
  if (modelSpec.api === 'chat') {
    payload['messages'] = [{ role: 'user', content: prompt }];
    payload['max_tokens'] = modelSpec.maxTokens;
  } else {
    payload['prompt'] = prompt;
    payload['max_tokens'] = modelSpec.maxTokens;
  }

  applyEndpointResponseFormat(payload, modelSpec.responseFormat);
  if (modelSpec.extraBody !== undefined) {
    Object.assign(payload, modelSpec.extraBody);
  }
  return payload;
}

function applyEndpointResponseFormat(payload: Record<string, unknown>, responseFormat: EndpointPlanSpec['responseFormat']): void {
  if (responseFormat === 'none') {
    return;
  }
  if (responseFormat === 'json_schema') {
    payload['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: 'compact_temporal_plan_ir',
        schema: CompactTemporalPlanPlannerJsonSchema,
      },
    };
    return;
  }
  payload['structured_outputs'] = {
    json: CompactTemporalPlanPlannerJsonSchema,
  };
}

function endpointUrl(modelSpec: EndpointPlanSpec): string {
  if (modelSpec.transport === 'runpod_queue') {
    return runPodQueueUrl(modelSpec);
  }
  const baseUrl = modelSpec.baseUrl.replace(/\/+$/, '');
  const versionedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  return `${versionedBaseUrl}/${modelSpec.api === 'chat' ? 'chat/completions' : 'completions'}`;
}

function openAiRoute(modelSpec: EndpointPlanSpec): '/v1/chat/completions' | '/v1/completions' {
  return modelSpec.api === 'chat' ? '/v1/chat/completions' : '/v1/completions';
}

function runPodQueueUrl(modelSpec: EndpointPlanSpec): string {
  const baseUrl = modelSpec.baseUrl.replace(/\/+$/, '');
  return `${baseUrl}/runsync`;
}

function formatEndpointPlanPrompt(input: { text: string; referenceInstant: string; timeZone: string }, instructionPreset: EndpointPlanSpec['instructionPreset'], promptFormat: EndpointPlanSpec['promptFormat']): string {
  const instruction = ENDPOINT_PLAN_INSTRUCTION_PRESETS[instructionPreset];
  if (promptFormat === 'chat') {
    return `${instruction}\n\nInput:\n${formatEndpointInputJson(input)}`;
  }
  return `### Instruction:\n${instruction}\n\n### Input:\n${formatEndpointInputJson(input)}\n\n### Response:\n`;
}

function formatEndpointInputJson(input: { text: string; referenceInstant: string; timeZone: string }): string {
  const entries = [
    ['referenceInstant', input.referenceInstant],
    ['text', input.text],
    ['timeZone', input.timeZone],
  ];
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')}}`;
}

function reindexTrace(trace: TemporalAgentTraceStep[]): TemporalAgentTraceStep[] {
  return trace.map((step, index) => ({ ...step, index: index + 1 }));
}

function evaluateParsed(evalCase: TemporalEvalCase, parsed: EvalParsed): string | undefined {
  if (parsed.status !== evalCase.expected.status) {
    return `expected status ${evalCase.expected.status}, got ${parsed.status}`;
  }

  if (evalCase.expected.status === 'resolved') {
    if (evalCase.expected.range !== undefined) {
      const mismatch = rangeMismatch(evalCase.expected.range, parsed.range);
      if (mismatch !== undefined) {
        return mismatch;
      }
      return undefined;
    }
    if (parsed.epoch !== evalCase.expected.epoch) {
      return `expected epoch ${evalCase.expected.epoch ?? 'none'}, got ${parsed.epoch ?? 'none'}`;
    }
    if (evalCase.expected.suggestedFormatIndex !== undefined && parsed.suggestedFormatIndex !== evalCase.expected.suggestedFormatIndex) {
      return `expected format ${evalCase.expected.suggestedFormatIndex}, got ${parsed.suggestedFormatIndex ?? 'none'}`;
    }
    return undefined;
  }

  if (evalCase.expected.status === 'failed') {
    return undefined;
  }

  if (evalCase.expected.alternativeRanges !== undefined) {
    const actualRanges = [...(parsed.clarificationAlternatives ?? [])]
      .map((alternative) => alternative.range)
      .filter((range): range is NonNullable<TemporalParseResponse['range']> => range !== undefined)
      .map(rangeKeyForEval)
      .sort();
    const expectedRanges = evalCase.expected.alternativeRanges.map(expectedRangeKey).sort();
    if (JSON.stringify(actualRanges) !== JSON.stringify(expectedRanges)) {
      return `expected range alternatives ${expectedRanges.join(',')}, got ${actualRanges.join(',') || 'none'}`;
    }
  } else {
    const actual = [...(parsed.clarificationAlternatives ?? [])]
      .map((alternative) => alternative.epoch)
      .sort((a, b) => a - b);
    const expected = [...evalCase.expected.alternativeEpochs].sort((a, b) => a - b);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `expected alternatives ${expected.join(',')}, got ${actual.join(',') || 'none'}`;
    }
  }
  return undefined;
}

function rangeMismatch(expected: ExpectedRange, actual: TemporalParseResponse['range'] | undefined): string | undefined {
  if (actual === undefined) {
    return `expected range ${expectedRangeKey(expected)}, got none`;
  }
  if (actual.start.epoch !== expected.startEpoch || actual.end.epoch !== expected.endEpoch) {
    return `expected range ${expectedRangeKey(expected)}, got ${rangeKeyForEval(actual)}`;
  }
  if (expected.startFormatIndex !== undefined && actual.start.suggestedFormatIndex !== expected.startFormatIndex) {
    return `expected range start format ${expected.startFormatIndex}, got ${actual.start.suggestedFormatIndex}`;
  }
  if (expected.endFormatIndex !== undefined && actual.end.suggestedFormatIndex !== expected.endFormatIndex) {
    return `expected range end format ${expected.endFormatIndex}, got ${actual.end.suggestedFormatIndex}`;
  }
  return undefined;
}

function rangeKeyForEval(range: NonNullable<TemporalParseResponse['range']>): string {
  return `${range.start.epoch}:${range.end.epoch}`;
}

function expectedRangeKey(range: ExpectedRange): string {
  return `${range.startEpoch}:${range.endEpoch}`;
}

function metricsFromResponse(parsed: EvalParsed, evalCase: TemporalEvalCase, durationMs: number): EvalResult['metrics'] {
  const trace = parsed.debug?.trace ?? [];
  const llmDurationMs = trace
    .filter((step) => step.type === 'llm')
    .reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const toolDurationMs = trace
    .filter((step) => step.type === 'tool')
    .reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const finalValidationDurationMs = trace
    .filter((step) => step.type === 'final_validation')
    .reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const promptInputs = trace
    .filter((step) => step.type === 'llm')
    .map((step) => step.input)
    .filter(isPromptMetrics);
  const toolSequence = trace.filter((step) => step.type === 'tool').map((step) => step.name);
  const toolCounts = countBy(toolSequence);

  return {
    agentAttempts: parsed.debug?.agentAttempts,
    toolPasses: parsed.debug?.toolPasses,
    totalDurationMs: parsed.debug?.totalDurationMs,
    agentDurationMs: parsed.debug?.agentDurationMs,
    deterministicDurationMs: parsed.debug?.deterministicDurationMs,
    firstLlmResponseMs: parsed.debug?.firstLlmResponseMs,
    firstCandidateMs: parsed.debug?.firstCandidateMs,
    finalResponseMs: parsed.debug?.finalResponseMs,
    llmDurationMs,
    toolDurationMs,
    finalValidationDurationMs,
    firstCorrectDisplayMs: firstCorrectDisplayMs(evalCase, parsed, durationMs),
    llmTurns: trace.filter((step) => step.type === 'llm').length,
    toolCallCount: toolSequence.length,
    finalValidationCount: trace.filter((step) => step.type === 'final_validation').length,
    toolSequence,
    toolCounts,
    maxSystemPromptChars: Math.max(0, ...promptInputs.map((input) => input.systemPromptChars)),
    maxTotalMessageChars: Math.max(0, ...promptInputs.map((input) => input.totalMessageChars)),
  };
}

function firstCorrectDisplayMs(evalCase: TemporalEvalCase, parsed: EvalParsed, durationMs: number): number | undefined {
  if (evalCase.expected.status === 'resolved') {
    if (parsed.status !== 'resolved') {
      return undefined;
    }
    if (evalCase.expected.range !== undefined) {
      if (rangeMismatch(evalCase.expected.range, parsed.range) !== undefined) {
        return undefined;
      }
    } else if (parsed.epoch !== evalCase.expected.epoch) {
      return undefined;
    }
    if (parsed.method === 'deterministic') {
      return parsed.debug?.deterministicDurationMs ?? durationMs;
    }
    return parsed.debug?.finalResponseMs ?? durationMs;
  }

  if (evalCase.expected.status === 'failed') {
    return parsed.status === 'failed' ? parsed.debug?.finalResponseMs ?? durationMs : undefined;
  }

  if (parsed.status !== 'needs_clarification') {
    return undefined;
  }
  if (evalCase.expected.alternativeRanges !== undefined) {
    const actualRanges = [...(parsed.clarificationAlternatives ?? [])]
      .map((alternative) => alternative.range)
      .filter((range): range is NonNullable<TemporalParseResponse['range']> => range !== undefined)
      .map(rangeKeyForEval)
      .sort();
    const expectedRanges = evalCase.expected.alternativeRanges.map(expectedRangeKey).sort();
    if (JSON.stringify(actualRanges) !== JSON.stringify(expectedRanges)) {
      return undefined;
    }
  } else {
    const actual = [...(parsed.clarificationAlternatives ?? [])]
      .map((alternative) => alternative.epoch)
      .sort((a, b) => a - b);
    const expected = [...evalCase.expected.alternativeEpochs].sort((a, b) => a - b);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return undefined;
    }
  }
  if (parsed.method === 'fallback') {
    return parsed.debug?.ambiguityPolicyDurationMs ?? parsed.debug?.deterministicDurationMs ?? durationMs;
  }
  return parsed.debug?.finalResponseMs ?? durationMs;
}

function isPromptMetrics(value: unknown): value is { systemPromptChars: number; totalMessageChars: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['systemPromptChars'] === 'number' && typeof record['totalMessageChars'] === 'number';
}

function printSummary(results: EvalResult[]) {
  for (const modelKey of unique(results.map((result) => `${result.experimentLabel}:${result.runner}:${result.model}:${result.reasoningEffort}:${result.instructionPreset ?? ''}`))) {
    const modelResults = results.filter((result) => `${result.experimentLabel}:${result.runner}:${result.model}:${result.reasoningEffort}:${result.instructionPreset ?? ''}` === modelKey);
    const firstResult = modelResults[0]!;
    const requiredResults = modelResults.filter((result) => result.required);
    const diagnosticResults = modelResults.filter((result) => !result.required);
    const passed = requiredResults.filter((result) => result.passed).length;
    const diagnosticPassed = diagnosticResults.filter((result) => result.passed).length;
    const durations = modelResults.map((result) => result.durationMs).sort((a, b) => a - b);
    const firstCorrectDurations = modelResults
      .map((result) => result.metrics?.firstCorrectDisplayMs)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    const median = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);
    const medianFirstCorrect = firstCorrectDurations.length === 0 ? undefined : percentile(firstCorrectDurations, 0.5);
    const p95FirstCorrect = firstCorrectDurations.length === 0 ? undefined : percentile(firstCorrectDurations, 0.95);
    const maxPromptChars = Math.max(0, ...modelResults.map((result) => result.metrics?.maxTotalMessageChars ?? 0));
    const meanTools = mean(modelResults.map((result) => result.metrics?.toolCallCount ?? 0));
    const meanLlmTurns = mean(modelResults.map((result) => result.metrics?.llmTurns ?? 0));
    const meanFirstLlm = mean(modelResults.map((result) => result.metrics?.firstLlmResponseMs ?? 0));
    const diagnosticSummary = diagnosticResults.length > 0 ? `, diagnostics=${diagnosticPassed}/${diagnosticResults.length}` : '';
    const promptSummary = firstResult.instructionPreset === undefined ? '' : ` prompt=${firstResult.instructionPreset}`;
    console.log(`${firstResult.experimentLabel} ${firstResult.runner}/${firstResult.model}${promptSummary}: required=${passed}/${requiredResults.length}${diagnosticSummary}, firstCorrectMedian=${formatMs(medianFirstCorrect)}, firstCorrectP95=${formatMs(p95FirstCorrect)}, finalMedian=${median}ms, finalP95=${p95}ms, tools=${meanTools.toFixed(1)}, llmTurns=${meanLlmTurns.toFixed(1)}, firstLlm=${Math.round(meanFirstLlm)}ms, maxPromptChars=${maxPromptChars}`);
    for (const result of modelResults) {
      const status = result.required ? (result.passed ? 'PASS' : 'FAIL') : (result.passed ? 'DIAG-PASS' : 'DIAG');
      const detail = result.error ?? result.mismatch ?? `${result.status} epoch=${result.epoch ?? 'none'}`;
      const repeatSuffix = repeats > 1 ? `#${result.repeat}` : '';
      console.log(`  ${status} ${result.caseId}${repeatSuffix}: ${detail} (${result.durationMs}ms)`);
    }
  }
}

function parseExperimentSpecs(value: string | undefined): EvalExperimentSpec[] {
  const entries = splitSemicolonList(value);
  if (entries.length === 0) {
    return [{ label: 'default', featureFlags: {} }];
  }

  return entries.map((entry, index) => {
    const separator = entry.indexOf(':');
    const label = separator >= 0 ? entry.slice(0, separator).trim() : `experiment-${index + 1}`;
    const flagsText = separator >= 0 ? entry.slice(separator + 1).trim() : entry;
    return {
      label: label.length > 0 ? label : `experiment-${index + 1}`,
      featureFlags: parseFeatureFlags(flagsText),
    };
  });
}

function parseFeatureFlags(value: string): TemporalFeatureFlags {
  const flags: TemporalFeatureFlags = {};
  for (const assignment of splitList(value)) {
    const [rawName, rawValue] = assignment.split('=');
    if (rawName === undefined || rawValue === undefined) {
      throw new Error(`Feature flag assignment must be name=value: ${assignment}`);
    }
    flags[normalizeFeatureName(rawName)] = parseBooleanFlag(rawValue);
  }
  return flags;
}

function normalizeFeatureName(value: string): keyof TemporalFeatureFlags {
  const normalized = value.trim().toLowerCase().replace(/^temporal_feature_/, '').replace(/[-_]/g, '');
  if (normalized === 'ordinalweekdaygrammar') {
    return 'ordinalWeekdayGrammar';
  }
  if (normalized === 'deterministicpreflight') {
    return 'deterministicPreflight';
  }
  if (normalized === 'planir') {
    return 'planIr';
  }
  if (normalized === 'semanticconsistencygate') {
    return 'semanticConsistencyGate';
  }
  throw new Error(`Unknown temporal feature flag: ${value}`);
}

function parseBooleanFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  throw new Error(`Feature flag value must be boolean-like, got: ${value}`);
}

function parseModelSpecs(value: string | undefined): ModelSpec[] {
  return splitList(value).map((entry) => {
    const [model, reasoningEffort] = entry.split(':');
    return {
      runner: 'agent',
      provider: 'openai',
      model: model ?? entry,
      reasoningEffort: reasoningEffort ?? process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
    };
  });
}

function parseBaselineSpecs(value: string | undefined): EvalRunnerSpec[] {
  return splitList(value).map((entry) => {
    if (entry === 'deterministic') {
      return { runner: 'deterministic', provider: 'local', model: 'deterministic', reasoningEffort: 'none' };
    }

    if (entry === 'trained-plan') {
      if (trainedPlanPredictionsPath === undefined || trainedPlanPredictionsPath.trim() === '') {
        throw new Error('TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS is required for TEMPORAL_EVAL_BASELINES=trained-plan.');
      }
      return {
        runner: 'trained_plan',
        provider: 'local',
        model: trainedPlanModelName,
        reasoningEffort: 'none',
        predictionsPath: trainedPlanPredictionsPath,
      };
    }

    if (entry === 'endpoint-plan') {
      return parseEndpointPlanSpec();
    }

    const [kind, model, reasoningEffort] = entry.split(':');
    if ((kind === 'single' || kind === 'single-call') && model !== undefined && model.length > 0) {
      return {
        runner: 'single_call',
        provider: 'openai',
        model,
        reasoningEffort: reasoningEffort ?? process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
      };
    }

    throw new Error(`Unknown TEMPORAL_EVAL_BASELINES entry: ${entry}`);
  });
}

function parseEndpointPlanSpec(): EndpointPlanSpec {
  const baseUrl = nonBlank(process.env['TEMPORAL_EVAL_ENDPOINT_BASE_URL']);
  if (baseUrl === undefined) {
    throw new Error('TEMPORAL_EVAL_ENDPOINT_BASE_URL is required for TEMPORAL_EVAL_BASELINES=endpoint-plan.');
  }
  const model = nonBlank(process.env['TEMPORAL_EVAL_ENDPOINT_MODEL']);
  if (model === undefined) {
    throw new Error('TEMPORAL_EVAL_ENDPOINT_MODEL is required for TEMPORAL_EVAL_BASELINES=endpoint-plan.');
  }
  return {
    runner: 'endpoint_plan',
    provider: process.env['TEMPORAL_EVAL_ENDPOINT_PROVIDER'] ?? 'openai-compatible',
    model,
    reasoningEffort: 'none',
    baseUrl,
    apiKey: nonBlank(process.env['TEMPORAL_EVAL_ENDPOINT_API_KEY']),
    api: parseEndpointApi(process.env['TEMPORAL_EVAL_ENDPOINT_API']),
    transport: parseEndpointTransport(process.env['TEMPORAL_EVAL_ENDPOINT_TRANSPORT'], process.env['TEMPORAL_EVAL_ENDPOINT_PROVIDER']),
    instructionPreset: parseEndpointInstructionPreset(process.env['TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET']),
    promptFormat: parseEndpointPromptFormat(process.env['TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT']),
    maxTokens: parsePositiveInt(process.env['TEMPORAL_EVAL_ENDPOINT_MAX_TOKENS']) ?? 512,
    temperature: parseFiniteNumber(process.env['TEMPORAL_EVAL_ENDPOINT_TEMPERATURE']) ?? 0,
    timeoutMs: parsePositiveInt(process.env['TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS']) ?? 30000,
    responseFormat: parseEndpointResponseFormat(process.env['TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT']),
    extraBody: parseOptionalJsonObject(process.env['TEMPORAL_EVAL_ENDPOINT_EXTRA_BODY'], 'TEMPORAL_EVAL_ENDPOINT_EXTRA_BODY'),
  };
}

function parseEndpointApi(value: string | undefined): EndpointPlanSpec['api'] {
  const normalized = value?.trim().toLowerCase() || 'chat';
  if (normalized === 'chat' || normalized === 'chat-completions' || normalized === 'chat_completions') {
    return 'chat';
  }
  if (normalized === 'completion' || normalized === 'completions') {
    return 'completions';
  }
  throw new Error(`TEMPORAL_EVAL_ENDPOINT_API must be chat or completions, got: ${value}`);
}

function parseEndpointTransport(value: string | undefined, provider: string | undefined): EndpointPlanSpec['transport'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return provider?.includes('runpod-peft') || provider?.includes('runpod-queue') ? 'runpod_queue' : 'openai';
  }
  if (normalized === 'openai' || normalized === 'openai-compatible' || normalized === 'http') {
    return 'openai';
  }
  if (normalized === 'runpod_queue' || normalized === 'runpod-queue' || normalized === 'runpod') {
    return 'runpod_queue';
  }
  throw new Error(`TEMPORAL_EVAL_ENDPOINT_TRANSPORT must be openai or runpod_queue, got: ${value}`);
}

function parseEndpointInstructionPreset(value: string | undefined): EndpointPlanSpec['instructionPreset'] {
  const normalized = value?.trim().toLowerCase() || 'minimal';
  if (normalized === 'detailed' || normalized === 'minimal') {
    return normalized;
  }
  throw new Error(`TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET must be detailed or minimal, got: ${value}`);
}

function parseEndpointPromptFormat(value: string | undefined): EndpointPlanSpec['promptFormat'] {
  const normalized = value?.trim().toLowerCase() || 'custom';
  if (normalized === 'custom' || normalized === 'chat') {
    return normalized;
  }
  throw new Error(`TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT must be custom or chat, got: ${value}`);
}

function parseEndpointResponseFormat(value: string | undefined): EndpointPlanSpec['responseFormat'] {
  const normalized = value?.trim().toLowerCase() || 'json_schema';
  if (normalized === 'none' || normalized === 'off') {
    return 'none';
  }
  if (normalized === 'json_schema' || normalized === 'response_format' || normalized === 'response-format') {
    return 'json_schema';
  }
  if (normalized === 'structured_outputs_json' || normalized === 'structured-output-json' || normalized === 'structured_outputs') {
    return 'structured_outputs_json';
  }
  throw new Error(`TEMPORAL_EVAL_ENDPOINT_RESPONSE_FORMAT must be none, json_schema, or structured_outputs_json, got: ${value}`);
}

function createChatModel(model: string, reasoningEffort: string): ChatOpenAI {
  if (model.startsWith('gpt-5')) {
    return new ChatOpenAI({ apiKey: openaiApiKey!, model, reasoning: { effort: normalizeReasoningEffort(reasoningEffort), summary: 'auto' }, useResponsesApi: true });
  }
  return new ChatOpenAI({ apiKey: openaiApiKey!, model, temperature: 0 });
}

async function writeEvalInputRows(cases: TemporalEvalCase[], path: string): Promise<void> {
  const rows = cases.map((evalCase) => ({
    id: evalCase.id,
    split: 'holdout',
    category: evalCase.category,
    required: evalCase.required ?? true,
    input: {
      text: evalCase.text,
      referenceInstant: evalCase.referenceInstant ?? referenceInstant,
      timeZone: evalCase.timeZone ?? timeZone,
    },
    expected: evalCase.expected,
  }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  console.log(`Wrote temporal eval model input rows to ${path}`);
}

async function trainedPlanPredictionForCase(modelSpec: TrainedPlanSpec, caseId: string): Promise<TrainedPlanPrediction> {
  trainedPlanPredictionCache ??= readTrainedPlanPredictions(modelSpec.predictionsPath);
  const predictions = await trainedPlanPredictionCache;
  const prediction = predictions.get(caseId);
  if (prediction === undefined) {
    throw new Error(`No trained Plan-IR prediction found for ${caseId} in ${modelSpec.predictionsPath}.`);
  }
  return prediction;
}

async function readTrainedPlanPredictions(path: string): Promise<Map<string, TrainedPlanPrediction>> {
  const rows = (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TrainedPlanPrediction);
  const predictions = new Map<string, TrainedPlanPrediction>();
  for (const row of rows) {
    const key = row.caseId ?? row.id;
    if (key === undefined || key.length === 0) {
      throw new Error(`Trained Plan-IR prediction row is missing id/caseId in ${path}.`);
    }
    predictions.set(key, row);
  }
  return predictions;
}

function parsePredictedPlanIr(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try {
      return parseTemporalPlanPlannerOutput(JSON.parse(trimmed));
    } catch {
      return parseTemporalPlanPlannerOutput(JSON.parse(extractFirstJsonObject(trimmed)));
    }
  }
  return parseTemporalPlanPlannerOutput(value);
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error('Prediction did not contain a JSON object.');
  }
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  throw new Error('Prediction JSON object was not balanced.');
}

function normalizeReasoningEffort(effort: string): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'none' || effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  return 'low';
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function splitSemicolonList(value: string | undefined): string[] {
  return (value ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index] ?? 0;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value}ms`;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalJsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
