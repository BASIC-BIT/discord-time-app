import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_MONTH_NAMES, TemporalPlanPlannerSchema, type TemporalPlan, type TemporalPlanPlannerOutput, type TemporalPlanStep } from '../src/temporal/plan-ir';

type Split = 'train' | 'validation' | 'holdout';

type TemporalIrTrainingRow = {
  id: string;
  split: Split;
  tags: string[];
  input: {
    text: string;
    referenceInstant: string;
    timeZone: string;
  };
  output: TemporalPlanPlannerOutput;
};

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutputPath = join(apiRoot, 'reports', 'temporal-ml', 'temporal-ir-seeds.jsonl');
const outputPath = process.env['TEMPORAL_IR_SYNTHETIC_OUTPUT'] ?? defaultOutputPath;
const referenceInstant = process.env['TEMPORAL_IR_SYNTHETIC_NOW'] ?? '2026-05-24T12:00:00Z';
const timeZone = process.env['TEMPORAL_IR_SYNTHETIC_TZ'] ?? 'America/New_York';
const randomRowCount = parseNonNegativeInt(process.env['TEMPORAL_IR_SYNTHETIC_RANDOM_COUNT']) ?? 2400;

async function main() {
  const rows = buildRows().map(validateRow);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const counts = countBy(rows.map((row) => row.split));
  console.log(`Wrote ${rows.length} Temporal IR seed rows to ${outputPath}`);
  console.log(`Splits: train=${counts.train ?? 0}, validation=${counts.validation ?? 0}, holdout=${counts.holdout ?? 0}`);
}

function buildRows(): TemporalIrTrainingRow[] {
  return [
    row({
      id: 'relative-tomorrow',
      text: 'tomorrow',
      tags: ['relative', 'date-only'],
      output: planner('plans', 'Resolve the relative date directly.', [plan('Tomorrow', [step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' })])]),
    }),
    row({
      id: 'relative-tomorrow-explicit-clock',
      text: 'tomorrow at 5pm',
      tags: ['relative', 'explicit-clock'],
      output: planner('plans', 'Resolve the relative date and explicit clock separately.', [plan('Tomorrow 5 PM', [
        step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: '5pm' }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)]),
    }),
    row({
      id: 'relative-duration',
      text: 'in 3 days',
      tags: ['relative', 'duration'],
      output: planner('plans', 'Resolve the relative duration directly.', [plan('In 3 days', [step({ operation: 'resolve_calendar_query', query: 'in 3 days', precision: 'relative' })])]),
    }),
    ...relativeOffsetSeedRows(),
    ...relativeShorthandSeedRows(),
    ...monthBoundarySeedRows(),
    ...boundarySnapSeedRows(),
    row({
      id: 'chained-day-after-tomorrow-5',
      text: 'the day after the day after the day after the day after the day after tomorrow',
      tags: ['relative', 'recursive-composition', 'offset'],
      output: planner('plans', 'Collapse bounded repeated day-after modifiers into one day shift.', [plan('Five days after tomorrow', [
        step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
        step({ operation: 'shift_datetime', baseStep: 0, delta: delta({ days: 5 }), precision: 'relative' }),
      ], 1)]),
    }),
    row({
      id: 'anchor-offset-date',
      text: 'day after next saturday',
      tags: ['weekday-anchor', 'offset'],
      output: planner('plans', 'Use next Saturday as the anchor and shift by one day.', [plan('Day after next Saturday', [
        step({ operation: 'resolve_calendar_query', query: 'next saturday', precision: 'date' }),
        step({ operation: 'shift_datetime', baseStep: 0, delta: delta({ days: 1 }), precision: 'relative' }),
      ], 1)]),
    }),
    row({
      id: 'anchor-offset-clock-24h',
      text: 'day after next saturday at 13:37',
      tags: ['weekday-anchor', 'offset', 'explicit-clock', 'clock-24h'],
      output: planner('plans', 'Use next Saturday as the anchor, preserve the explicit 24-hour clock, and shift by one day.', [plan('Day after next Saturday at 13:37', [
        step({ operation: 'resolve_calendar_query', query: 'next saturday', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: '13:37' }),
        step({ operation: 'shift_datetime', baseStep: 0, timeStep: 1, delta: delta({ days: 1 }), precision: 'datetime' }),
      ], 2)]),
    }),
    ...standardGroundingSeedRows(),
    ...bareTwentyFourHourSeedRows(),
    ...explicitTimestampRows(),
    row({
      id: 'anchor-offset-fuzzy-clock',
      text: 'day after next saturday at l33t time',
      tags: ['weekday-anchor', 'offset', 'fuzzy-clock'],
      output: planner('plans', 'Resolve the anchor, infer leet time as 13:37, and shift by one day.', [plan('Day after next Saturday at leet time', [
        step({ operation: 'resolve_calendar_query', query: 'next saturday', precision: 'date' }),
        step({ operation: 'interpret_clock_phrase', text: 'l33t time', time: { hour: 13, minute: 37 } }),
        step({ operation: 'shift_datetime', baseStep: 0, timeStep: 1, delta: delta({ days: 1 }), precision: 'datetime' }),
      ], 2)]),
    }),
    row({
      id: 'next-weekday-bare-ambiguous',
      text: 'next tuesday',
      tags: ['weekday-anchor', 'ambiguity'],
      output: planner('clarification', 'Top-level next weekday is materially ambiguous.', [plan('Which Tuesday?', [
        step({ operation: 'resolve_weekday_anchor', weekday: 'tuesday', weekdayAnchor: 'next_ambiguous', precision: 'date' }),
      ])], 'Do you mean the upcoming Tuesday or the Tuesday after that?'),
    }),
    row({
      id: 'next-weekday-clock-ambiguous',
      text: 'next saturday at 5pm',
      tags: ['weekday-anchor', 'ambiguity', 'explicit-clock'],
      output: planner('clarification', 'Top-level next weekday with a clock is materially ambiguous.', [plan('Which Saturday at 5 PM?', [
        step({ operation: 'resolve_weekday_anchor', weekday: 'saturday', weekdayAnchor: 'next_ambiguous', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: '5pm' }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)], 'Do you mean the upcoming Saturday or the Saturday after that?'),
    }),
    ...weekdayShortClockSuffixAmbiguitySeedRows(),
    row({
      id: 'next-weekday-fuzzy-clock-ambiguous',
      text: 'next saturday at l33t time',
      tags: ['weekday-anchor', 'ambiguity', 'fuzzy-clock'],
      output: planner('clarification', 'Resolve the fuzzy clock while preserving weekday ambiguity.', [plan('Which Saturday at leet time?', [
        step({ operation: 'resolve_weekday_anchor', weekday: 'saturday', weekdayAnchor: 'next_ambiguous', precision: 'date' }),
        step({ operation: 'interpret_clock_phrase', text: 'l33t time', time: { hour: 13, minute: 37 } }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)], 'Do you mean the upcoming Saturday or the Saturday after that?'),
    }),
    row({
      id: 'weekday-bare-hour-ambiguous',
      text: 'saturday at 3',
      tags: ['weekday-anchor', 'ambiguity', 'bare-hour'],
      output: planner('clarification', 'Bare hour requires AM/PM clarification.', [
        plan('Saturday 3 AM', [
          step({ operation: 'resolve_calendar_query', query: 'saturday', precision: 'date' }),
          step({ operation: 'resolve_clock_time', text: '3am' }),
          step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
        ], 2),
        plan('Saturday 3 PM', [
          step({ operation: 'resolve_calendar_query', query: 'saturday', precision: 'date' }),
          step({ operation: 'resolve_clock_time', text: '3pm' }),
          step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
        ], 2),
      ], 'Which time did you mean?'),
    }),
    ...dateAnchorBareHourSeedRows(),
    ...relativeAndWeekdayBareMinuteSeedRows(),
    ...monthBoundaryTypoBareMinuteSeedRows(),
    ...noisyHumanInputSeedRows(),
    ...weekdayTypoSeedRows(),
    ...relativeTypoSeedRows(),
    ...nextWeekdayTypoSeedRows(),
    ...monthDateSeedRows(),
    ...datePermutationSeedRows(),
    ...eventPostPermutationSeedRows(),
    ...compoundTypoSeedRows(),
    ...criticalBoundarySeedRows(),
    row({
      id: 'holiday-year',
      text: 'easter 2028',
      tags: ['holiday'],
      output: planner('plans', 'Resolve the named holiday in the requested year.', [plan('Easter 2028', [step({ operation: 'resolve_holiday', holidayName: 'easter', year: 2028, precision: 'date' })])]),
    }),
    row({
      id: 'ordinal-weekday-next-month-clock',
      text: 'first sunday of next month at 1pm',
      tags: ['ordinal-weekday', 'explicit-clock'],
      output: planner('plans', 'Use deterministic calendar grammar for the ordinal weekday phrase.', [plan('First Sunday next month at 1 PM', [step({ operation: 'resolve_calendar_query', query: 'first sunday of next month at 1pm', precision: 'datetime' })])]),
    }),
    row({
      id: 'ordinal-weekday-explicit-month-name-holdout',
      text: 'first tuesday of July',
      split: 'holdout',
      tags: ['ordinal-weekday', 'explicit-month-name'],
      output: planner('plans', 'Use deterministic calendar grammar for the ordinal weekday and explicit month phrase.', [plan('First Tuesday of July', [step({ operation: 'resolve_calendar_query', query: 'first tuesday of July', precision: 'date' })])]),
    }),
    row({
      id: 'ordinal-weekday-explicit-month-name-clock-train',
      text: 'second friday in August at 4pm',
      tags: ['ordinal-weekday', 'explicit-month-name', 'explicit-clock'],
      output: planner('plans', 'Use deterministic calendar grammar for the ordinal weekday, explicit month, and clock phrase.', [plan('Second Friday in August at 4 PM', [step({ operation: 'resolve_calendar_query', query: 'second friday in August at 4pm', precision: 'datetime' })])]),
    }),
    row({
      id: 'ordinal-weekday-explicit-month-name-year-validation',
      text: 'last monday of September 2027',
      split: 'validation',
      tags: ['ordinal-weekday', 'explicit-month-name', 'explicit-year'],
      output: planner('plans', 'Use deterministic calendar grammar for the ordinal weekday, explicit month, and year phrase.', [plan('Last Monday of September 2027', [step({ operation: 'resolve_calendar_query', query: 'last monday of September 2027', precision: 'date' })])]),
    }),
    row({
      id: 'event-post-two-times',
      text: 'Club night: Friday May 29, doors 8pm, main set 10:30pm',
      tags: ['event-post', 'ambiguity', 'multi-time'],
      output: planner('clarification', 'The event post has one date and two plausible event times.', [
        plan('Doors 8 PM', [
          step({ operation: 'resolve_calendar_query', query: 'Friday May 29', precision: 'date' }),
          step({ operation: 'resolve_clock_time', text: '8pm' }),
          step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
        ], 2),
        plan('Main set 10:30 PM', [
          step({ operation: 'resolve_calendar_query', query: 'Friday May 29', precision: 'date' }),
          step({ operation: 'resolve_clock_time', text: '10:30pm' }),
          step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
        ], 2),
      ], 'Which event time should the Discord timestamp use?'),
    }),
    row({
      id: 'recurrence-unsupported',
      text: 'every friday at 5pm',
      tags: ['recurrence', 'unsupported'],
      output: planner('no_plan', 'Recurring schedules are intentionally outside the first text-to-IR training target.', []),
    }),
    ...randomRows(randomRowCount),
  ];
}

function row(input: Omit<TemporalIrTrainingRow, 'split' | 'input'> & { text: string; split?: Split; referenceInstant?: string; timeZone?: string }): TemporalIrTrainingRow {
  const split = input.split ?? splitForId(input.id);
  return {
    id: input.id,
    split,
    tags: input.tags,
    input: { text: input.text, referenceInstant: input.referenceInstant ?? referenceInstant, timeZone: input.timeZone ?? timeZone },
    output: input.output,
  };
}

function randomRows(count: number): TemporalIrTrainingRow[] {
  const rng = mulberry32(0x51f15e);
  const builders = [
    randomHoliday,
    randomHolidayNoon,
    randomAnchorOffsetClock,
    randomExplicitTimestamp,
    randomDateFormat,
    randomOrdinalWeekday,
    randomOrdinalWeekdayShiftNoon,
    randomHoliday,
    randomHolidayNoon,
    randomAnchorOffsetClock,
    randomExplicitTimestamp,
    randomDateFormat,
    randomOrdinalWeekday,
    randomOrdinalWeekdayShiftNoon,
    randomHoliday,
    randomHolidayNoon,
    randomAnchorOffsetClock,
    randomExplicitTimestamp,
    randomDateFormat,
    randomOrdinalWeekday,
    randomOrdinalWeekdayShiftNoon,
    randomHoliday,
    randomHolidayNoon,
    randomAnchorOffsetClock,
    randomExplicitTimestamp,
    randomDateFormat,
    randomOrdinalWeekday,
    randomOrdinalWeekdayShiftNoon,
    randomWeekdayTypoClock,
    randomClockFirstWeekdayTypo,
    randomRelativeOffset,
    randomRelativeShorthand,
    randomMonthBoundary,
    randomBoundarySnap,
    randomRelativeTypoClock,
    randomMonthTypoDateClock,
    randomNoisyHumanInput,
    randomDateSeparatorVariant,
    randomWhitespaceCasingVariant,
    randomCompoundTypoAnchorOffsetClock,
    randomCompoundRelativeLeet,
    randomWeekdayTypoClock,
    randomRelativeOffset,
    randomBoundarySnap,
    randomRelativeTypoClock,
    randomMonthTypoDateClock,
    randomNoisyHumanInput,
    randomDateSeparatorVariant,
    randomNextWeekdayAmbiguity,
    randomNextWeekdayClockAmbiguity,
    randomNextWeekdayTypoClockAmbiguity,
    randomNextWeekdayFuzzyClockAmbiguity,
    randomBareHourTomorrow,
    randomBareHourWeekday,
    randomBareHourMonthDay,
    randomBareHourFullDate,
    randomWeekdayAfterNext,
    randomRelativeTypoBareHour,
    randomEventPost,
    randomNoisyEventPost,
    randomUnsupportedEpoch,
    randomChainedDayAfterTomorrow,
    randomUnsupportedEpoch,
    randomChainedDayAfterTomorrow,
  ];
  const rows: TemporalIrTrainingRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const builder = builders[index % builders.length]!;
    rows.push({ ...builder(index, rng), split: splitForRandomIndex(index) });
  }
  return rows;
}

function standardGroundingSeedRows(): TemporalIrTrainingRow[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const clock = `${String(hour).padStart(2, '0')}:15`;
    return row({
      id: `standard-grounding-tomorrow-clock-${String(hour).padStart(2, '0')}`,
      text: `tomorrow at ${clock}`,
      split: 'train',
      tags: ['relative', 'explicit-clock', 'clock-24h', 'standard-grounding'],
      output: planner('plans', 'Resolve the relative date and explicit 24-hour clock separately.', [plan(`Tomorrow ${clock}`, [
        step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: clock }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)]),
    });
  });
}

function bareTwentyFourHourSeedRows(): TemporalIrTrainingRow[] {
  const specs: Array<{ text: string; query: string; split: Split }> = [
    ...Array.from({ length: 11 }, (_, index) => {
      const hour = index + 13;
      const split: Split = hour === 19 ? 'validation' : hour === 23 ? 'holdout' : 'train';
      return { text: String(hour), query: `${hour}:00`, split };
    }),
  ];
  return specs.map((spec) => row({
    id: `bare-24h-hour-${spec.text}-${spec.split}`,
    text: spec.text,
    split: spec.split,
    tags: ['bare-hour', 'clock-24h', 'next-occurrence', 'manual-input'],
    output: planner('plans', 'Normalize the bare 24-hour number to a conventional clock query, then let deterministic parsing choose the next occurrence.', [plan(`Bare ${spec.query}`, [
      step({ operation: 'resolve_calendar_query', query: spec.query, precision: 'datetime' }),
    ])]),
  }));
}

type RelativeOffsetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';
type RelativeOffsetDirection = 'ago' | 'from_now' | 'in';

const relativeOffsetUnits: RelativeOffsetUnit[] = ['minutes', 'hours', 'days', 'weeks', 'months', 'years'];

function relativeOffsetSeedRows(): TemporalIrTrainingRow[] {
  const specs: Array<{ amount: number; unit: RelativeOffsetUnit; direction: RelativeOffsetDirection; split: Split }> = [
    { amount: 1, unit: 'days', direction: 'from_now', split: 'train' },
    { amount: 60, unit: 'days', direction: 'from_now', split: 'train' },
    { amount: 100, unit: 'days', direction: 'ago', split: 'validation' },
    { amount: 60, unit: 'months', direction: 'from_now', split: 'train' },
    { amount: 12, unit: 'months', direction: 'ago', split: 'train' },
    { amount: 60, unit: 'years', direction: 'from_now', split: 'train' },
    { amount: 10, unit: 'years', direction: 'ago', split: 'validation' },
    { amount: 60, unit: 'weeks', direction: 'from_now', split: 'train' },
    { amount: 60, unit: 'hours', direction: 'from_now', split: 'train' },
    { amount: 60, unit: 'minutes', direction: 'ago', split: 'holdout' },
  ];
  return specs.map((spec) => relativeOffsetRow(spec));
}

function relativeOffsetRow(spec: { amount: number; unit: RelativeOffsetUnit; direction: RelativeOffsetDirection; split?: Split }): TemporalIrTrainingRow {
  const query = relativeOffsetText(spec);
  return row({
    id: `relative-offset-${spec.direction.replace('_', '-')}-${spec.amount}-${spec.unit}-${spec.split ?? 'train'}`,
    text: query,
    split: spec.split ?? 'train',
    tags: ['relative', 'duration', 'offset'],
    output: planner('plans', 'Resolve the relative duration directly with deterministic calendar arithmetic.', [plan(title(query), [
      step({ operation: 'resolve_calendar_query', query, precision: 'relative' }),
    ])]),
  });
}

function relativeOffsetText(spec: { amount: number; unit: RelativeOffsetUnit; direction: RelativeOffsetDirection }): string {
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

function relativeShorthandSeedRows(): TemporalIrTrainingRow[] {
  return [
    relativeDateRow('relative-shorthand-tom-date-train', 'tom', 'tomorrow', ['relative-typo', 'shorthand']),
    relativeDateRow('relative-shorthand-tmw-date-train', 'tmw', 'tomorrow', ['relative-typo', 'shorthand']),
    relativeDateRow('relative-shorthand-tom-thanks-validation', 'tom thanks', 'tomorrow', ['relative-typo', 'shorthand', 'noise'], 'validation'),
    relativeClockRow('relative-shorthand-tom-5pm-train', 'tom at 5pm', 'tomorrow', '5pm', 'Tomorrow 5 PM', ['relative-typo', 'shorthand']),
    relativeClockRow('relative-shorthand-tmw-1630-train', 'tmw 16:30', 'tomorrow', '16:30', 'Tomorrow 16:30', ['relative-typo', 'shorthand', 'clock-24h']),
    relativeClockRow('relative-shorthand-tom-415pm-validation', 'tom 4:15pm', 'tomorrow', '4:15pm', 'Tomorrow 4:15 PM', ['relative-typo', 'shorthand'], 'validation'),
  ];
}

function monthBoundarySeedRows(): TemporalIrTrainingRow[] {
  return [
    calendarQueryRow('month-boundary-first-of-month-train', 'first of the month', 'first of the month', 'date', ['month-boundary'], 'train'),
    calendarQueryRow('month-boundary-first-of-this-month-train', 'first of this month', 'first of this month', 'date', ['month-boundary', 'direction-this'], 'train'),
    calendarQueryRow('month-boundary-first-of-next-month-train', 'first of next month', 'first of next month', 'date', ['month-boundary', 'direction-next'], 'train'),
    calendarQueryRow('month-boundary-first-of-last-month-validation', 'first of last month', 'first of last month', 'date', ['month-boundary', 'direction-last'], 'validation'),
    monthBoundaryClockRow('month-boundary-first-of-last-month-5pm-train', 'first of last month at 5pm', 'first of last month', '5pm', 'First of last month 5 PM', ['direction-last'], 'train'),
    monthBoundaryClockRow('month-boundary-leading-clock-first-of-last-month-5pm-train', '5pm the first of last month', 'first of last month', '5pm', 'First of last month 5 PM', ['direction-last', 'clock-leading'], 'train'),
    monthBoundaryClockRow('month-boundary-leading-clock-first-of-last-month-spaced-train', '5 pm first of last month', 'first of last month', '5 pm', 'First of last month 5 PM', ['direction-last', 'clock-leading', 'whitespace'], 'train'),
    monthBoundaryClockRow('month-boundary-leading-clock-first-of-last-month-holdout', '5pm the first of last month', 'first of last month', '5pm', 'First of last month 5 PM', ['direction-last', 'clock-leading'], 'holdout'),
    monthBoundaryClockRow('month-boundary-first-of-next-month-1630-train', 'first of next month 16:30', 'first of next month', '16:30', 'First of next month 16:30', ['direction-next', 'clock-24h'], 'train'),
    monthBoundaryClockRow('month-boundary-leading-clock-first-of-this-month-validation', '9am first of this month', 'first of this month', '9am', 'First of this month 9 AM', ['direction-this', 'clock-leading'], 'validation'),
  ];
}

function monthBoundaryClockRow(
  id: string,
  text: string,
  query: string,
  clockText: string,
  label: string,
  tags: string[],
  split: Split = 'train',
): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['month-boundary', 'explicit-clock', ...tags],
    output: planner('plans', 'Resolve the month-boundary date and explicit clock separately, then combine them.', [plan(label, [
      step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clockText }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)]),
  });
}

function boundarySnapSeedRows(): TemporalIrTrainingRow[] {
  return [
    calendarQueryRow('boundary-snap-relative-hour-word-train', 'in five hours on the hour', 'in five hours on the hour', 'datetime', ['boundary-snap', 'relative', 'duration', 'word-number'], 'train'),
    calendarQueryRow('boundary-snap-relative-top-of-hour-train', 'in 5 hours at the top of the hour', 'in 5 hours at the top of the hour', 'datetime', ['boundary-snap', 'relative', 'duration'], 'train'),
    calendarQueryRow('boundary-snap-nearest-hour-train', 'round to nearest hour', 'round to nearest hour', 'datetime', ['boundary-snap', 'nearest'], 'train'),
    calendarQueryRow('boundary-snap-nearest-quarter-train', 'round to nearest 15 minutes', 'round to nearest 15 minutes', 'datetime', ['boundary-snap', 'nearest', 'quarter-hour'], 'train'),
    calendarQueryRow('boundary-snap-relative-nearest-quarter-train', 'in 23 minutes round to nearest 15 minutes', 'in 23 minutes round to nearest 15 minutes', 'datetime', ['boundary-snap', 'relative', 'duration', 'quarter-hour'], 'train'),
    calendarQueryRow('boundary-snap-next-hour-train', 'next hour', 'next hour', 'datetime', ['boundary-snap', 'direction-next'], 'train'),
    calendarQueryRow('boundary-snap-previous-hour-validation', 'previous hour', 'previous hour', 'datetime', ['boundary-snap', 'direction-previous'], 'validation'),
    calendarQueryRow('boundary-snap-hour-after-next-train', 'the hour after next', 'the hour after next', 'datetime', ['boundary-snap', 'direction-next', 'after-next'], 'train'),
  ];
}

function relativeDateRow(id: string, text: string, normalizedQuery: string, tags: string[], split: Split = 'train'): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['relative', ...tags],
    output: planner('plans', 'Resolve the shorthand relative date directly.', [plan(title(normalizedQuery), [
      step({ operation: 'resolve_calendar_query', query: normalizedQuery, precision: 'date' }),
    ])]),
  });
}

function calendarQueryRow(
  id: string,
  text: string,
  query: string,
  precision: TemporalPlanStep['precision'],
  tags: string[],
  split: Split = 'train',
): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags,
    output: planner('plans', 'Delegate this calendar phrase to the deterministic parser.', [plan(title(query), [
      step({ operation: 'resolve_calendar_query', query, precision }),
    ])]),
  });
}

function weekdayShortClockSuffixAmbiguitySeedRows(): TemporalIrTrainingRow[] {
  const rows: Array<{ id: string; text: string; hour: number; split: Split }> = [
    { id: 'weekday-short-clock-suffix-ambiguous-tue-5pma-train', text: 'tue 5pma', hour: 5, split: 'train' },
    { id: 'weekday-short-clock-suffix-ambiguous-tu-5pma-train', text: 'tu 5pma', hour: 5, split: 'train' },
    { id: 'weekday-short-clock-suffix-ambiguous-tu-6pma-validation', text: 'tu 6pma', hour: 6, split: 'validation' },
    { id: 'weekday-short-clock-suffix-ambiguous-tu-4pma-train', text: 'tu 4pma', hour: 4, split: 'train' },
    { id: 'weekday-short-clock-suffix-ambiguous-tues-7pma-train', text: 'tues 7pma', hour: 7, split: 'train' },
    { id: 'weekday-short-clock-suffix-ambiguous-tue-8ama-train', text: 'tue 8ama', hour: 8, split: 'train' },
    { id: 'weekday-short-clock-suffix-ambiguous-tu-9ama-train', text: 'tu 9ama', hour: 9, split: 'train' },
    { id: 'weekday-short-clock-suffix-ambiguous-tues-10pma-validation', text: 'tues 10pma', hour: 10, split: 'validation' },
    { id: 'weekday-short-clock-suffix-ambiguous-tue-11ama-holdout', text: 'tue 11ama', hour: 11, split: 'holdout' },
  ];

  return rows.map((entry) => row({
    id: entry.id,
    text: entry.text,
    referenceInstant: '2026-06-02T04:50:00Z',
    timeZone: 'America/New_York',
    split: entry.split,
    tags: ['weekday-anchor', 'weekday-typo', 'relative-typo', 'ambiguity', 'clock-suffix-ambiguity', 'multi-anchor'],
    output: weekdayShortClockSuffixAmbiguityPlanner('tuesday', 'tomorrow', entry.hour),
  }));
}

function weekdayShortClockSuffixAmbiguityPlanner(weekday: typeof weekdays[number], relativeQuery: string, hour: number): TemporalPlanPlannerOutput {
  const hourLabelText = hourLabel(hour, 0);
  return planner('clarification', 'Short weekday text and malformed AM/PM suffix create multiple plausible anchors and clock interpretations.', [
    plan(`This ${title(weekday)} ${hourLabelText} AM`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'this', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: `${hour}am` }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`This ${title(weekday)} ${hourLabelText} PM`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'this', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: `${hour}pm` }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`${title(relativeQuery)} ${hourLabelText} AM`, [
      step({ operation: 'resolve_calendar_query', query: relativeQuery, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: `${hour}am` }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`${title(relativeQuery)} ${hourLabelText} PM`, [
      step({ operation: 'resolve_calendar_query', query: relativeQuery, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: `${hour}pm` }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`Next ${title(weekday)} ${hourLabelText} AM`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: `${hour}am` }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`Next ${title(weekday)} ${hourLabelText} PM`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: `${hour}pm` }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
  ], 'Did you mean Tuesday, tomorrow, or next Tuesday, and AM or PM?');
}

function dateAnchorBareHourSeedRows(): TemporalIrTrainingRow[] {
  const hourRows: Array<{ hour: number; day: number; split: Split }> = Array.from({ length: 12 }, (_, index) => ({
    hour: index + 1,
    day: index + 11,
    split: index < 8 ? 'train' : index < 10 ? 'validation' : 'holdout',
  }));
  const rows: Array<{ id: string; text: string; query: string; hour: number; minute: number; split: Split; tags: string[] }> = [
    {
      id: 'month-day-bare-hour-ambiguous-train',
      text: 'may 6 6',
      query: 'May 6',
      hour: 6,
      minute: 0,
      split: 'train',
      tags: ['month-day'],
    },
    ...hourRows.map(({ hour, day, split }) => ({
      id: `month-day-bare-hour-${hour}-${split}`,
      text: `june ${day} ${hour}`,
      query: `June ${day}`,
      hour,
      minute: 0,
      split,
      tags: ['month-day'],
    })),
    {
      id: 'month-day-bare-compact-minute-train',
      text: 'june 20 930',
      query: 'June 20',
      hour: 9,
      minute: 30,
      split: 'train',
      tags: ['month-day', 'compact-clock'],
    },
    {
      id: 'month-day-at-bare-hour-validation',
      text: 'july 8 at 7',
      query: 'July 8',
      hour: 7,
      minute: 0,
      split: 'validation',
      tags: ['month-day'],
    },
    {
      id: 'full-date-bare-hour-train',
      text: 'July 9 2026 8',
      query: 'July 9 2026',
      hour: 8,
      minute: 0,
      split: 'train',
      tags: ['full-date'],
    },
    {
      id: 'iso-date-bare-hour-validation',
      text: '2026-07-10 9',
      query: '2026-07-10',
      hour: 9,
      minute: 0,
      split: 'validation',
      tags: ['full-date', 'date-separator-variance'],
    },
    {
      id: 'full-date-bare-compact-minute-holdout',
      text: 'July 11 2026 1015',
      query: 'July 11 2026',
      hour: 10,
      minute: 15,
      split: 'holdout',
      tags: ['full-date', 'compact-clock'],
    },
  ];

  return rows.map((entry) => row({
    id: entry.id,
    text: entry.text,
    split: entry.split,
    tags: ['date-anchor', 'ambiguity', 'bare-hour', ...entry.tags],
    output: bareHourClarificationPlanner(entry.query, entry.hour, entry.minute),
  }));
}

function relativeAndWeekdayBareMinuteSeedRows(): TemporalIrTrainingRow[] {
  const rows: Array<{ id: string; text: string; query: string; hour: number; minute: number; split: Split; tags: string[] }> = [
    {
      id: 'relative-anchor-bare-minute-holdout',
      text: 'day after tomorrow 11:34',
      query: 'day after tomorrow',
      hour: 11,
      minute: 34,
      split: 'holdout',
      tags: ['relative-anchor', 'colon-clock'],
    },
    {
      id: 'weekday-leading-bare-minute-validation',
      text: '4:30 Tuesday',
      query: 'Tuesday',
      hour: 4,
      minute: 30,
      split: 'validation',
      tags: ['weekday-anchor', 'leading-clock', 'colon-clock'],
    },
  ];

  return rows.map((entry) => row({
    id: entry.id,
    text: entry.text,
    split: entry.split,
    tags: ['ambiguity', 'bare-hour', ...entry.tags],
    output: bareHourClarificationPlanner(entry.query, entry.hour, entry.minute),
  }));
}

function monthBoundaryTypoBareMinuteSeedRows(): TemporalIrTrainingRow[] {
  const rows: Array<{ id: string; text: string; query: string; hour: number; minute: number; split: Split; tags: string[] }> = [
    {
      id: 'month-boundary-typo-suffix-bare-minute-holdout',
      text: 'first of Febuarysdf 2:30',
      query: 'first of February',
      hour: 2,
      minute: 30,
      split: 'holdout',
      tags: ['month-boundary', 'month-typo', 'noise-suffix', 'colon-clock'],
    },
    {
      id: 'month-boundary-typo-suffix-bare-minute-train',
      text: 'first of Febuaryzz 4:15',
      query: 'first of February',
      hour: 4,
      minute: 15,
      split: 'train',
      tags: ['month-boundary', 'month-typo', 'noise-suffix', 'colon-clock'],
    },
    {
      id: 'month-boundary-typo-suffix-bare-compact-validation',
      text: '1st of Septembersdf 745',
      query: 'first of September',
      hour: 7,
      minute: 45,
      split: 'validation',
      tags: ['month-boundary', 'month-typo', 'noise-suffix', 'compact-clock'],
    },
  ];

  return rows.map((entry) => row({
    id: entry.id,
    text: entry.text,
    split: entry.split,
    tags: ['ambiguity', 'bare-hour', ...entry.tags],
    output: bareHourClarificationPlanner(entry.query, entry.hour, entry.minute),
  }));
}

function noisyHumanInputSeedRows(): TemporalIrTrainingRow[] {
  return [
    noisyBareClockRow('noisy-frist-febuary-bare-minute-train', 'frist of Febuary 2:30', 'first of February', 2, 30, ['month-boundary', 'month-typo', 'ordinal-typo', 'colon-clock'], 'train'),
    noisyBareClockRow('noisy-septmber-suffix-bare-compact-validation', 'first of septmberrr 745', 'first of September', 7, 45, ['month-boundary', 'month-typo', 'noise-suffix', 'compact-clock'], 'validation'),
    noisyBareClockRow('noisy-decemeber-suffix-bare-dotted-holdout', 'first  of   Decemeberzz 9.45', 'first of December', 9, 45, ['month-boundary', 'month-typo', 'noise-suffix', 'clock-separator-variance'], 'holdout'),
    noisyBareClockRow('noisy-wensday-suffix-bare-minute-train', 'wensdayy 4:30', 'wednesday', 4, 30, ['weekday-anchor', 'weekday-typo', 'noise-suffix', 'colon-clock'], 'train'),
    noisyBareClockRow('noisy-tomorow-suffix-bare-compact-train', 'tomoroww 1130', 'tomorrow', 11, 30, ['relative', 'relative-typo', 'noise-suffix', 'compact-clock'], 'train'),
    noisyExplicitClockRow('noisy-frst-octber-explicit-clock-train', 'frst of octber at 6pm', 'first of October', '6pm', 'First of October 6 PM', ['month-boundary', 'month-typo', 'ordinal-typo', 'explicit-clock'], 'train'),
    noisyExplicitClockRow('noisy-monndayy-explicit-clock-validation', 'monndayy 10:15pm', 'monday', '10:15pm', 'Monday 10:15 PM', ['weekday-anchor', 'weekday-typo', 'noise-suffix', 'explicit-clock'], 'validation'),
    row({
      id: 'noisy-nextfriday-run-together-clock-holdout',
      text: 'nextfriday 4:30pm',
      split: 'holdout',
      tags: ['noisy-human-input', 'weekday-anchor', 'run-together', 'ambiguity', 'explicit-clock'],
      output: planner('clarification', 'Normalize the run-together next-weekday phrase while preserving top-level next-weekday ambiguity.', [plan('Which Friday at 4:30 PM?', [
        step({ operation: 'resolve_weekday_anchor', weekday: 'friday', weekdayAnchor: 'next_ambiguous', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: '4:30pm' }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)], 'Do you mean the upcoming Friday or the Friday after that?'),
    }),
  ];
}

function noisyBareClockRow(id: string, text: string, query: string, hour: number, minute: number, tags: string[], split: Split): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['noisy-human-input', 'ambiguity', 'bare-hour', ...tags],
    output: bareHourClarificationPlanner(query, hour, minute),
  });
}

function noisyExplicitClockRow(id: string, text: string, query: string, clockText: string, label: string, tags: string[], split: Split): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['noisy-human-input', ...tags],
    output: planner('plans', 'Normalize noisy temporal spelling, then resolve the date and explicit clock separately.', [plan(label, [
      step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clockText }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)]),
  });
}

function weekdayTypoSeedRows(): TemporalIrTrainingRow[] {
  return [
    weekdayTypoClockRow('weekday-typo-tu-9pm-train', 'tu 9pm', 'tuesday', '9pm', 'Tuesday 9 PM'),
    weekdayTypoClockRow('weekday-typo-clock-first-tu-9pm-train', '9pm tu', 'tuesday', '9pm', 'Tuesday 9 PM'),
    weekdayTypoClockRow('weekday-typo-clock-first-tue-1015pm-train', '10:15pm tue', 'tuesday', '10:15pm', 'Tuesday 10:15 PM'),
    weekdayTypoClockRow('weekday-typo-weddd-6pm-train', 'weddd 6pm', 'wednesday', '6pm', 'Wednesday 6 PM'),
    weekdayTypoClockRow('weekday-typo-clock-first-weddd-7pm-train', '7pm weddd', 'wednesday', '7pm', 'Wednesday 7 PM'),
    weekdayTypoClockRow('weekday-typo-thrs-9pm-train', 'thrs 9pm', 'thursday', '9pm', 'Thursday 9 PM'),
    weekdayTypoClockRow('weekday-typo-thurr-8pm-train', 'thurr 8pm', 'thursday', '8pm', 'Thursday 8 PM'),
    weekdayTypoClockRow('weekday-typo-friii-7pm-validation', 'friii 7pm', 'friday', '7pm', 'Friday 7 PM', 'validation'),
    weekdayTypoClockRow('weekday-typo-satt-4pm-validation', 'satt 4pm', 'saturday', '4pm', 'Saturday 4 PM', 'validation'),
  ];
}

function relativeTypoSeedRows(): TemporalIrTrainingRow[] {
  return [
    relativeClockRow('relative-typo-tmrw-5pm-train', 'tmrw 5pm', 'tomorrow', '5pm', 'Tomorrow 5 PM', ['relative-typo']),
    relativeClockRow('relative-typo-tomrw-1630-train', 'tomrw at 16:30', 'tomorrow', '16:30', 'Tomorrow 16:30', ['relative-typo', 'clock-24h']),
    relativeClockRow('relative-typo-tommorrow-430pm-validation', 'tommorrow 4:30pm', 'tomorrow', '4:30pm', 'Tomorrow 4:30 PM', ['relative-typo'], 'validation'),
    row({
      id: 'relative-typo-tomrw-bare-5-validation',
      text: 'tomrw 5',
      split: 'validation',
      tags: ['relative', 'relative-typo', 'ambiguity', 'bare-hour'],
      output: bareHourClarificationPlanner('tomorrow', 5, 0),
    }),
  ];
}

function nextWeekdayTypoSeedRows(): TemporalIrTrainingRow[] {
  return [
    nextWeekdayTypoClockRow('next-weekday-typo-nexxt-frii-7pm-train', 'nexxt frii 7pm', 'friday', '7pm', '7 PM'),
    nextWeekdayTypoClockRow('next-weekday-typo-nxt-sat-6pm-train', 'nxt sat 6pm', 'saturday', '6pm', '6 PM'),
    nextWeekdayTypoClockRow('next-weekday-typo-nextt-tu-9pm-validation', 'nextt tu 9pm', 'tuesday', '9pm', '9 PM', 'validation'),
  ];
}

function monthDateSeedRows(): TemporalIrTrainingRow[] {
  return [
    correctedCalendarRow('month-typo-septembar-date-train', 'septembar 4 2026 9pm', 'September 4 2026 9pm', ['month-typo', 'explicit-clock']),
    correctedCalendarRow('month-typo-febuary-date-train', 'febuary 12 2027 10am', 'February 12 2027 10am', ['month-typo', 'explicit-clock']),
    correctedCalendarRow('month-typo-novemebr-date-validation', 'novemebr 5 2028 18:45', 'November 5 2028 18:45', ['month-typo', 'explicit-clock', 'clock-24h'], 'validation'),
    correctedCalendarRow('month-abbrev-sep-dot-date-train', 'sep. 8 2026 7:15pm', 'September 8 2026 7:15pm', ['month-abbrev', 'punctuation', 'explicit-clock']),
  ];
}

function datePermutationSeedRows(): TemporalIrTrainingRow[] {
  return [
    correctedCalendarRow('date-dot-separator-train', '2026.05.30 21:00', '2026-05-30 21:00', ['date-separator-variance', 'clock-24h']),
    correctedCalendarRow('date-space-separated-ymd-validation', '2026 05 31 20:15', '2026-05-31 20:15', ['date-separator-variance', 'whitespace', 'clock-24h'], 'validation'),
    correctedCalendarRow('date-uppercase-month-train', 'JUNE 4 2026 8PM', 'June 4 2026 8pm', ['casing', 'explicit-clock']),
    correctedCalendarRow('date-weird-spacing-train', 'May    30   2026    9pm', 'May 30 2026 9pm', ['whitespace', 'explicit-clock']),
    correctedCalendarRow('clock-dot-separator-train', 'June 3 2026 9.30pm', 'June 3 2026 9:30pm', ['clock-separator-variance', 'explicit-clock']),
  ];
}

function eventPostPermutationSeedRows(): TemporalIrTrainingRow[] {
  return [
    eventPostRow('event-post-multiline-typo-train', 'Club night:\nFrii May 30\nDoors 7pm\nMain set 11pm', 'Friday May 30', '7pm', '11pm', ['event-post', 'weekday-typo', 'multiline']),
    eventPostRow('event-post-month-typo-train', 'sat mayy 30 doors 6pm main 10pm', 'Saturday May 30', '6pm', '10pm', ['event-post', 'month-typo', 'multi-time']),
    eventPostRow('event-post-link-noise-validation', 'Tickets soon - Sunday June 7 - doors 8:15pm - main 10:45pm - https://example.invalid', 'Sunday June 7', '8:15pm', '10:45pm', ['event-post', 'noise', 'multi-time'], 'validation'),
  ];
}

function compoundTypoSeedRows(): TemporalIrTrainingRow[] {
  return [
    row({
      id: 'anchor-offset-typo-weekday-relative-train',
      text: 'day aftr next satturday at 12:45',
      tags: ['weekday-anchor', 'weekday-typo', 'relative-typo', 'offset', 'explicit-clock', 'clock-24h'],
      output: planner('plans', 'Correct the typo, use next Saturday as the anchor, preserve the explicit 24-hour clock, and shift by one day.', [plan('Day after next Saturday at 12:45', [
        step({ operation: 'resolve_calendar_query', query: 'next saturday', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: '12:45' }),
        step({ operation: 'shift_datetime', baseStep: 0, timeStep: 1, delta: delta({ days: 1 }), precision: 'datetime' }),
      ], 2)]),
    }),
    row({
      id: 'recursive-relative-typo-tomorow-train',
      text: 'the day after the day after tomorow',
      tags: ['relative', 'relative-typo', 'recursive-composition', 'offset'],
      output: planner('plans', 'Correct tomorrow typo and collapse two day-after modifiers into one day shift.', [plan('Two days after tomorrow', [
        step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
        step({ operation: 'shift_datetime', baseStep: 0, delta: delta({ days: 2 }), precision: 'relative' }),
      ], 1)]),
    }),
  ];
}

function criticalBoundarySeedRows(): TemporalIrTrainingRow[] {
  return [
    explicitTimestampRow('epoch-zero-boundary-repeat-1-train', '0', 'Unix epoch zero', 'train'),
    explicitTimestampRow('epoch-zero-boundary-repeat-2-train', '0', 'Unix epoch zero', 'train'),
    explicitTimestampRow('epoch-zero-boundary-padded-short-train', '00', 'Unix epoch zero', 'train'),
    explicitTimestampRow('epoch-zero-boundary-discord-relative-train', '<t:0:R>', 'Discord epoch zero', 'train'),
    relativeClockRow('relative-typo-uppercase-tmrw-430pm-train', 'TMRW 4:30pm', 'tomorrow', '4:30pm', 'Tomorrow 4:30 PM', ['relative-typo', 'casing', 'whitespace']),
    relativeClockRow('relative-typo-uppercase-spaced-tmrw-515pm-train', 'TMRW   5:15pm', 'tomorrow', '5:15pm', 'Tomorrow 5:15 PM', ['relative-typo', 'casing', 'whitespace']),
    relativeClockRow('relative-typo-lowercase-tmrw-415pm-train', 'tmrw at 4:15pm', 'tomorrow', '4:15pm', 'Tomorrow 4:15 PM', ['relative-typo']),
    recursiveDayAfterTomorrowRow('recursive-relative-typo-tomorow-2-repeat-train', 'the day after the day after tomorow', 2, ['relative-typo']),
    recursiveDayAfterTomorrowRow('recursive-relative-tomorrow-2-train', 'the day after the day after tomorrow', 2, []),
    recursiveDayAfterTomorrowRow('recursive-relative-typo-tomorow-3-train', 'the day after the day after the day after tomorow', 3, ['relative-typo']),
    recursiveDayAfterTomorrowRow('recursive-relative-tomorrow-5-no-articles-train', 'day after day after day after day after day after tomorrow', 5, ['critical-boundary']),
    recursiveDayAfterTomorrowRow('recursive-relative-tomorow-5-typo-train', 'the day after the day after the day after the day after the day after tomorow', 5, ['relative-typo', 'critical-boundary']),
    weekdayShortClockSuffixReinforcementRow('weekday-short-clock-suffix-tu-5pma-critical-repeat-1-train', 'tu 5pma', 5),
    weekdayShortClockSuffixReinforcementRow('weekday-short-clock-suffix-tu-5pma-critical-repeat-2-train', 'tu 5pma', 5),
    weekdayShortClockSuffixReinforcementRow('weekday-short-clock-suffix-tue-5pma-critical-train', 'tue 5pma', 5),
    weekdayShortClockSuffixReinforcementRow('weekday-short-clock-suffix-tu-6pma-critical-train', 'tu 6pma', 6),
  ];
}

function recursiveDayAfterTomorrowRow(id: string, text: string, count: number, tags: string[]): TemporalIrTrainingRow {
  return row({
    id,
    text,
    tags: ['relative', 'recursive-composition', 'offset', ...tags],
    output: planner('plans', 'Correct tomorrow typo if present and collapse repeated day-after modifiers into one day shift.', [plan(`${count} days after tomorrow`, [
      step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
      step({ operation: 'shift_datetime', baseStep: 0, delta: delta({ days: count }), precision: 'relative' }),
    ], 1)]),
  });
}

function weekdayShortClockSuffixReinforcementRow(id: string, text: string, hour: number): TemporalIrTrainingRow {
  return row({
    id,
    text,
    referenceInstant: '2026-06-02T04:50:00Z',
    timeZone: 'America/New_York',
    split: 'train',
    tags: ['weekday-anchor', 'weekday-typo', 'relative-typo', 'ambiguity', 'clock-suffix-ambiguity', 'multi-anchor', 'critical-boundary'],
    output: weekdayShortClockSuffixAmbiguityPlanner('tuesday', 'tomorrow', hour),
  });
}

function weekdayTypoClockRow(
  id: string,
  text: string,
  weekday: typeof weekdays[number],
  clockText: string,
  label: string,
  split: Split = 'train',
): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['weekday-anchor', 'weekday-typo', 'explicit-clock'],
    output: weekdayTypoClockPlanner(weekday, clockText, label),
  });
}

function relativeClockRow(
  id: string,
  text: string,
  normalizedQuery: string,
  clockText: string,
  label: string,
  tags: string[],
  split: Split = 'train',
): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['relative', 'explicit-clock', ...tags],
    output: planner('plans', 'Correct the relative-date typo, then resolve the normalized date and explicit clock separately.', [plan(label, [
      step({ operation: 'resolve_calendar_query', query: normalizedQuery, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clockText }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)]),
  });
}

function nextWeekdayTypoClockRow(
  id: string,
  text: string,
  weekday: typeof weekdays[number],
  clockText: string,
  clockLabel: string,
  split: Split = 'train',
): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['weekday-anchor', 'weekday-typo', 'relative-typo', 'ambiguity', 'explicit-clock'],
    output: planner('clarification', 'Correct the typo while preserving top-level next-weekday ambiguity.', [plan(`Which ${title(weekday)} at ${clockLabel}?`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next_ambiguous', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clockText }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)], `Do you mean the upcoming ${title(weekday)} or the ${title(weekday)} after that?`),
  });
}

function correctedCalendarRow(id: string, text: string, normalizedQuery: string, tags: string[], split: Split = 'train'): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags,
    output: planner('plans', 'Normalize the surface text, then delegate conventional date-time parsing to the deterministic calendar parser.', [plan('Explicit date and time', [step({ operation: 'resolve_calendar_query', query: normalizedQuery, precision: 'datetime' })])]),
  });
}

function eventPostRow(
  id: string,
  text: string,
  query: string,
  doorsText: string,
  mainText: string,
  tags: string[],
  split: Split = 'train',
): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['ambiguity', ...tags],
    output: eventPostPlanner(query, doorsText, mainText),
  });
}

function explicitTimestampRows(): TemporalIrTrainingRow[] {
  return [
    explicitTimestampRow('direct-discord-timestamp', '<t:1779724800:F>', 'Discord timestamp'),
    explicitTimestampRow('direct-epoch-seconds', '1779724800', 'Unix epoch seconds'),
    explicitTimestampRow('direct-epoch-milliseconds', '1779724800000', 'Unix epoch milliseconds'),
    explicitTimestampRow('direct-epoch-microseconds', '1779724800000000', 'Unix epoch microseconds'),
    explicitTimestampRow('direct-epoch-nanoseconds', '1779724800000000000', 'Unix epoch nanoseconds'),
    explicitTimestampRow('direct-epoch-zero', '0', 'Unix epoch zero', 'train'),
    explicitTimestampRow('padded-epoch-zero-train', '0000000000', 'Padded Unix epoch zero', 'train'),
    explicitTimestampRow('discord-epoch-zero-train', '<t:0:F>', 'Discord epoch zero', 'train'),
    unsupportedEpochRow('negative-epoch-unsupported', '-1', 'holdout'),
    unsupportedEpochRow('negative-epoch-repeat-train', '-1', 'train'),
    unsupportedEpochRow('negative-hour-shaped-unsupported-train', '-12', 'train'),
    unsupportedEpochRow('negative-compact-clock-shaped-unsupported-validation', '-430', 'validation'),
    unsupportedEpochRow('negative-large-epoch-unsupported-train', '-1779724800', 'train'),
  ];
}

function unsupportedEpochRow(id: string, text: string, split: Split): TemporalIrTrainingRow {
  return row({
    id,
    text,
    split,
    tags: ['explicit-epoch', 'unsupported', 'negative'],
    output: planner('no_plan', 'Negative Unix epochs are outside supported product behavior.', []),
  });
}

function explicitTimestampRow(id: string, text: string, label: string, split?: Split): TemporalIrTrainingRow {
  return row({
    id,
    text,
    ...(split === undefined ? {} : { split }),
    tags: ['explicit-epoch'],
    output: planner('plans', 'Resolve the explicit timestamp with deterministic epoch parsing.', [plan(label, [step({ operation: 'resolve_calendar_query', query: text, precision: 'datetime' })])]),
  });
}

function randomNextWeekdayAmbiguity(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const phrase = maybeDirty(`next ${weekday}`, rng);
  return row({
    id: `random-next-weekday-ambiguous-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'weekday-anchor', 'ambiguity'],
    output: planner('clarification', 'Top-level next weekday is materially ambiguous.', [plan(`Which ${title(weekday)}?`, [step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next_ambiguous', precision: 'date' })])], `Do you mean the upcoming ${title(weekday)} or the ${title(weekday)} after that?`),
  });
}

function randomNextWeekdayClockAmbiguity(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const clock = randomClock(rng);
  const phrase = maybeDirty(`next ${weekday} at ${clock.text}`, rng);
  return row({
    id: `random-next-weekday-clock-ambiguous-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'weekday-anchor', 'ambiguity', 'explicit-clock'],
    output: planner('clarification', 'Top-level next weekday with a clock is materially ambiguous.', [plan(`Which ${title(weekday)} at ${clock.label}?`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next_ambiguous', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)], `Do you mean the upcoming ${title(weekday)} or the ${title(weekday)} after that?`),
  });
}

function randomNextWeekdayFuzzyClockAmbiguity(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const leet = pick(['l33t time', '133t time', 'leet time'], rng);
  const phrase = maybeDirty(`next ${weekday} at ${leet}`, rng);
  return row({
    id: `random-next-weekday-fuzzy-clock-ambiguous-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'weekday-anchor', 'ambiguity', 'fuzzy-clock'],
    output: planner('clarification', 'Resolve the fuzzy clock while preserving weekday ambiguity.', [plan(`Which ${title(weekday)} at leet time?`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next_ambiguous', precision: 'date' }),
      step({ operation: 'interpret_clock_phrase', text: leet, time: { hour: 13, minute: 37 } }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)], `Do you mean the upcoming ${title(weekday)} or the ${title(weekday)} after that?`),
  });
}

function randomBareHourTomorrow(index: number, rng: () => number): TemporalIrTrainingRow {
  const hour = randomInt(1, 12, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const bare = minute === 0 ? `${hour}` : `${hour}${String(minute).padStart(2, '0')}`;
  const phrase = maybeDirty(`tom ${bare}`, rng);
  return row({
    id: `random-bare-hour-tomorrow-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'relative', 'ambiguity', 'bare-hour'],
    output: bareHourClarificationPlanner('tomorrow', hour, minute),
  });
}

function randomBareHourWeekday(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const hour = randomInt(1, 12, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const bare = minute === 0 ? `${hour}` : `${hour}:${String(minute).padStart(2, '0')}`;
  const phrase = maybeDirty(`${weekday} at ${bare}`, rng);
  return row({
    id: `random-bare-hour-weekday-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'weekday-anchor', 'ambiguity', 'bare-hour'],
    output: bareHourClarificationPlanner(weekday, hour, minute),
  });
}

function randomBareHourMonthDay(index: number, rng: () => number): TemporalIrTrainingRow {
  const month = pick(['May', 'June', 'July'], rng);
  const day = randomInt(1, 28, rng);
  const hour = randomInt(1, 12, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const separator = rng() < 0.35 ? ' at ' : ' ';
  const phrase = `${month} ${day}${separator}${bareClockSurface(hour, minute, rng)}`;
  return row({
    id: `random-bare-hour-month-day-${index}`,
    text: maybeDirty(phrase, rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'date-anchor', 'month-day', 'ambiguity', 'bare-hour'],
    output: bareHourClarificationPlanner(`${month} ${day}`, hour, minute),
  });
}

function randomBareHourFullDate(index: number, rng: () => number): TemporalIrTrainingRow {
  const year = randomInt(2026, 2032, rng);
  const month = randomInt(1, 12, rng);
  const day = randomInt(1, 28, rng);
  const hour = randomInt(1, 12, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const monthName = PLAN_MONTH_NAMES[month - 1]!;
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const query = rng() < 0.5 ? isoDate : `${monthName} ${day} ${year}`;
  const phrase = `${query} ${bareClockSurface(hour, minute, rng)}`;
  return row({
    id: `random-bare-hour-full-date-${index}`,
    text: maybeDirty(phrase, rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'date-anchor', 'full-date', 'ambiguity', 'bare-hour'],
    output: bareHourClarificationPlanner(query, hour, minute),
  });
}

function randomWeekdayAfterNext(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const phrase = maybeDirty(`${weekday} after next`, rng);
  return row({
    id: `random-weekday-after-next-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'weekday-anchor', 'ambiguity'],
    output: planner('clarification', 'Weekday after next is materially ambiguous.', [plan(`${title(weekday)} after next`, [step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'after_next_ambiguous', precision: 'date' })])], `Which ${title(weekday)} did you mean?`),
  });
}

function randomHoliday(index: number, rng: () => number): TemporalIrTrainingRow {
  const year = randomInt(2026, 2032, rng);
  const phrase = maybeDirty(`easter ${year}`, rng);
  return row({
    id: `random-holiday-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'holiday'],
    output: planner('plans', 'Resolve the named holiday in the requested year.', [plan(`Easter ${year}`, [step({ operation: 'resolve_holiday', holidayName: 'easter', year, precision: 'date' })])]),
  });
}

function randomHolidayNoon(index: number, rng: () => number): TemporalIrTrainingRow {
  const year = randomInt(2026, 2032, rng);
  const phrase = maybeDirty(`easter ${year} noon`, rng);
  return row({
    id: `random-holiday-noon-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'holiday', 'explicit-clock'],
    output: planner('plans', 'Resolve the named holiday in the requested year with the requested clock time.', [plan(`Easter ${year} noon`, [step({ operation: 'resolve_holiday', holidayName: 'easter', year, time: { hour: 12, minute: 0 }, precision: 'datetime' })])]),
  });
}

function randomAnchorOffsetClock(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const clock = randomClock(rng);
  const phrase = maybeDirty(`day after next ${weekday} at ${clock.text}`, rng);
  return row({
    id: `random-anchor-offset-clock-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'weekday-anchor', 'offset', 'explicit-clock'],
    output: planner('plans', 'Use next weekday as the anchor, apply the clock, and shift by one day.', [plan(`Day after next ${title(weekday)} at ${clock.label}`, [
      step({ operation: 'resolve_calendar_query', query: `next ${weekday}`, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'shift_datetime', baseStep: 0, timeStep: 1, delta: delta({ days: 1 }), precision: 'datetime' }),
    ], 2)]),
  });
}

function randomExplicitTimestamp(index: number, rng: () => number): TemporalIrTrainingRow {
  const epochSeconds = 1779724800 + randomInt(-5_000_000, 5_000_000, rng);
  const variant = pick(['discord', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds'] as const, rng);
  const text = explicitTimestampText(epochSeconds, variant);
  const inputText = variant === 'discord' ? maybeDirty(text, rng) : text;
  return row({
    id: `random-explicit-timestamp-${index}`,
    text: inputText,
    split: 'train',
    tags: ['random', 'explicit-epoch', variant],
    output: planner('plans', 'Resolve the explicit timestamp with deterministic epoch parsing.', [plan(`Explicit ${variant} timestamp`, [step({ operation: 'resolve_calendar_query', query: inputText, precision: 'datetime' })])]),
  });
}

function randomUnsupportedEpoch(index: number, rng: () => number): TemporalIrTrainingRow {
  const text = pick([
    `-${randomInt(1, 999999, rng)}`,
    '999999999999999999999999999999',
    String(randomInt(10000, 999999999, rng)),
  ], rng);
  return row({
    id: `random-unsupported-epoch-${index}`,
    text,
    split: 'train',
    tags: ['random', 'explicit-epoch', 'unsupported'],
    output: planner('no_plan', 'Unsupported epoch-like numeric input should not produce a timestamp.', []),
  });
}

function randomChainedDayAfterTomorrow(index: number, rng: () => number): TemporalIrTrainingRow {
  const count = randomInt(1, 5, rng);
  const phrase = `${'the day after '.repeat(count)}tomorrow`;
  return row({
    id: `random-chained-day-after-tomorrow-${index}`,
    text: maybeDirty(phrase, rng),
    split: 'train',
    tags: ['random', 'relative', 'recursive-composition', 'offset'],
    output: planner('plans', 'Collapse bounded repeated day-after modifiers into one day shift.', [plan(`${count} days after tomorrow`, [
      step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
      step({ operation: 'shift_datetime', baseStep: 0, delta: delta({ days: count }), precision: 'relative' }),
    ], 1)]),
  });
}

function randomRelativeOffset(index: number, rng: () => number): TemporalIrTrainingRow {
  const spec = {
    amount: randomInt(1, 100, rng),
    unit: pick(relativeOffsetUnits, rng),
    direction: pick(['from_now', 'ago', 'in'] as const, rng),
    split: splitForRandomIndex(index),
  };
  const query = relativeOffsetText(spec);
  return row({
    id: `random-relative-offset-${index}`,
    text: query,
    split: spec.split,
    tags: ['random', 'relative', 'duration', 'offset'],
    output: planner('plans', 'Resolve the relative duration directly with deterministic calendar arithmetic.', [plan(title(query), [
      step({ operation: 'resolve_calendar_query', query, precision: 'relative' }),
    ])]),
  });
}

function randomRelativeShorthand(index: number, rng: () => number): TemporalIrTrainingRow {
  const shorthand = pick(['tom', 'tmw'] as const, rng);
  if (rng() < 0.45) {
    return row({
      id: `random-relative-shorthand-date-${index}`,
      text: shorthand,
      split: splitForRandomIndex(index),
      tags: ['random', 'relative', 'relative-typo', 'shorthand'],
      output: planner('plans', 'Resolve the shorthand relative date directly.', [plan('Tomorrow', [
        step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
      ])]),
    });
  }
  const clock = randomClock(rng);
  return row({
    id: `random-relative-shorthand-clock-${index}`,
    text: `${shorthand} at ${clock.text}`,
    split: splitForRandomIndex(index),
    tags: ['random', 'relative', 'relative-typo', 'shorthand', 'explicit-clock', ...clockTags(clock.text)],
    output: planner('plans', 'Resolve the shorthand relative date and explicit clock separately.', [plan(`Tomorrow ${clock.label}`, [
      step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)]),
  });
}

function randomMonthBoundary(index: number, rng: () => number): TemporalIrTrainingRow {
  const variant = pick([
    { text: 'first of the month', query: 'first of the month', tags: ['month-boundary'] },
    { text: 'first of this month', query: 'first of this month', tags: ['month-boundary', 'direction-this'] },
    { text: 'first of next month', query: 'first of next month', tags: ['month-boundary', 'direction-next'] },
    { text: 'first of last month', query: 'first of last month', tags: ['month-boundary', 'direction-last'] },
    { text: '1st of next month', query: 'first of next month', tags: ['month-boundary', 'direction-next', 'ordinal-numeric'] },
  ], rng);
  const split = splitForRandomIndex(index);
  if (rng() < 0.45) {
    const clock = randomClock(rng);
    const leadingClock = rng() < 0.5;
    const text = leadingClock ? `${clock.text} ${variant.text}` : `${variant.text} at ${clock.text}`;
    return monthBoundaryClockRow(
      `random-month-boundary-clock-${index}`,
      maybeDirty(randomCase(dirtySpacing(text, rng), rng), rng),
      variant.query,
      clock.text,
      `${title(variant.query)} ${clock.label}`,
      ['random', ...variant.tags, ...(leadingClock ? ['clock-leading'] : []), ...clockTags(clock.text)],
      split,
    );
  }
  return calendarQueryRow(
    `random-month-boundary-${index}`,
    maybeDirty(randomCase(dirtySpacing(variant.text, rng), rng), rng),
    variant.query,
    'date',
    ['random', ...variant.tags],
    split,
  );
}

function randomBoundarySnap(index: number, rng: () => number): TemporalIrTrainingRow {
  const amount = randomInt(1, 12, rng);
  const minuteAmount = randomInt(10, 55, rng);
  const variant = pick([
    { text: `in ${amount} hours on the hour`, query: `in ${amount} hours on the hour`, tags: ['relative', 'duration', 'hour'] },
    { text: `in ${amount} hours at the top of the hour`, query: `in ${amount} hours at the top of the hour`, tags: ['relative', 'duration', 'hour'] },
    { text: 'round to nearest hour', query: 'round to nearest hour', tags: ['nearest', 'hour'] },
    { text: 'round to nearest 15 minutes', query: 'round to nearest 15 minutes', tags: ['nearest', 'quarter-hour'] },
    { text: `in ${minuteAmount} minutes round to nearest 15 minutes`, query: `in ${minuteAmount} minutes round to nearest 15 minutes`, tags: ['relative', 'duration', 'quarter-hour'] },
    { text: 'next hour', query: 'next hour', tags: ['direction-next', 'hour'] },
    { text: 'previous hour', query: 'previous hour', tags: ['direction-previous', 'hour'] },
    { text: 'the hour after next', query: 'the hour after next', tags: ['direction-next', 'after-next', 'hour'] },
  ], rng);
  return calendarQueryRow(
    `random-boundary-snap-${index}`,
    maybeDirty(randomCase(dirtySpacing(variant.text, rng), rng), rng),
    variant.query,
    'datetime',
    ['random', 'boundary-snap', ...variant.tags],
    splitForRandomIndex(index),
  );
}

function randomDateFormat(index: number, rng: () => number): TemporalIrTrainingRow {
  const year = 2026;
  const month = randomInt(1, 12, rng);
  const day = randomInt(1, 28, rng);
  const clock = randomClock(rng);
  const hour = randomInt(0, 23, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const clock24 = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const monthName = PLAN_MONTH_NAMES[month - 1]!;
  const variants = [
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${clock24}`,
    `${monthName} ${day} ${year} ${clock.text}`,
    `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year} ${clock.text}`,
    `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year} ${clock24}`,
  ];
  const query = pick(variants, rng);
  return row({
    id: `random-date-format-${index}`,
    text: maybeDirty(query, rng),
    split: 'train',
    tags: ['random', 'date-format-variance', 'explicit-clock'],
    output: planner('plans', 'Delegate conventional date format parsing to the deterministic calendar parser.', [plan('Explicit date and time', [step({ operation: 'resolve_calendar_query', query, precision: 'datetime' })])]),
  });
}

function randomWeekdayTypoClock(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const typo = pick(weekdayTypoVariants[weekday], rng);
  const clock = randomClock(rng);
  const phrase = maybeDirty(`${typo} ${clock.text}`, rng);
  return row({
    id: `random-weekday-typo-clock-${index}`,
    text: phrase,
    split: splitForRandomIndex(index),
    tags: ['random', 'weekday-anchor', 'weekday-typo', 'explicit-clock'],
    output: weekdayTypoClockPlanner(weekday, clock.text, `${title(weekday)} ${clock.label}`),
  });
}

function randomClockFirstWeekdayTypo(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const typo = pick(weekdayTypoVariants[weekday], rng);
  const clock = randomClock(rng);
  const phrase = maybeDirty(`${randomCase(clock.text, rng)} ${typo}`, rng);
  return row({
    id: `random-clock-first-weekday-typo-${index}`,
    text: phrase,
    split: splitForRandomIndex(index),
    tags: ['random', 'weekday-anchor', 'weekday-typo', 'clock-first', 'explicit-clock', ...clockTags(clock.text)],
    output: weekdayTypoClockPlanner(weekday, clock.text, `${title(weekday)} ${clock.label}`),
  });
}

function randomRelativeTypoClock(index: number, rng: () => number): TemporalIrTrainingRow {
  const typo = pick(tomorrowTypoVariants, rng);
  const clock = randomClock(rng);
  const noisy = dirtySpacing(`${typo} ${clock.text}`, rng);
  return row({
    id: `random-relative-typo-clock-${index}`,
    text: maybeDirty(noisy, rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'relative', 'relative-typo', 'explicit-clock', ...clockTags(clock.text)],
    output: planner('plans', 'Correct the relative-date typo, then resolve the normalized date and explicit clock separately.', [plan(`Tomorrow ${clock.label}`, [
      step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)]),
  });
}

function randomRelativeTypoBareHour(index: number, rng: () => number): TemporalIrTrainingRow {
  const typo = pick(tomorrowTypoVariants, rng);
  const hour = randomInt(1, 12, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const bare = minute === 0 ? String(hour) : `${hour}${String(minute).padStart(2, '0')}`;
  return row({
    id: `random-relative-typo-bare-hour-${index}`,
    text: maybeDirty(dirtySpacing(`${typo} ${bare}`, rng), rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'relative', 'relative-typo', 'ambiguity', 'bare-hour'],
    output: bareHourClarificationPlanner('tomorrow', hour, minute),
  });
}

function randomNextWeekdayTypoClockAmbiguity(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const nextWord = pick(nextTypoVariants, rng);
  const weekdayText = pick(weekdayTypoVariants[weekday], rng);
  const clock = randomClock(rng);
  return row({
    id: `random-next-weekday-typo-clock-ambiguous-${index}`,
    text: maybeDirty(dirtySpacing(`${nextWord} ${weekdayText} at ${clock.text}`, rng), rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'weekday-anchor', 'weekday-typo', 'relative-typo', 'ambiguity', 'explicit-clock', ...clockTags(clock.text)],
    output: planner('clarification', 'Correct typo variants while preserving top-level next-weekday ambiguity.', [plan(`Which ${title(weekday)} at ${clock.label}?`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next_ambiguous', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)], `Do you mean the upcoming ${title(weekday)} or the ${title(weekday)} after that?`),
  });
}

function randomMonthTypoDateClock(index: number, rng: () => number): TemporalIrTrainingRow {
  const month = pick(monthTypoVariants, rng);
  const day = randomInt(1, 28, rng);
  const year = randomInt(2026, 2032, rng);
  const clock = randomClock(rng);
  const clockText = rng() < 0.35 ? clock.text.replace(':', '.') : clock.text;
  const text = maybeDirty(dirtySpacing(`${pick(month.variants, rng)} ${day} ${year} ${randomCase(clockText, rng)}`, rng), rng);
  return row({
    id: `random-month-typo-date-clock-${index}`,
    text,
    split: splitForRandomIndex(index),
    tags: ['random', 'month-typo', 'explicit-clock', ...clockTags(clockText)],
    output: planner('plans', 'Correct the month typo and clock separator before deterministic date-time parsing.', [plan('Explicit date and time', [
      step({ operation: 'resolve_calendar_query', query: `${month.name} ${day} ${year} ${clock.text}`, precision: 'datetime' }),
    ])]),
  });
}

function randomNoisyHumanInput(index: number, rng: () => number): TemporalIrTrainingRow {
  const split = splitForRandomIndex(index);
  const variant = pick([
    'month-boundary-bare',
    'month-boundary-explicit',
    'weekday-bare',
    'weekday-explicit',
    'relative-bare',
    'relative-explicit',
    'next-weekday-run-together',
  ] as const, rng);

  if (variant === 'month-boundary-bare' || variant === 'month-boundary-explicit') {
    const month = pick(monthTypoVariants, rng);
    const ordinal = noisyToken('first', ordinalTypoVariants.first, rng);
    const monthText = noisyToken(month.name, month.variants, rng);
    const join = noisyJoin([ordinal.text, 'of', monthText.text], rng);
    const tags = ['random', 'noisy-human-input', 'month-boundary', 'month-typo', ...ordinal.tags, ...monthText.tags, ...join.tags];
    if (variant === 'month-boundary-bare') {
      const hour = randomInt(1, 12, rng);
      const minute = pick([15, 30, 45], rng);
      const clock = bareClockSurface(hour, minute, rng).replace(':', rng() < 0.35 ? '.' : ':');
      const text = decorateNoisyPhrase(`${join.text} ${clock}`, rng);
      return row({
        id: `random-noisy-human-input-month-boundary-bare-${index}`,
        text,
        split,
        tags: [...tags, 'ambiguity', 'bare-hour', ...(clock.includes('.') ? ['clock-separator-variance'] : [])],
        output: bareHourClarificationPlanner(`first of ${month.name}`, hour, minute),
      });
    }

    const clock = randomClock(rng);
    const clockText = rng() < 0.35 ? clock.text.replace(':', '.') : clock.text;
    const text = decorateNoisyPhrase(noisyJoin([join.text, 'at', randomCase(clockText, rng)], rng).text, rng);
    return row({
      id: `random-noisy-human-input-month-boundary-explicit-${index}`,
      text,
      split,
      tags: [...tags, 'explicit-clock', ...clockTags(clockText)],
      output: planner('plans', 'Normalize noisy temporal spelling, then resolve the date and explicit clock separately.', [plan(`First of ${month.name} ${clock.label}`, [
        step({ operation: 'resolve_calendar_query', query: `first of ${month.name}`, precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: clock.text }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)]),
    });
  }

  if (variant === 'weekday-bare' || variant === 'weekday-explicit') {
    const weekday = pick(weekdays, rng);
    const weekdayText = noisyToken(weekday, weekdayTypoVariants[weekday], rng);
    const tags = ['random', 'noisy-human-input', 'weekday-anchor', 'weekday-typo', ...weekdayText.tags];
    if (variant === 'weekday-bare') {
      const hour = randomInt(1, 12, rng);
      const minute = pick([15, 30, 45], rng);
      const clock = bareClockSurface(hour, minute, rng).replace(':', rng() < 0.35 ? '.' : ':');
      const join = noisyJoin([weekdayText.text, clock], rng);
      return row({
        id: `random-noisy-human-input-weekday-bare-${index}`,
        text: decorateNoisyPhrase(join.text, rng),
        split,
        tags: [...tags, ...join.tags, 'ambiguity', 'bare-hour', ...(clock.includes('.') ? ['clock-separator-variance'] : [])],
        output: bareHourClarificationPlanner(weekday, hour, minute),
      });
    }

    const clock = randomClock(rng);
    const join = noisyJoin([weekdayText.text, randomCase(clock.text, rng)], rng);
    return row({
      id: `random-noisy-human-input-weekday-explicit-${index}`,
      text: decorateNoisyPhrase(join.text, rng),
      split,
      tags: [...tags, ...join.tags, 'explicit-clock', ...clockTags(clock.text)],
      output: weekdayTypoClockPlanner(weekday, clock.text, `${title(weekday)} ${clock.label}`),
    });
  }

  if (variant === 'relative-bare' || variant === 'relative-explicit') {
    const relativeText = noisyToken('tomorrow', tomorrowTypoVariants, rng);
    const tags = ['random', 'noisy-human-input', 'relative', 'relative-typo', ...relativeText.tags];
    if (variant === 'relative-bare') {
      const hour = randomInt(1, 12, rng);
      const minute = pick([15, 30, 45], rng);
      const clock = bareClockSurface(hour, minute, rng).replace(':', rng() < 0.35 ? '.' : ':');
      const join = noisyJoin([relativeText.text, clock], rng);
      return row({
        id: `random-noisy-human-input-relative-bare-${index}`,
        text: decorateNoisyPhrase(join.text, rng),
        split,
        tags: [...tags, ...join.tags, 'ambiguity', 'bare-hour', ...(clock.includes('.') ? ['clock-separator-variance'] : [])],
        output: bareHourClarificationPlanner('tomorrow', hour, minute),
      });
    }

    const clock = randomClock(rng);
    const join = noisyJoin([relativeText.text, 'at', randomCase(clock.text, rng)], rng);
    return row({
      id: `random-noisy-human-input-relative-explicit-${index}`,
      text: decorateNoisyPhrase(join.text, rng),
      split,
      tags: [...tags, ...join.tags, 'explicit-clock', ...clockTags(clock.text)],
      output: planner('plans', 'Normalize noisy relative-date spelling, then resolve the date and explicit clock separately.', [plan(`Tomorrow ${clock.label}`, [
        step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: clock.text }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)]),
    });
  }

  const weekday = pick(weekdays, rng);
  const nextText = noisyToken('next', nextTypoVariants, rng);
  const weekdayText = noisyToken(weekday, weekdayTypoVariants[weekday], rng);
  const clock = randomClock(rng);
  const join = noisyJoin([`${nextText.text}${weekdayText.text}`, randomCase(clock.text, rng)], rng);
  return row({
    id: `random-noisy-human-input-next-weekday-run-together-${index}`,
    text: decorateNoisyPhrase(join.text, rng),
    split,
    tags: ['random', 'noisy-human-input', 'weekday-anchor', 'weekday-typo', 'relative-typo', 'run-together', 'ambiguity', 'explicit-clock', ...nextText.tags, ...weekdayText.tags, ...join.tags, ...clockTags(clock.text)],
    output: planner('clarification', 'Normalize noisy run-together next-weekday text while preserving top-level next-weekday ambiguity.', [plan(`Which ${title(weekday)} at ${clock.label}?`, [
      step({ operation: 'resolve_weekday_anchor', weekday, weekdayAnchor: 'next_ambiguous', precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2)], `Do you mean the upcoming ${title(weekday)} or the ${title(weekday)} after that?`),
  });
}

function randomDateSeparatorVariant(index: number, rng: () => number): TemporalIrTrainingRow {
  const year = randomInt(2026, 2032, rng);
  const month = randomInt(1, 12, rng);
  const day = randomInt(1, 28, rng);
  const hour = randomInt(0, 23, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const monthName = PLAN_MONTH_NAMES[month - 1]!;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const clock24 = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const variants = [
    { text: `${year}.${mm}.${dd} ${clock24}`, query: `${year}-${mm}-${dd} ${clock24}`, tags: ['date-separator-variance', 'clock-24h'] },
    { text: `${year}   ${mm}   ${dd}   ${clock24}`, query: `${year}-${mm}-${dd} ${clock24}`, tags: ['date-separator-variance', 'whitespace', 'clock-24h'] },
    { text: `${monthName.toUpperCase()} ${day} ${year} ${clock24}`, query: `${monthName} ${day} ${year} ${clock24}`, tags: ['casing', 'clock-24h'] },
    { text: `${monthName}     ${day}     ${year}     ${clock24}`, query: `${monthName} ${day} ${year} ${clock24}`, tags: ['whitespace', 'clock-24h'] },
  ];
  const variant = pick(variants, rng);
  return row({
    id: `random-date-separator-variant-${index}`,
    text: maybeDirty(variant.text, rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'explicit-clock', ...variant.tags],
    output: planner('plans', 'Normalize date separators, casing, or spacing before deterministic date-time parsing.', [plan('Explicit date and time', [
      step({ operation: 'resolve_calendar_query', query: variant.query, precision: 'datetime' }),
    ])]),
  });
}

function randomNoisyEventPost(index: number, rng: () => number): TemporalIrTrainingRow {
  const month = pick(['May', 'June', 'July'], rng);
  const day = randomInt(1, 28, rng);
  const weekday = actualWeekday2026(month, day);
  const weekdayText = rng() < 0.45 ? pick(weekdayTypoVariants[weekday], rng) : title(weekday);
  const monthText = rng() < 0.35 ? pick(monthTypoVariants.find((entry) => entry.name === month)?.variants ?? [month], rng) : month;
  const doors = randomClock(rng);
  const main = randomClock(rng);
  const query = `${title(weekday)} ${month} ${day}`;
  const layouts = [
    `Club night:\n${weekdayText} ${monthText} ${day}\nDoors ${doors.text}\nMain set ${main.text}`,
    `poster copy says ${weekdayText} ${monthText} ${day}; doors ${doors.text}; main ${main.text}; lineup TBD`,
    `${weekdayText} ${monthText} ${day} - doors ${doors.text} - headline ${main.text} - ticket link soon`,
  ];
  return row({
    id: `random-noisy-event-post-${index}`,
    text: pick(layouts, rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'event-post', 'ambiguity', 'multi-time', 'noise', 'weekday-typo', 'month-typo'],
    output: eventPostPlanner(query, doors.text, main.text),
  });
}

function randomCompoundTypoAnchorOffsetClock(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const weekdayText = pick(weekdayTypoVariants[weekday], rng);
  const after = pick(afterTypoVariants, rng);
  const clock = randomClock(rng);
  const phrase = maybeDirty(dirtySpacing(`day ${after} next ${weekdayText} at ${clock.text}`, rng), rng);
  return row({
    id: `random-compound-typo-anchor-offset-clock-${index}`,
    text: phrase,
    split: splitForRandomIndex(index),
    tags: ['random', 'weekday-anchor', 'weekday-typo', 'relative-typo', 'offset', 'explicit-clock', ...clockTags(clock.text)],
    output: planner('plans', 'Correct typo variants, use next weekday as the anchor, apply the clock, and shift by one day.', [plan(`Day after next ${title(weekday)} at ${clock.label}`, [
      step({ operation: 'resolve_calendar_query', query: `next ${weekday}`, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: clock.text }),
      step({ operation: 'shift_datetime', baseStep: 0, timeStep: 1, delta: delta({ days: 1 }), precision: 'datetime' }),
    ], 2)]),
  });
}

function randomWhitespaceCasingVariant(index: number, rng: () => number): TemporalIrTrainingRow {
  const clock = randomClock(rng);
  const base = pick([
    { text: `tomorrow at ${clock.text}`, query: 'tomorrow', tags: ['relative'] },
    { text: `next monday at ${clock.text}`, query: 'next monday', tags: ['weekday-anchor'] },
    { text: `June 4 2026 ${clock.text}`, query: `June 4 2026 ${clock.text}`, tags: ['date-format-variance'] },
  ], rng);
  const text = randomCase(dirtySpacing(base.text, rng), rng);
  if (base.query === 'tomorrow' || base.query === 'next monday') {
    return row({
      id: `random-whitespace-casing-variant-${index}`,
      text: maybeDirty(text, rng),
      split: splitForRandomIndex(index),
      tags: ['random', 'whitespace', 'casing', 'explicit-clock', ...base.tags, ...clockTags(clock.text)],
      output: planner('plans', 'Normalize casing and whitespace, then resolve date and clock separately.', [plan(`${title(base.query)} ${clock.label}`, [
        step({ operation: 'resolve_calendar_query', query: base.query, precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: clock.text }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2)]),
    });
  }
  return row({
    id: `random-whitespace-casing-variant-${index}`,
    text: maybeDirty(text, rng),
    split: splitForRandomIndex(index),
    tags: ['random', 'whitespace', 'casing', 'explicit-clock', ...base.tags, ...clockTags(clock.text)],
    output: planner('plans', 'Normalize casing and whitespace before deterministic date-time parsing.', [plan('Explicit date and time', [
      step({ operation: 'resolve_calendar_query', query: base.query, precision: 'datetime' }),
    ])]),
  });
}

function explicitTimestampText(epochSeconds: number, variant: 'discord' | 'seconds' | 'milliseconds' | 'microseconds' | 'nanoseconds'): string {
  if (variant === 'discord') {
    return `<t:${epochSeconds}:F>`;
  }
  const epoch = BigInt(epochSeconds);
  if (variant === 'seconds') {
    return String(epoch);
  }
  if (variant === 'milliseconds') {
    return String(epoch * 1_000n);
  }
  if (variant === 'microseconds') {
    return String(epoch * 1_000_000n);
  }
  return String(epoch * 1_000_000_000n);
}

function randomCompoundRelativeLeet(index: number, rng: () => number): TemporalIrTrainingRow {
  const leet = pick(['l33t time', '133t time', 'leet time'], rng);
  const phrase = maybeDirty(`day after a week from tomorrow at ${leet}`, rng);
  return row({
    id: `random-compound-relative-leet-${index}`,
    text: phrase,
    split: 'train',
    tags: ['random', 'relative', 'offset', 'fuzzy-clock'],
    output: planner('plans', 'Resolve tomorrow, infer leet time as 13:37, then shift by eight days.', [plan('Day after a week from tomorrow at leet time', [
      step({ operation: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' }),
      step({ operation: 'interpret_clock_phrase', text: leet, time: { hour: 13, minute: 37 } }),
      step({ operation: 'shift_datetime', baseStep: 0, timeStep: 1, delta: delta({ days: 8 }), precision: 'datetime' }),
    ], 2)]),
  });
}

function randomOrdinalWeekday(index: number, rng: () => number): TemporalIrTrainingRow {
  const ordinal = pick(['first', 'second', 'third', 'fourth'], rng);
  const weekday = pick(weekdays, rng);
  const clock = randomClock(rng);
  const month = pick(monthNames, rng);
  const usesExplicitMonth = rng() < 0.45;
  const query = usesExplicitMonth
    ? `${ordinal} ${weekday} of ${month}${rng() < 0.45 ? ` at ${clock.text}` : ''}`
    : `${ordinal} ${weekday} of next month at ${clock.text}`;
  return row({
    id: `random-ordinal-weekday-${index}`,
    text: maybeDirty(query, rng),
    split: 'train',
    tags: ['random', 'ordinal-weekday', ...(usesExplicitMonth ? ['explicit-month-name'] : []), ...(!usesExplicitMonth || query.includes(' at ') ? ['explicit-clock'] : [])],
    output: planner('plans', 'Use deterministic calendar grammar for the ordinal weekday phrase.', [plan(title(query), [step({ operation: 'resolve_calendar_query', query, precision: query.includes(' at ') ? 'datetime' : 'date' })])]),
  });
}

function randomOrdinalWeekdayShiftNoon(index: number, rng: () => number): TemporalIrTrainingRow {
  const weekday = pick(weekdays, rng);
  const query = `the day after the first ${weekday} of next month at one hour past noon and 10 minutes`;
  return row({
    id: `random-ordinal-weekday-shift-noon-${index}`,
    text: maybeDirty(query, rng),
    split: 'train',
    tags: ['random', 'ordinal-weekday', 'offset', 'relative-clock'],
    output: planner('plans', 'Use deterministic calendar grammar for the shifted ordinal weekday phrase.', [plan(`Day after first ${title(weekday)} next month at 1:10 PM`, [step({ operation: 'resolve_calendar_query', query, precision: 'datetime' })])]),
  });
}

function randomEventPost(index: number, rng: () => number): TemporalIrTrainingRow {
  const month = pick(['May', 'June', 'July'], rng);
  const day = randomInt(1, 28, rng);
  const weekday = actualWeekday2026(month, day);
  const open = randomClock(rng);
  const main = randomClock(rng);
  const query = `${title(weekday)} ${month} ${day}`;
  const text = maybeDirty(`Club night: ${query}, doors ${open.text}, main set ${main.text}`, rng);
  return row({
    id: `random-event-post-${index}`,
    text,
    split: 'train',
    tags: ['random', 'event-post', 'ambiguity', 'multi-time'],
    output: planner('clarification', 'The event post has one date and two plausible event times.', [
      plan(`Doors ${open.label}`, [
        step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: open.text }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2),
      plan(`Main set ${main.label}`, [
        step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
        step({ operation: 'resolve_clock_time', text: main.text }),
        step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
      ], 2),
    ], 'Which event time should the Discord timestamp use?'),
  });
}

function eventPostPlanner(query: string, doorsText: string, mainText: string): TemporalPlanPlannerOutput {
  return planner('clarification', 'The event post has one date and two plausible event times.', [
    plan(`Doors ${displayClockText(doorsText)}`, [
      step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: doorsText }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`Main set ${displayClockText(mainText)}`, [
      step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: mainText }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
  ], 'Which event time should the Discord timestamp use?');
}

function bareHourClarificationPlanner(query: string, hour: number, minute: number): TemporalPlanPlannerOutput {
  const am = `${hour}:${String(minute).padStart(2, '0')}am`;
  const pm = `${hour}:${String(minute).padStart(2, '0')}pm`;
  return planner('clarification', 'Bare hour requires AM/PM clarification.', [
    plan(`${title(query)} ${hourLabel(hour, minute)} AM`, [
      step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: am }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
    plan(`${title(query)} ${hourLabel(hour, minute)} PM`, [
      step({ operation: 'resolve_calendar_query', query, precision: 'date' }),
      step({ operation: 'resolve_clock_time', text: pm }),
      step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
    ], 2),
  ], 'Which time did you mean?');
}

function weekdayTypoClockPlanner(weekday: typeof weekdays[number], clockText: string, label: string): TemporalPlanPlannerOutput {
  return planner('plans', 'Correct the weekday typo, then resolve the normalized weekday and explicit clock.', [plan(label, [
    step({ operation: 'resolve_calendar_query', query: weekday, precision: 'date' }),
    step({ operation: 'resolve_clock_time', text: clockText }),
    step({ operation: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' }),
  ], 2)]);
}

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

const weekdayTypoVariants: Record<typeof weekdays[number], readonly string[]> = {
  monday: ['mon', 'mnday', 'monn', 'mondayy'],
  tuesday: ['tu', 'tue', 'tues', 'tuee', 'tuseday'],
  wednesday: ['wed', 'weds', 'wedn', 'weddd', 'wensday'],
  thursday: ['thu', 'thur', 'thurs', 'thrs', 'thurr'],
  friday: ['fri', 'fr', 'frii', 'frday'],
  saturday: ['sat', 'satt', 'satdy', 'satrday'],
  sunday: ['sun', 'sund', 'sunnd', 'sundayy'],
};

const tomorrowTypoVariants = ['tom', 'tmw', 'tmrw', 'tomrw', 'tomorow', 'tomorrrow', 'tommorrow', 'tomoroww'] as const;
const nextTypoVariants = ['nxt', 'nextt', 'nexxt', 'neext'] as const;
const afterTypoVariants = ['aftr', 'afterr', 'aftre'] as const;
const ordinalTypoVariants = {
  first: ['frist', 'frst', 'firsst', 'firset'],
} as const;

const tokenJunkSuffixes = ['x', 'z', 'zz', 'sdf', 'rr', 'y'] as const;

const keyboardNeighbors: Record<string, readonly string[]> = {
  a: ['s', 'q', 'w'],
  c: ['x', 'v', 'd'],
  d: ['s', 'f', 'e'],
  e: ['w', 'r', 'd'],
  f: ['d', 'g', 'r'],
  h: ['g', 'j', 'u'],
  i: ['u', 'o', 'k'],
  l: ['k', 'o', 'p'],
  m: ['n', 'j', 'k'],
  n: ['b', 'm', 'h'],
  o: ['i', 'p', 'l'],
  r: ['e', 't', 'f'],
  s: ['a', 'd', 'w'],
  t: ['r', 'y', 'g'],
  u: ['y', 'i', 'j'],
  v: ['c', 'b', 'f'],
  w: ['q', 'e', 's'],
  x: ['z', 'c', 's'],
  y: ['t', 'u', 'h'],
};

const monthTypoVariants: Array<{ name: string; variants: readonly string[] }> = [
  { name: 'January', variants: ['jan', 'janurary', 'januari', 'jnuary'] },
  { name: 'February', variants: ['feb', 'febuary', 'feburary', 'febrary'] },
  { name: 'March', variants: ['mar', 'mrach', 'marchh'] },
  { name: 'April', variants: ['apr', 'april', 'aprill', 'apirl'] },
  { name: 'May', variants: ['mayy', 'mya'] },
  { name: 'June', variants: ['jun', 'junee', 'jnu'] },
  { name: 'July', variants: ['jul', 'julyy', 'jly'] },
  { name: 'August', variants: ['aug', 'augst', 'auguest'] },
  { name: 'September', variants: ['sep', 'sept', 'septmber', 'septembar', 'setpember'] },
  { name: 'October', variants: ['oct', 'octber', 'octtober'] },
  { name: 'November', variants: ['nov', 'novemebr', 'novemeber'] },
  { name: 'December', variants: ['dec', 'decemeber', 'decmeber'] },
];

function randomClock(rng: () => number): { text: string; label: string } {
  if (rng() < 0.35) {
    const hour = randomInt(0, 23, rng);
    const minute = pick([0, 15, 30, 37, 45], rng);
    const text = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return { text, label: text };
  }
  const hour = randomInt(1, 12, rng);
  const minute = pick([0, 15, 30, 45], rng);
  const meridiem = pick(['am', 'pm'], rng);
  const text = minute === 0 ? `${hour}${meridiem}` : `${hour}:${String(minute).padStart(2, '0')}${meridiem}`;
  return { text, label: `${hourLabel(hour, minute)} ${meridiem.toUpperCase()}` };
}

function hourLabel(hour: number, minute: number): string {
  return minute === 0 ? String(hour) : `${hour}:${String(minute).padStart(2, '0')}`;
}

function bareClockSurface(hour: number, minute: number, rng: () => number): string {
  if (minute === 0) {
    return String(hour);
  }
  const minuteText = String(minute).padStart(2, '0');
  return rng() < 0.5 ? `${hour}${minuteText}` : `${hour}:${minuteText}`;
}

function displayClockText(text: string): string {
  return text.replace(/([ap])m$/i, (_, meridiem: string) => ` ${meridiem.toUpperCase()}M`).replace('.', ':');
}

function clockTags(text: string): string[] {
  const tags: string[] = [];
  if (/^\d{1,2}:\d{2}$/.test(text)) {
    tags.push('clock-24h');
  }
  if (text.includes('.')) {
    tags.push('clock-separator-variance');
  }
  return tags;
}

function dirtySpacing(text: string, rng: () => number): string {
  if (rng() < 0.35) {
    return text;
  }
  return text.replace(/ /g, () => pick([' ', '  ', '   ', '\t'], rng));
}

function randomCase(text: string, rng: () => number): string {
  const roll = rng();
  if (roll < 0.25) {
    return text;
  }
  if (roll < 0.45) {
    return text.toUpperCase();
  }
  if (roll < 0.65) {
    return text.toLowerCase();
  }
  return text.replace(/[a-z]/gi, (char) => (rng() < 0.5 ? char.toLowerCase() : char.toUpperCase()));
}

function noisyToken(base: string, variants: readonly string[], rng: () => number): { text: string; tags: string[] } {
  const source = rng() < 0.55 ? pick(variants, rng) : base;
  const tags = source === base ? [] : ['lexical-typo'];
  const roll = rng();
  if (roll < 0.18) {
    return { text: repeatLetterTypo(source, rng), tags: [...tags, 'repeated-letter'] };
  }
  if (roll < 0.34) {
    return { text: missingLetterTypo(source, rng), tags: [...tags, 'missing-letter'] };
  }
  if (roll < 0.5) {
    return { text: transposedLetterTypo(source, rng), tags: [...tags, 'transposed-letter'] };
  }
  if (roll < 0.66) {
    return { text: keyboardAdjacentTypo(source, rng), tags: [...tags, 'keyboard-adjacent-typo'] };
  }
  if (roll < 0.82) {
    return { text: `${source}${pick(tokenJunkSuffixes, rng)}`, tags: [...tags, 'noise-suffix'] };
  }
  return { text: source, tags };
}

function repeatLetterTypo(text: string, rng: () => number): string {
  const index = randomInt(0, Math.max(0, text.length - 1), rng);
  return `${text.slice(0, index)}${text[index]}${text.slice(index)}`;
}

function missingLetterTypo(text: string, rng: () => number): string {
  if (text.length <= 3) {
    return text;
  }
  const index = randomInt(1, text.length - 2, rng);
  return `${text.slice(0, index)}${text.slice(index + 1)}`;
}

function transposedLetterTypo(text: string, rng: () => number): string {
  if (text.length <= 3) {
    return text;
  }
  const index = randomInt(0, text.length - 2, rng);
  return `${text.slice(0, index)}${text[index + 1]}${text[index]}${text.slice(index + 2)}`;
}

function keyboardAdjacentTypo(text: string, rng: () => number): string {
  const candidates = [...text].map((char, index) => ({ char: char.toLowerCase(), index })).filter((entry) => keyboardNeighbors[entry.char]);
  if (candidates.length === 0) {
    return text;
  }
  const candidate = pick(candidates, rng);
  const replacement = pick(keyboardNeighbors[candidate.char]!, rng);
  return `${text.slice(0, candidate.index)}${replacement}${text.slice(candidate.index + 1)}`;
}

function noisyJoin(parts: string[], rng: () => number): { text: string; tags: string[] } {
  const tags = new Set<string>();
  let text = parts[0] ?? '';
  for (const part of parts.slice(1)) {
    const separator = pick([' ', ' ', '  ', '\t', ''] as const, rng);
    if (separator === '') {
      tags.add('run-together');
    } else if (separator !== ' ') {
      tags.add('spacing-damage');
    }
    text += `${separator}${part}`;
  }
  return { text, tags: [...tags] };
}

function decorateNoisyPhrase(phrase: string, rng: () => number): string {
  const text = randomCase(phrase, rng);
  return rng() < 0.7 ? maybeDirty(text, rng) : text;
}

function maybeDirty(phrase: string, rng: () => number): string {
  const roll = rng();
  if (roll < 0.2) {
    return phrase;
  }
  if (roll < 0.4) {
    return `${pick(prefixNoise, rng)} ${phrase}`;
  }
  if (roll < 0.6) {
    return `${phrase} ${pick(suffixNoise, rng)}`;
  }
  if (roll < 0.8) {
    return `${pick(prefixNoise, rng)} ${phrase} ${pick(suffixNoise, rng)}`;
  }
  return `${pick(prefixNoise, rng)} ${phrase}; ${pick(extraNoise, rng)}`;
}

const prefixNoise = [
  'remind me',
  'for discord use',
  'quick note',
  'calendar draft says',
  'ignore the rest but parse',
  'event blurb:',
];

const suffixNoise = [
  'thanks',
  'for the server',
  'please format it',
  'when you can',
  'for the announcement',
  'not the other dates',
];

const extraNoise = [
  'theme is still TBD',
  'venue copy comes later',
  'this is not a recurring event',
  'bring snacks maybe',
  'poster text is unfinished',
];

function pick<T>(values: readonly T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length)]!;
}

function randomInt(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function title(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function actualWeekday2026(month: string, day: number): typeof weekdays[number] {
  const monthNumber = { May: 4, June: 5, July: 6 }[month as 'May' | 'June' | 'July'];
  const jsDay = new Date(Date.UTC(2026, monthNumber, day)).getUTCDay();
  return weekdays[(jsDay + 6) % 7]!;
}

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function splitForId(id: string): Split {
  if (/ambiguous|unsupported|^direct-|^chained-day-after-tomorrow/.test(id)) {
    return 'holdout';
  }
  if (/holiday|ordinal/.test(id)) {
    return 'validation';
  }
  return 'train';
}

function splitForRandomIndex(index: number): Split {
  const bucket = index % 10;
  if (bucket === 8) {
    return 'validation';
  }
  if (bucket === 9) {
    return 'holdout';
  }
  return 'train';
}

function planner(
  outcome: TemporalPlanPlannerOutput['outcome'],
  reason: string,
  plans: TemporalPlan[],
  clarificationQuestion: string | null = null,
): TemporalPlanPlannerOutput {
  return TemporalPlanPlannerSchema.parse({ outcome, reason, clarificationQuestion, plans });
}

function plan(label: string, steps: TemporalPlanStep[], finalStep: number | null = null, confidence = 0.9): TemporalPlan {
  return {
    label,
    rationale: label,
    assumptions: [],
    confidence,
    finalStep,
    steps,
  };
}

function step(overrides: Partial<TemporalPlanStep> & Pick<TemporalPlanStep, 'operation'>): TemporalPlanStep {
  return {
    operation: overrides.operation,
    query: overrides.query ?? null,
    text: overrides.text ?? null,
    holidayName: overrides.holidayName ?? null,
    weekday: overrides.weekday ?? null,
    weekdayAnchor: overrides.weekdayAnchor ?? null,
    year: overrides.year ?? null,
    baseStep: overrides.baseStep ?? null,
    time: overrides.time ?? null,
    timeStep: overrides.timeStep ?? null,
    delta: overrides.delta ?? delta({}),
    isoInstant: overrides.isoInstant ?? null,
    epochSeconds: overrides.epochSeconds ?? null,
    timeZone: overrides.timeZone ?? null,
    precision: overrides.precision ?? null,
    assumptions: overrides.assumptions ?? [],
  };
}

function delta(overrides: Partial<TemporalPlanStep['delta']>): TemporalPlanStep['delta'] {
  return {
    years: overrides.years ?? null,
    months: overrides.months ?? null,
    weeks: overrides.weeks ?? null,
    days: overrides.days ?? null,
    hours: overrides.hours ?? null,
    minutes: overrides.minutes ?? null,
  };
}

function validateRow(row: TemporalIrTrainingRow): TemporalIrTrainingRow {
  return {
    ...row,
    output: TemporalPlanPlannerSchema.parse(row.output),
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
