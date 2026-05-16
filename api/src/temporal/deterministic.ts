import { Temporal, Intl as TemporalIntl } from '@js-temporal/polyfill';
import * as chrono from 'chrono-node';
import type {
  CalendarContext,
  Candidate,
  CandidateFacts,
  TemporalPrecision,
  Weekday,
} from './types';
import type {
  CandidateFactsInput,
  FormatCandidateInput,
  ParseExpressionInput,
  ParseExpressionOutput,
  ResolveCalendarQueryInput,
  ResolveCalendarQueryOutput,
  ShiftDateTimeInput,
  ValidateCandidateInput,
  ValidateCandidateOutput,
} from './tools';

const WEEKDAY_LOOKUP: Record<Weekday, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const WEEKDAY_NAMES: Record<number, Weekday> = {
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
  7: 'sunday',
};

const WEEKDAY_PATTERN = /\b(?:(this|next|last)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const DISCORD_TIMESTAMP_PATTERN = /<t:(\d+)(?::[tTdDfFR])?>/;

export function parseCalendarContext(timeZone: string, referenceInstant = new Date().toISOString()): CalendarContext {
  return { referenceInstant, timeZone };
}

export async function parseExpression(input: ParseExpressionInput): Promise<ParseExpressionOutput> {
  const explicit = parseExplicitTimestamp(input.text, input.calendarContext);
  if (explicit) {
    return { candidates: [explicit], parserNotes: ['Matched explicit timestamp.'] };
  }

  const chronoCandidate = parseWithChrono(input.text, input.calendarContext);
  if (chronoCandidate) {
    return { candidates: [chronoCandidate], parserNotes: ['Matched chrono-node parse.'] };
  }

  return { candidates: [], parserNotes: ['No deterministic parse candidate found.'] };
}

export async function resolveCalendarQuery(input: ResolveCalendarQueryInput): Promise<ResolveCalendarQueryOutput> {
  const parsed = await parseExpression({ text: input.query, calendarContext: input.calendarContext });
  return {
    candidates: parsed.candidates,
    source: parsed.candidates[0]?.provenance ?? 'chrono',
    notes: parsed.parserNotes,
  };
}

export async function shiftDateTime(input: ShiftDateTimeInput): Promise<Candidate> {
  const base = getBaseZonedDateTime(input);
  const shifted = base.add(input.delta);
  return createCandidate(shifted, 'relative', ['Applied timezone-aware duration shift.'], 'shift_math');
}

export async function formatCandidate(input: FormatCandidateInput): Promise<string> {
  const zdt = Temporal.ZonedDateTime.from(input.candidate.zonedDateTime);
  const locale = input.calendarContext.locale ?? 'en-US';

  if (input.style === 'discord-preview') {
    const epoch = Math.floor(Number(zdt.epochMilliseconds) / 1000);
    return `<t:${epoch}:f> / <t:${epoch}:R>`;
  }

  if (input.style === 'weekday-check') {
    return `${weekdayFromTemporal(zdt.dayOfWeek)}, ${zdt.toPlainDate().toString()} at ${zdt.toPlainTime().toString({ smallestUnit: 'minute' })} ${zdt.timeZoneId}`;
  }

  const formatter = new TemporalIntl.DateTimeFormat(locale, {
    dateStyle: input.style === 'full' ? 'full' : 'medium',
    timeStyle: input.candidate.precision === 'date' ? undefined : 'short',
    timeZone: input.calendarContext.timeZone,
  });

  return formatter.format(zdt.toInstant());
}

export async function candidateFacts(input: CandidateFactsInput): Promise<CandidateFacts> {
  const zdt = Temporal.ZonedDateTime.from(input.candidate.zonedDateTime).withTimeZone(input.calendarContext.timeZone);
  const facts: CandidateFacts = {
    weekday: weekdayFromTemporal(zdt.dayOfWeek),
    isoDate: zdt.toPlainDate().toString(),
    isoInstant: zdt.toInstant().toString(),
    dayOfWeek: zdt.dayOfWeek,
    month: zdt.month,
    year: zdt.year,
    timeZone: zdt.timeZoneId,
  };
  if (zdt.weekOfYear !== undefined) {
    facts.weekOfYear = zdt.weekOfYear;
  }
  return facts;
}

export async function validateCandidate(input: ValidateCandidateInput): Promise<ValidateCandidateOutput> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ambiguity: string[] = [];
  const facts = await candidateFacts({ candidate: input.candidate, calendarContext: input.calendarContext });
  const requestedWeekday = extractWeekday(input.originalText);

  if (requestedWeekday && requestedWeekday !== facts.weekday) {
    errors.push(`Input mentioned ${requestedWeekday}, but candidate is ${facts.weekday}.`);
  }

  if (input.candidate.precision === 'date') {
    warnings.push('Date-only input is represented at noon in the selected timezone for Discord timestamp compatibility.');
  }

  return {
    passed: errors.length === 0,
    warnings,
    errors,
    ambiguity,
    suggestedFormatIndex: suggestedFormatIndex(input.originalText, input.candidate.precision),
  };
}

export function candidateToEpoch(candidate: Candidate): number {
  return Math.floor(Number(Temporal.Instant.from(candidate.isoInstant).epochMilliseconds) / 1000);
}

export function candidateFromProposal(params: {
  isoInstant: string;
  timeZone: string;
  precision: TemporalPrecision;
  assumptions: string[];
}): Candidate {
  const instant = Temporal.Instant.from(params.isoInstant);
  return createCandidate(
    instant.toZonedDateTimeISO(params.timeZone),
    params.precision,
    params.assumptions,
    'explicit',
  );
}

function parseExplicitTimestamp(text: string, calendarContext: CalendarContext): Candidate | null {
  const discordMatch = DISCORD_TIMESTAMP_PATTERN.exec(text);
  if (discordMatch?.[1]) {
    const epoch = Number(discordMatch[1]);
    const instant = Temporal.Instant.fromEpochMilliseconds(epoch * 1000);
    return createCandidate(
      instant.toZonedDateTimeISO(calendarContext.timeZone),
      'datetime',
      ['Used explicit Discord timestamp from input.'],
      'explicit',
    );
  }

  try {
    const instant = Temporal.Instant.from(text.trim());
    return createCandidate(
      instant.toZonedDateTimeISO(calendarContext.timeZone),
      'datetime',
      ['Used explicit ISO instant from input.'],
      'explicit',
    );
  } catch {
    return null;
  }
}

function parseWithChrono(text: string, calendarContext: CalendarContext): Candidate | null {
  const reference = referenceZdt(calendarContext);
  const referenceDate = new Date(
    reference.year,
    reference.month - 1,
    reference.day,
    reference.hour,
    reference.minute,
    reference.second,
    reference.millisecond,
  );
  const results = chrono.parse(text, referenceDate, { forwardDate: true });
  const first = results[0];
  if (!first) {
    return null;
  }

  const start = first.start;
  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (!year || !month || !day) {
    return null;
  }

  const hasTime = start.isCertain('hour') || /\b(noon|midnight|morning|afternoon|evening|tonight|\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)?)\b/i.test(text);
  const hour = start.get('hour') ?? 12;
  const minute = start.get('minute') ?? 0;
  const second = start.get('second') ?? 0;
  const millisecond = start.get('millisecond') ?? 0;
  const zonedDateTime = Temporal.ZonedDateTime.from({
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    timeZone: calendarContext.timeZone,
  });
  const assumptions = ['Parsed with chrono-node using user calendar context.'];
  if (!hasTime) {
    assumptions.push('Defaulted date-only expression to 12:00 PM local time.');
  }

  return createCandidate(zonedDateTime, hasTime ? 'datetime' : 'date', assumptions, 'chrono');
}

function getBaseZonedDateTime(input: ShiftDateTimeInput): Temporal.ZonedDateTime {
  if ('isoInstant' in input.base) {
    return Temporal.Instant.from(input.base.isoInstant).toZonedDateTimeISO(input.calendarContext.timeZone);
  }

  if ('plainDate' in input.base) {
    return Temporal.PlainDate.from(input.base.plainDate).toZonedDateTime({
      timeZone: input.base.timeZone,
      plainTime: Temporal.PlainTime.from('12:00'),
    });
  }

  return Temporal.ZonedDateTime.from(input.base.zonedDateTime);
}

function referenceZdt(calendarContext: CalendarContext): Temporal.ZonedDateTime {
  return Temporal.Instant.from(calendarContext.referenceInstant).toZonedDateTimeISO(calendarContext.timeZone);
}

function createCandidate(
  zonedDateTime: Temporal.ZonedDateTime,
  precision: TemporalPrecision,
  assumptions: string[],
  provenance: Candidate['provenance'],
): Candidate {
  return {
    id: `cand_${zonedDateTime.epochMilliseconds}_${provenance}`,
    isoInstant: zonedDateTime.toInstant().toString(),
    zonedDateTime: zonedDateTime.toString(),
    timeZone: zonedDateTime.timeZoneId,
    precision,
    assumptions,
    provenance,
  };
}

function extractWeekday(text: string): Weekday | null {
  const match = WEEKDAY_PATTERN.exec(text);
  const weekday = match?.[2]?.toLowerCase() as Weekday | undefined;
  if (!weekday || !isWeekday(weekday)) {
    return null;
  }

  return weekday;
}

function isWeekday(value: string): value is Weekday {
  return Object.prototype.hasOwnProperty.call(WEEKDAY_LOOKUP, value);
}

function weekdayFromTemporal(dayOfWeek: number): Weekday {
  const weekday = WEEKDAY_NAMES[dayOfWeek];
  if (!weekday) {
    throw new Error(`Invalid Temporal dayOfWeek: ${dayOfWeek}`);
  }
  return weekday;
}

function suggestedFormatIndex(text: string, precision: TemporalPrecision): number {
  if (/\b(in|ago)\b/i.test(text)) {
    return 6;
  }
  if (precision === 'date') {
    return 1;
  }
  if (precision === 'time') {
    return 2;
  }
  return 4;
}
