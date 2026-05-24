import assert from 'node:assert/strict';
import { parseTemporalExpression } from '../src/temporal';
import { collectTemporalAgentContext } from '../src/temporal/deterministic';
import { createDeterministicTemporalToolImplementations } from '../src/temporal/tools';

const referenceInstant = '2026-05-15T16:00:00Z'; // Friday noon in America/New_York.
const timeZone = 'America/New_York';
const calendarContext = { referenceInstant, timeZone };

async function parse(text: string) {
  return parseTemporalExpression({ text, timeZone, referenceInstant });
}

async function main() {
  const bareSaturday = await parse('Saturday');
  assert.equal(bareSaturday.status, 'resolved');
  assert.equal(bareSaturday.canonical?.weekday, 'saturday');
  assert.equal(bareSaturday.canonical?.zonedDateTime.startsWith('2026-05-16'), true);

  const nextSaturday = await parse('next Saturday');
  assert.equal(nextSaturday.status, 'resolved');
  assert.equal(nextSaturday.canonical?.weekday, 'saturday');
  assert.equal(nextSaturday.canonical?.zonedDateTime.startsWith('2026-05-23'), true);

  const ambiguousBareTime = await parse('next Saturday 1');
  assert.equal(ambiguousBareTime.status, 'needs_clarification');
  assert.equal(ambiguousBareTime.clarificationQuestion, 'Which time did you mean?');
  assert.equal(ambiguousBareTime.clarificationAlternatives?.length, 2);
  assert.equal(ambiguousBareTime.clarificationAlternatives?.[0]?.label, '1 AM');
  assert.equal(ambiguousBareTime.clarificationAlternatives?.[1]?.label, '1 PM');

  const nextWednesday = await parse('next Wednesday');
  assert.equal(nextWednesday.status, 'resolved');
  assert.equal(nextWednesday.canonical?.weekday, 'wednesday');
  assert.equal(nextWednesday.canonical?.zonedDateTime.startsWith('2026-05-20'), true);

  const explicitDiscord = await parse('<t:1776221807:f>');
  assert.equal(explicitDiscord.status, 'resolved');
  assert.equal(explicitDiscord.epoch, 1776221807);

  const explicitIsoInstant = await parse('2026-05-17T10:00:00Z');
  assert.equal(explicitIsoInstant.status, 'resolved');
  assert.equal(explicitIsoInstant.canonical?.isoInstant, '2026-05-17T10:00:00Z');

  const tomorrowAtFive = await parse('tomorrow at 5pm');
  assert.equal(tomorrowAtFive.status, 'resolved');
  assert.equal(tomorrowAtFive.canonical?.zonedDateTime.startsWith('2026-05-16T17:00'), true);

  const weekdayDateTimeFormat = await parse('4:30 Tuesday');
  assert.equal(weekdayDateTimeFormat.status, 'resolved');
  assert.equal(weekdayDateTimeFormat.suggestedFormatIndex, 5);

  const relativeFormat = await parse('in 3 days');
  assert.equal(relativeFormat.status, 'resolved');
  assert.equal(relativeFormat.suggestedFormatIndex, 6);

  const dateOnlyNoon = await parseTemporalExpression({
    text: 'tomorrow',
    timeZone,
    referenceInstant: '2026-05-15T16:34:56Z',
  });
  assert.equal(dateOnlyNoon.status, 'resolved');
  assert.equal(dateOnlyNoon.canonical?.zonedDateTime.startsWith('2026-05-16T12:00:00'), true);

  const deterministicEaster = await parse('easter');
  assert.equal(deterministicEaster.status, 'failed');

  const tools = createDeterministicTemporalToolImplementations();
  const agentContext = collectTemporalAgentContext({ text: 'easter 2026 noon', calendarContext });
  assert.equal(agentContext.reference.localDate, '2026-05-15');
  assert.equal(agentContext.holidays[0]?.name, 'Easter Sunday');
  assert.equal(agentContext.holidays[0]?.isoDate, '2026-04-05');

  const easter = await tools.resolveHoliday({ holidayName: 'easter', calendarContext });
  assert.equal(easter.candidates[0]?.zonedDateTime.startsWith('2027-03-28T12:00'), true);

  const easterMidnight = await tools.resolveHoliday({ holidayName: 'easter', time: { hour: 0, minute: 0 }, calendarContext });
  assert.equal(easterMidnight.candidates[0]?.zonedDateTime.startsWith('2027-03-28T00:00'), true);

  const easter2026 = await tools.resolveHoliday({ holidayName: 'easter', year: 2026, calendarContext });
  assert.equal(easter2026.candidates[0]?.zonedDateTime.startsWith('2026-04-05T12:00'), true);

  const parsedCompound = await parse('day after a week from tomorrow at 133t time');
  assert.equal(parsedCompound.status, 'failed');

  const parsedCompoundTool = await tools.parseExpression({ text: 'day after a week from tomorrow at 133t time', calendarContext });
  assert.equal(parsedCompoundTool.candidates.length, 0);

  const clock = await tools.resolveClockTime({ text: '13:37', calendarContext });
  assert.equal(clock.candidates[0]?.hour, 13);
  assert.equal(clock.candidates[0]?.minute, 37);

  const shifted = await tools.shiftDateTime({ base: { isoInstant: referenceInstant }, delta: { weeks: 1, days: 2 }, calendarContext });
  const combined = await tools.setClockTime({
    base: { zonedDateTime: shifted.zonedDateTime },
    time: { hour: 13, minute: 37 },
    calendarContext,
  });
  assert.equal(combined.zonedDateTime.startsWith('2026-05-24T13:37'), true);
  const shiftedWithTime = await tools.shiftDateTime({
    base: { isoInstant: referenceInstant },
    delta: { weeks: 1, days: 2 },
    time: { hour: 13, minute: 37 },
    calendarContext,
  });
  assert.equal(shiftedWithTime.zonedDateTime.startsWith('2026-05-24T13:37'), true);

  const nextSaturdayAnchor = await tools.resolveCalendarQuery({ query: 'next saturday', calendarContext });
  const dayAfterNextSaturday = await tools.shiftDateTime({
    base: { zonedDateTime: nextSaturdayAnchor.candidates[0]!.zonedDateTime },
    delta: { days: 1 },
    time: { hour: 13, minute: 37 },
    calendarContext,
  });
  const shiftedWeekdayValidation = await tools.validateCandidate({
    originalText: 'day after next saturday at 13:37',
    candidate: dayAfterNextSaturday,
    calendarContext,
  });
  assert.equal(shiftedWeekdayValidation.passed, true);
  assert.equal(shiftedWeekdayValidation.warnings.some((warning) => warning.includes('candidate is sunday')), true);

  const validation = await tools.validateCandidate({
    originalText: 'May 24 at 13:37',
    candidate: combined,
    calendarContext,
  });
  assert.equal(validation.passed, true);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
