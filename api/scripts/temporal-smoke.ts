import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { parseTemporalExpression } from '../src/temporal';
import { collectTemporalAgentContext, parseCalendarContext } from '../src/temporal/deterministic';
import { executeTemporalPlanPlannerOutput, formatEndpointInputJson } from '../src/temporal/graph';
import { parseTemporalPlanPlannerOutput } from '../src/temporal/plan-ir';
import { createDeterministicTemporalToolImplementations } from '../src/temporal/tools';

const referenceInstant = '2026-05-15T16:00:00Z'; // Friday noon in America/New_York.
const timeZone = 'America/New_York';
const calendarContext = { referenceInstant, timeZone };

async function parse(text: string) {
  return parseTemporalExpression({ text, timeZone, referenceInstant });
}

async function executeModelReferenceShift(
  text: string,
  reference: string,
  delta: Record<string, number>,
) {
  const plan = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    reason: 'Test fixture representing a model-interpreted Discord reference transformation.',
    clarificationQuestion: null,
    plans: [{
      label: 'Model-interpreted Discord reference shift',
      rationale: 'Resolve the explicit anchor and apply the semantic transformation.',
      assumptions: [],
      confidence: 1,
      finalStep: 1,
      steps: [
        { op: 'resolve_calendar_query', query: reference, precision: 'datetime' },
        { op: 'shift_datetime', baseStep: 0, delta, precision: 'datetime' },
      ],
    }],
  });
  return executeTemporalPlanPlannerOutput(
    plan,
    { text, calendarContext },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      method: 'agent+plan',
      modelName: 'model-plan-fixture',
    },
  );
}

async function executeModelReferenceClockComposition(
  text: string,
  reference: string,
  clock: string,
) {
  const plan = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    reason: 'Test fixture representing a model-composed Discord timestamp date and explicit clock.',
    clarificationQuestion: null,
    plans: [{
      format: 'f',
      label: 'Discord timestamp date with requested clock',
      rationale: 'Resolve the explicit timestamp as the date anchor, then replace its local clock.',
      assumptions: [],
      confidence: 1,
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: reference, precision: 'date' },
        { op: 'resolve_clock_time', text: clock },
        { op: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' },
      ],
    }],
  });
  return executeTemporalPlanPlannerOutput(
    plan,
    { text, calendarContext },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      method: 'agent+plan',
      modelName: 'model-plan-fixture',
    },
  );
}

async function executeModelReferenceShiftClockClarification(
  text: string,
  reference: string,
) {
  const clarification = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    reason: 'Test fixture representing selectable AM/PM alternatives after a Discord-reference shift.',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      format: 'f',
      label: 'Shifted date at 2',
      rationale: 'Resolve the reference date, set an explicit meridiem, and apply the requested day shift.',
      assumptions: [],
      confidence: 0.85,
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: reference, precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -1 }, precision: 'datetime' },
      ],
    }],
  });
  return executeTemporalPlanPlannerOutput(
    clarification,
    { text, calendarContext },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      method: 'agent+plan',
      modelName: 'model-plan-clarification-fixture',
    },
  );
}

async function main() {
  const normalizedCalendarContext = parseCalendarContext(timeZone, '2026-06-08T06:50:00.123Z');
  assert.equal(normalizedCalendarContext.referenceInstant, '2026-06-08T06:50:00Z');
  const epochZeroWithPreflightDisabled = await parseTemporalExpression({
    text: '0',
    timeZone,
    referenceInstant,
    features: { deterministicPreflight: false, planIr: true },
    planIrEndpoint: {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'must-not-be-called-for-explicit-epoch-zero',
      instructionPreset: 'minimal',
      api: 'chat',
      promptFormat: 'chat',
      maxTokens: 64,
      timeoutMs: 1,
    },
  });
  assert.equal(epochZeroWithPreflightDisabled.status, 'resolved');
  assert.equal(epochZeroWithPreflightDisabled.epoch, 0);
  assert.equal(epochZeroWithPreflightDisabled.method, 'deterministic');
  assert.equal(epochZeroWithPreflightDisabled.debug?.shortCircuitReason, 'deterministic_resolved_validation_passed');
  const referencePromptInput = JSON.parse(formatEndpointInputJson({
    text: '<t:1785643200:t> 1 hour later',
    referenceInstant,
    timeZone,
  })) as { discordTimestampRouting?: { route?: string; references?: unknown[] } };
  assert.equal(referencePromptInput.discordTimestampRouting?.route, 'model');
  assert.equal(referencePromptInput.discordTimestampRouting?.references?.length, 1);
  const composedReferenceClock = await executeModelReferenceClockComposition(
    '<t:1785643200:t> day at 12 pm',
    '<t:1785643200:t>',
    '12 pm',
  );
  assert.equal(composedReferenceClock.status, 'resolved');
  assert.equal(composedReferenceClock.epoch, 1785686400);
  assert.equal(composedReferenceClock.method, 'agent+plan');
  assert.equal(composedReferenceClock.suggestedFormatIndex, 4);
  const ambiguousComposedReferenceClock = await executeModelReferenceClockComposition(
    '<t:1785643200:t> day at 12',
    '<t:1785643200:t>',
    '12 pm',
  );
  assert.equal(ambiguousComposedReferenceClock.status, 'needs_clarification');
  assert.deepEqual(
    ambiguousComposedReferenceClock.clarificationAlternatives?.map((alternative) => alternative.label),
    ['12 AM', '12 PM'],
  );
  assert.equal(ambiguousComposedReferenceClock.validation.checks.includes('plan_ir_clarification'), true);
  const noOpMidnightClockComposition = await executeModelReferenceClockComposition(
    '<t:1785643200:t> that day at midnight',
    '<t:1785643200:t>',
    'midnight',
  );
  assert.equal(noOpMidnightClockComposition.status, 'resolved');
  assert.equal(noOpMidnightClockComposition.epoch, 1785643200);
  assert.equal(noOpMidnightClockComposition.suggestedFormatIndex, 4);
  assert.throws(
    () => parseTemporalPlanPlannerOutput({
      outcome: 'plans',
      plans: [{ format: 'not-a-discord-format', label: 'Invalid format', finalStep: 0, steps: [{ op: 'resolve_calendar_query', query: 'tomorrow' }] }],
    }),
    /Invalid option/,
  );

  const selfReferentialPlan = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    reason: 'Invalid model plan fixture.',
    clarificationQuestion: null,
    plans: [{
      label: 'Self-referential plan',
      confidence: 1,
      finalStep: 1,
      steps: [
        { op: 'resolve_calendar_query', query: 'now', baseStep: 0 },
        { op: 'shift_datetime', baseStep: 0, delta: { days: 1 } },
      ],
    }],
  });
  const selfReferentialResult = await executeTemporalPlanPlannerOutput(
    selfReferentialPlan,
    { text: '1 day from now', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(selfReferentialResult.status, 'failed');
  assert.match(JSON.stringify(selfReferentialResult), /cyclic step dependency/);

  const bareSaturday = await parse('Saturday');
  assert.equal(bareSaturday.status, 'resolved');
  assert.match(bareSaturday.generationId ?? '', /^tp_[0-9a-f-]+$/);
  assert.equal(bareSaturday.canonical?.weekday, 'saturday');
  assert.equal(bareSaturday.canonical?.zonedDateTime.startsWith('2026-05-16'), true);

  const nextSaturday = await parse('next Saturday');
  assert.equal(nextSaturday.status, 'resolved');
  assert.equal(nextSaturday.canonical?.weekday, 'saturday');
  assert.equal(nextSaturday.canonical?.zonedDateTime.startsWith('2026-05-23'), true);

  const nextSaturdayAtTwentyFourHour = await parse('next Saturday at 13:37');
  assert.equal(nextSaturdayAtTwentyFourHour.status, 'resolved');
  assert.equal(nextSaturdayAtTwentyFourHour.canonical?.zonedDateTime.startsWith('2026-05-23T13:37'), true);

  const sundayAtOne = await parse('sunday at 1 am');
  assert.equal(sundayAtOne.status, 'resolved');
  assert.equal(sundayAtOne.canonical?.weekday, 'sunday');
  assert.equal(sundayAtOne.canonical?.zonedDateTime.startsWith('2026-05-17T01:00'), true);

  const ambiguousBareTime = await parse('next Saturday 1');
  assert.equal(ambiguousBareTime.status, 'needs_clarification');
  assert.equal(ambiguousBareTime.clarificationQuestion, 'Which time did you mean?');
  assert.equal(ambiguousBareTime.clarificationAlternatives?.length, 2);
  assert.equal(ambiguousBareTime.clarificationAlternatives?.[0]?.label, '1 AM');
  assert.equal(ambiguousBareTime.clarificationAlternatives?.[1]?.label, '1 PM');

  const ambiguousBareMinuteTime = await parse('day after tomorrow 11:34');
  assert.equal(ambiguousBareMinuteTime.status, 'needs_clarification');
  assert.equal(ambiguousBareMinuteTime.clarificationQuestion, 'Did you mean AM or PM?');
  assert.deepEqual(
    ambiguousBareMinuteTime.clarificationAlternatives?.map((alternative) => alternative.label),
    ['11:34 AM', '11:34 PM'],
  );

  const nextWednesday = await parse('next Wednesday');
  assert.equal(nextWednesday.status, 'resolved');
  assert.equal(nextWednesday.canonical?.weekday, 'wednesday');
  assert.equal(nextWednesday.canonical?.zonedDateTime.startsWith('2026-05-20'), true);

  const sundayAfterNext = await parse('sunday after next');
  assert.equal(sundayAfterNext.status, 'failed');
  assert.equal(sundayAfterNext.validation.warnings.includes('Input contains ambiguous weekday-after-next phrase.'), true);

  const explicitDiscord = await parse('<t:1776221807:f>');
  assert.equal(explicitDiscord.status, 'resolved');
  assert.equal(explicitDiscord.epoch, 1776221807);
  assert.equal(explicitDiscord.suggestedFormatIndex, 4);
  assert.equal(explicitDiscord.debug?.referenceRouting?.route, 'direct_instant');

  const explicitDiscordWithoutStyle = await parse('<t:0>');
  assert.equal(explicitDiscordWithoutStyle.status, 'resolved');
  assert.equal(explicitDiscordWithoutStyle.epoch, 0);
  assert.equal(explicitDiscordWithoutStyle.suggestedFormatIndex, 4);

  const shiftedDiscordSuffix = await parse('<t:1785643200:t> 1 hour later');
  assert.equal(shiftedDiscordSuffix.status, 'failed');
  assert.equal(shiftedDiscordSuffix.epoch, undefined);
  assert.equal(shiftedDiscordSuffix.debug?.referenceRouting?.route, 'model');

  const shiftedDiscordSuffixEarlier = await parse('<t:1785643200:t> 1 day earlier');
  assert.equal(shiftedDiscordSuffixEarlier.status, 'failed');
  assert.equal(shiftedDiscordSuffixEarlier.epoch, undefined);
  assert.equal(shiftedDiscordSuffixEarlier.debug?.referenceRouting?.route, 'model');

  const shiftedDiscordPrefix = await parse('1 hour after <t:1785643200:t>');
  assert.equal(shiftedDiscordPrefix.status, 'failed');
  assert.equal(shiftedDiscordPrefix.debug?.referenceRouting?.route, 'model');

  const shiftedDiscordInfix = await parse('one hour earlier than <t:1785643200:t>');
  assert.equal(shiftedDiscordInfix.status, 'failed');
  assert.equal(shiftedDiscordInfix.debug?.referenceRouting?.route, 'model');

  const promotedDateOnlyStyle = await parse('<t:1785643200:D> 1 hour later');
  assert.equal(promotedDateOnlyStyle.status, 'failed');
  assert.equal(promotedDateOnlyStyle.debug?.referenceRouting?.route, 'model');

  const modelInterpretedShift = await executeModelReferenceShift(
    '<t:1785643200:t> 1 hour later',
    '<t:1785643200:t>',
    { hours: 1 },
  );
  assert.equal(modelInterpretedShift.status, 'resolved');
  assert.equal(modelInterpretedShift.epoch, 1785646800);
  assert.equal(modelInterpretedShift.method, 'agent+plan');

  const selectableShiftClockClarification = await executeModelReferenceShiftClockClarification(
    '<t:1785643200:t> 1 day ebefore at 2',
    '<t:1785643200:t>',
  );
  assert.equal(selectableShiftClockClarification.status, 'needs_clarification');
  assert.equal(selectableShiftClockClarification.clarificationQuestion, 'Did you mean 2 AM or 2 PM?');
  assert.deepEqual(
    selectableShiftClockClarification.clarificationAlternatives?.map((alternative) => alternative.epoch),
    [1785564000, 1785607200],
  );
  assert.deepEqual(
    selectableShiftClockClarification.clarificationAlternatives?.map((alternative) => alternative.label),
    ['2 AM', '2 PM'],
  );

  const selectableCleanShiftClockClarification = await executeModelReferenceShiftClockClarification(
    '<t:1785643200:t> 1 day earlier at 2',
    '<t:1785643200:t>',
  );
  assert.deepEqual(
    selectableCleanShiftClockClarification.clarificationAlternatives?.map((alternative) => alternative.epoch),
    [1785564000, 1785607200],
  );

  const oclockPlan = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    reason: 'Fixture matching a model plan that preserves conventional o-clock wording.',
    plans: [{
      label: 'Shifted date at 3 o-clock',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', text: "3 o'clock" },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -1 }, precision: 'datetime' },
      ],
    }],
  });
  const oclockClarification = await executeTemporalPlanPlannerOutput(
    oclockPlan,
    { text: 'make <t:1785643200:t> 3 o\u2019clock on the previous day', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(oclockClarification.status, 'needs_clarification');
  assert.equal(oclockClarification.clarificationQuestion, 'Did you mean 3 AM or 3 PM?');
  assert.deepEqual(
    oclockClarification.clarificationAlternatives?.map((alternative) => alternative.epoch),
    [1785567600, 1785610800],
  );

  const selectableMinuteClockClarification = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 4:30 AM or 4:30 PM?',
    plans: [{
      label: 'Shifted date at 4:30',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785733200:F>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '4:30 AM', text: '4:30 am' },
          { label: '4:30 PM', text: '4:30 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: 1 }, precision: 'datetime' },
      ],
    }],
  });
  const selectableMinuteClockResult = await executeTemporalPlanPlannerOutput(
    selectableMinuteClockClarification,
    { text: 'at 4:30 use the day after <t:1785733200:F>', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(selectableMinuteClockResult.status, 'needs_clarification');
  assert.deepEqual(
    selectableMinuteClockResult.clarificationAlternatives?.map((alternative) => alternative.label),
    ['4:30 AM', '4:30 PM'],
  );

  const misleadingClockChoiceLabels = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Model labels disagree with their clock text',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 pm' },
          { label: '2 PM', text: '2 am' },
        ] },
        { op: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' },
      ],
    }],
  });
  const groundedClockChoiceLabels = await executeTemporalPlanPlannerOutput(
    misleadingClockChoiceLabels,
    { text: '<t:1785643200:t> at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.deepEqual(
    groundedClockChoiceLabels.clarificationAlternatives?.map((alternative) => alternative.label),
    ['2 AM', '2 PM'],
  );

  const hallucinatedClockChoiceTexts = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 3 AM or 3 PM?',
    plans: [{
      label: 'Model option texts disagree with the requested clock',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '3 AM', text: '3 am' },
          { label: '3 PM', text: '3 pm' },
        ] },
        { op: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' },
      ],
    }],
  });
  const groundedClockChoiceTexts = await executeTemporalPlanPlannerOutput(
    hallucinatedClockChoiceTexts,
    { text: '<t:1785643200:t> at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.deepEqual(
    groundedClockChoiceTexts.clarificationAlternatives?.map((alternative) => alternative.label),
    ['2 AM', '2 PM'],
  );
  assert.deepEqual(
    groundedClockChoiceTexts.clarificationAlternatives?.map((alternative) => alternative.epoch),
    [1785650400, 1785693600],
  );

  const hallucinatedTwoPlanClockChoice = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 3 AM or 3 PM?',
    plans: (['3 am', '3 pm'] as const).map((clockText) => ({
      label: `Model plan for ${clockText}`,
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', text: clockText },
        { op: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' },
      ],
    })),
  });
  const groundedTwoPlanClockChoice = await executeTemporalPlanPlannerOutput(
    hallucinatedTwoPlanClockChoice,
    { text: '<t:1785643200:t> at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(groundedTwoPlanClockChoice.status, 'failed');
  assert.equal(groundedTwoPlanClockChoice.clarificationAlternatives, undefined);
  assert.match(groundedTwoPlanClockChoice.validation.warnings.join(' '), /clock did not match/);

  const unusedDiscordReferenceBranch = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 3 AM or 3 PM?',
    plans: [{
      label: 'Unrelated final date with an unused Discord-reference branch',
      finalStep: 4,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'shift_datetime', baseStep: 0, delta: { days: 1 }, precision: 'date' },
        { op: 'resolve_calendar_query', query: 'tomorrow', precision: 'date' },
        { op: 'resolve_clock_time', text: '3 am' },
        { op: 'combine_date_time', baseStep: 2, timeStep: 3, precision: 'datetime' },
      ],
    }],
  });
  const rejectedUnusedDiscordReferenceBranch = await executeTemporalPlanPlannerOutput(
    unusedDiscordReferenceBranch,
    { text: '<t:1785643200:t> at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedUnusedDiscordReferenceBranch.status, 'failed');
  assert.equal(rejectedUnusedDiscordReferenceBranch.clarificationAlternatives, undefined);
  assert.match(
    rejectedUnusedDiscordReferenceBranch.validation.warnings.join(' '),
    /final output did not derive from an explicit Discord timestamp reference operand/,
  );

  const unusedReferenceOnIgnoredOperand = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 3 AM or 3 PM?',
    plans: [{
      label: 'Unrelated final date with reference attached to an ignored timezone operand',
      finalStep: 4,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_timezone', text: 'UTC', baseStep: 0 },
        { op: 'resolve_calendar_query', query: 'tomorrow', timeZoneStep: 1, precision: 'date' },
        { op: 'resolve_clock_time', text: '3 am' },
        { op: 'combine_date_time', baseStep: 2, timeStep: 3, timeZoneStep: 1, precision: 'datetime' },
      ],
    }],
  });
  const rejectedIgnoredOperandReference = await executeTemporalPlanPlannerOutput(
    unusedReferenceOnIgnoredOperand,
    { text: '<t:1785643200:t> at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedIgnoredOperandReference.status, 'failed');
  assert.equal(rejectedIgnoredOperandReference.clarificationAlternatives, undefined);
  assert.match(
    rejectedIgnoredOperandReference.validation.warnings.join(' '),
    /final output did not derive from an explicit Discord timestamp reference operand/,
  );

  const wrongDiscordReferenceShift = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Wrong three-day shift for a one-day request',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -3 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedWrongDiscordReferenceShift = await executeTemporalPlanPlannerOutput(
    wrongDiscordReferenceShift,
    { text: '<t:1785643200:t> 1 day earlier at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedWrongDiscordReferenceShift.status, 'failed');
  assert.equal(rejectedWrongDiscordReferenceShift.clarificationAlternatives, undefined);
  assert.match(
    rejectedWrongDiscordReferenceShift.validation.warnings.join(' '),
    /shift did not match the requested Discord-reference transformation/,
  );

  const wrongExplicitDiscordReferenceShift = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      label: 'Wrong explicit-clock shift',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', text: '2 pm' },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -3 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedWrongExplicitShift = await executeTemporalPlanPlannerOutput(
    wrongExplicitDiscordReferenceShift,
    { text: '<t:1785643200:t> 1 day earlier at 2 pm', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedWrongExplicitShift.status, 'failed');
  assert.equal(rejectedWrongExplicitShift.epoch, undefined);

  const partiallyParsedCompoundShift = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Only the final component of a compound shift',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -3 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedPartialCompoundShift = await executeTemporalPlanPlannerOutput(
    partiallyParsedCompoundShift,
    { text: '<t:1785643200:t> two weeks and three days earlier at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedPartialCompoundShift.status, 'failed');
  assert.equal(rejectedPartialCompoundShift.clarificationAlternatives, undefined);

  const ungroundedConsumedTimeZone = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Correct shift in an unrequested timezone',
      finalStep: 3,
      steps: [
        { op: 'resolve_timezone', text: 'America/Los_Angeles' },
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', timeZoneStep: 0, precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 1, timeStep: 2, timeZoneStep: 0, delta: { days: -1 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedUngroundedTimeZone = await executeTemporalPlanPlannerOutput(
    ungroundedConsumedTimeZone,
    { text: '<t:1785643200:t> 1 day earlier at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedUngroundedTimeZone.status, 'failed');
  assert.equal(rejectedUngroundedTimeZone.clarificationAlternatives, undefined);
  assert.match(rejectedUngroundedTimeZone.validation.warnings.join(' '), /timezone step.*not grounded/);

  const cancellingDiscordReferenceShifts = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Offsetting shift chain with different calendar semantics',
      finalStep: 5,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1706504400:t>', precision: 'date' },
        { op: 'shift_datetime', baseStep: 0, delta: { days: 1 }, precision: 'date' },
        { op: 'shift_datetime', baseStep: 1, delta: { months: 1 }, precision: 'date' },
        { op: 'shift_datetime', baseStep: 2, delta: { days: -1 }, precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'combine_date_time', baseStep: 3, timeStep: 4, precision: 'datetime' },
      ],
    }],
  });
  const rejectedCancellingShifts = await executeTemporalPlanPlannerOutput(
    cancellingDiscordReferenceShifts,
    { text: '<t:1706504400:t> one month later at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedCancellingShifts.status, 'failed');
  assert.equal(rejectedCancellingShifts.clarificationAlternatives, undefined);
  assert.match(rejectedCancellingShifts.validation.warnings.join(' '), /shift structure did not match/);

  const unmatchedFollowingMonthShift = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Only the first of two shift clauses',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -1 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedUnmatchedFollowingMonth = await executeTemporalPlanPlannerOutput(
    unmatchedFollowingMonthShift,
    { text: '<t:1785643200:t> one day earlier, then the following month at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedUnmatchedFollowingMonth.status, 'failed');
  assert.equal(rejectedUnmatchedFollowingMonth.clarificationAlternatives, undefined);

  const wrongRangeShiftEndpoint = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      kind: 'time_range',
      label: 'Shifted the start instead of the requested end',
      startStep: 1,
      endStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'datetime' },
        { op: 'shift_datetime', baseStep: 0, delta: { hours: 1 }, precision: 'datetime' },
        { op: 'resolve_calendar_query', query: '<t:1785650400:t>', precision: 'datetime' },
      ],
    }],
  });
  const rejectedWrongRangeEndpoint = await executeTemporalPlanPlannerOutput(
    wrongRangeShiftEndpoint,
    { text: '<t:1785643200:t> to <t:1785650400:t>, but move the end one hour later', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedWrongRangeEndpoint.status, 'failed');
  assert.equal(rejectedWrongRangeEndpoint.range, undefined);
  assert.match(rejectedWrongRangeEndpoint.validation.warnings.join(' '), /end endpoint only/);

  const swappedRangeReferences = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      kind: 'time_range',
      label: 'Swapped source references while shifting the end',
      startStep: 1,
      endStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'datetime' },
        { op: 'resolve_calendar_query', query: '<t:1785646800:t>', precision: 'datetime' },
        { op: 'shift_datetime', baseStep: 0, delta: { hours: 3 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedSwappedRangeReferences = await executeTemporalPlanPlannerOutput(
    swappedRangeReferences,
    { text: '<t:1785643200:t> to <t:1785646800:t>, move the end three hours later', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedSwappedRangeReferences.status, 'failed');
  assert.equal(rejectedSwappedRangeReferences.range, undefined);
  assert.match(rejectedSwappedRangeReferences.validation.warnings.join(' '), /endpoint order/);

  const unrequestedClockOnShift = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      label: 'Correct day shift with an unrequested clock',
      finalStep: 1,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'shift_datetime', baseStep: 0, time: { hour: 5, minute: 0 }, delta: { days: -1 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedUnrequestedClock = await executeTemporalPlanPlannerOutput(
    unrequestedClockOnShift,
    { text: '<t:1785643200:t> 1 day earlier', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedUnrequestedClock.status, 'failed');
  assert.equal(rejectedUnrequestedClock.epoch, undefined);
  assert.match(rejectedUnrequestedClock.validation.warnings.join(' '), /clock change.*not requested/);

  const compactUnrequestedClock = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      label: 'Correct day shift with compact unrequested clock',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', text: '1p' },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: -1 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedCompactUnrequestedClock = await executeTemporalPlanPlannerOutput(
    compactUnrequestedClock,
    { text: '<t:1785643200:t> 1 day earlier', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedCompactUnrequestedClock.status, 'failed');
  assert.equal(rejectedCompactUnrequestedClock.epoch, undefined);
  assert.match(rejectedCompactUnrequestedClock.validation.warnings.join(' '), /clock operand.*validated safely/);

  const wrongRangeClockEndpoint = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      kind: 'time_range',
      label: 'Moved the start clock instead of the requested end',
      startStep: 2,
      endStep: 1,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'datetime' },
        { op: 'resolve_calendar_query', query: '<t:1785650400:t>', precision: 'datetime' },
        { op: 'set_clock_time', baseStep: 0, time: { hour: 14, minute: 0 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedWrongRangeClockEndpoint = await executeTemporalPlanPlannerOutput(
    wrongRangeClockEndpoint,
    { text: '<t:1785643200:t> to <t:1785650400:t>, move the end to 2 pm', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedWrongRangeClockEndpoint.status, 'failed');
  assert.equal(rejectedWrongRangeClockEndpoint.range, undefined);
  assert.match(rejectedWrongRangeClockEndpoint.validation.warnings.join(' '), /clock.*end endpoint only/);

  const swappedAdjacentRangeClocks = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      kind: 'time_range',
      label: 'Swapped clocks adjacent to each range reference',
      startStep: 2,
      endStep: 3,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_calendar_query', query: '<t:1785650400:t>', precision: 'date' },
        { op: 'set_clock_time', baseStep: 0, time: { hour: 15, minute: 0 }, precision: 'datetime' },
        { op: 'set_clock_time', baseStep: 1, time: { hour: 14, minute: 0 }, precision: 'datetime' },
      ],
    }],
  });
  const rejectedSwappedAdjacentRangeClocks = await executeTemporalPlanPlannerOutput(
    swappedAdjacentRangeClocks,
    { text: 'from <t:1785643200:t> at 2 pm to <t:1785650400:t> at 3 pm', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(rejectedSwappedAdjacentRangeClocks.status, 'failed');
  assert.equal(rejectedSwappedAdjacentRangeClocks.range, undefined);
  assert.match(rejectedSwappedAdjacentRangeClocks.validation.warnings.join(' '), /clock ownership.*each endpoint/);

  const followingDayAfterClarification = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 5 AM or 5 PM?',
    plans: [{
      label: 'Following day with a bare clock',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '5 AM', text: '5 am' },
          { label: '5 PM', text: '5 pm' },
        ] },
        { op: 'shift_datetime', baseStep: 0, timeStep: 1, delta: { days: 1 }, precision: 'datetime' },
      ],
    }],
  });
  const acceptedFollowingDayAfter = await executeTemporalPlanPlannerOutput(
    followingDayAfterClarification,
    { text: 'at 5 use the following day after <t:1785643200:t>', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(acceptedFollowingDayAfter.status, 'needs_clarification');
  assert.equal(acceptedFollowingDayAfter.clarificationAlternatives?.length, 2);

  const forwardReferencedClarification = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Did you mean 2 AM or 2 PM?',
    plans: [{
      label: 'Forward-referenced equivalent plan',
      finalStep: 0,
      steps: [
        { op: 'shift_datetime', baseStep: 1, timeStep: 2, delta: { days: -1 }, precision: 'datetime' },
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
      ],
    }],
  });
  const forwardReferencedResult = await executeTemporalPlanPlannerOutput(
    forwardReferencedClarification,
    { text: '<t:1785643200:t> 1 day earlier at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.deepEqual(
    forwardReferencedResult.clarificationAlternatives?.map((alternative) => alternative.epoch),
    selectableCleanShiftClockClarification.clarificationAlternatives?.map((alternative) => alternative.epoch),
  );

  const invalidNonClarificationChoices = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    plans: [{
      label: 'Invalid choice usage',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 AM', text: '2 am' },
          { label: '2 PM', text: '2 pm' },
        ] },
        { op: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' },
      ],
    }],
  });
  const invalidNonClarificationResult = await executeTemporalPlanPlannerOutput(
    invalidNonClarificationChoices,
    { text: '<t:1785643200:t> at 2', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(invalidNonClarificationResult.status, 'failed');
  assert.match(invalidNonClarificationResult.ambiguity.join(' '), /require a clarification outcome/i);

  const duplicateClockChoices = parseTemporalPlanPlannerOutput({
    outcome: 'clarification',
    clarificationQuestion: 'Which clock?',
    plans: [{
      label: 'Duplicate resolved clocks',
      finalStep: 2,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'date' },
        { op: 'resolve_clock_time', options: [
          { label: '2 PM', text: '2 pm' },
          { label: 'Fourteen hundred', text: '14:00' },
        ] },
        { op: 'combine_date_time', baseStep: 0, timeStep: 1, precision: 'datetime' },
      ],
    }],
  });
  const duplicateClockChoiceResult = await executeTemporalPlanPlannerOutput(
    duplicateClockChoices,
    { text: '<t:1785643200:t> at either 2 pm or 14:00', calendarContext },
    { implementations: createDeterministicTemporalToolImplementations() },
  );
  assert.equal(duplicateClockChoiceResult.status, 'failed');
  assert.match(duplicateClockChoiceResult.ambiguity.join(' '), /distinct clocks/i);

  const unanchoredModelShiftPlan = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    reason: 'Intentionally invalid model plan that shifts relative to now instead of the explicit reference.',
    clarificationQuestion: null,
    plans: [{
      label: 'Unanchored relative shift',
      rationale: 'Smoke validation backstop.',
      assumptions: [],
      confidence: 1,
      finalStep: 0,
      steps: [
        { op: 'resolve_calendar_query', query: '1 hour later', precision: 'relative' },
      ],
    }],
  });
  const unanchoredModelShift = await executeTemporalPlanPlannerOutput(
    unanchoredModelShiftPlan,
    {
      text: '<t:1785643200:t> 1 hour later',
      calendarContext,
    },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      method: 'agent+plan',
      modelName: 'invalid-unanchored-reference-smoke',
    },
  );
  assert.equal(unanchoredModelShift.status, 'failed');
  assert.equal(unanchoredModelShift.epoch, undefined);

  const copiedTimestampProse = await parse('The event starts at <t:1785643200:t>; bring a friend and use the north entrance.');
  assert.equal(copiedTimestampProse.status, 'resolved');
  assert.equal(copiedTimestampProse.epoch, 1785643200);
  assert.equal(copiedTimestampProse.debug?.referenceRouting?.route, 'copied_prose');

  const negatedTimestamp = await parse("Don't use <t:1785643200:t>; that time is wrong.");
  assert.equal(negatedTimestamp.status, 'needs_clarification');
  assert.equal(negatedTimestamp.epoch, undefined);

  const unrelatedTimestamps = await parse('<t:1785643200:t> and <t:1785646800:t>');
  assert.equal(unrelatedTimestamps.status, 'needs_clarification');
  assert.equal(unrelatedTimestamps.epoch, undefined);

  const transformedTimestampRange = await parse('<t:1785643200:t> to <t:1785646800:t>, but move the end one hour later');
  assert.equal(transformedTimestampRange.status, 'failed');
  assert.equal(transformedTimestampRange.range, undefined);
  assert.equal(transformedTimestampRange.debug?.referenceRouting?.route, 'model');

  const ignoredRangeModifierPlan = parseTemporalPlanPlannerOutput({
    outcome: 'plans',
    reason: 'Intentionally invalid smoke candidate that ignores the range modifier.',
    clarificationQuestion: null,
    plans: [{
      kind: 'time_range',
      label: 'Ignored range modifier',
      rationale: 'Smoke validation backstop.',
      assumptions: [],
      confidence: 1,
      finalStep: null,
      startStep: 0,
      endStep: 1,
      steps: [
        { op: 'resolve_calendar_query', query: '<t:1785643200:t>', precision: 'datetime' },
        { op: 'resolve_calendar_query', query: '<t:1785646800:t>', precision: 'datetime' },
      ],
    }],
  });
  const ignoredRangeModifier = await executeTemporalPlanPlannerOutput(
    ignoredRangeModifierPlan,
    {
      text: '<t:1785643200:t> to <t:1785646800:t>, but move the end one hour later',
      calendarContext,
    },
    {
      implementations: createDeterministicTemporalToolImplementations(),
      method: 'agent+plan',
      modelName: 'invalid-range-smoke',
    },
  );
  assert.equal(ignoredRangeModifier.status, 'failed');
  assert.equal(ignoredRangeModifier.range, undefined);

  const malformedTimestamp = await parse('<t:1785643200:x>');
  assert.equal(malformedTimestamp.status, 'failed');
  assert.equal(malformedTimestamp.epoch, undefined);

  const reversedTimestampRange = await parse('<t:1785646800:t> to <t:1785643200:t>');
  assert.equal(reversedTimestampRange.status, 'needs_clarification');
  assert.equal(reversedTimestampRange.range, undefined);

  const fuzzyReferenceWithoutModel = await parse('<t:1785643200:t> roughly an hour later');
  assert.equal(fuzzyReferenceWithoutModel.status, 'failed');
  assert.equal(fuzzyReferenceWithoutModel.epoch, undefined);
  assert.equal(fuzzyReferenceWithoutModel.debug?.referenceRouting?.route, 'model');

  const unavailableReferenceModel = await parseTemporalExpression({
    text: '<t:1785643200:t> roughly an hour later',
    timeZone,
    referenceInstant,
    features: { planIr: true, discordReferenceRouting: true },
    planIrEndpoint: {
      baseUrl: 'http://127.0.0.1:1',
      model: 'unavailable-test-model',
      instructionPreset: 'minimal',
      api: 'completions',
      promptFormat: 'custom',
      maxTokens: 64,
      timeoutMs: 100,
    },
  });
  assert.equal(unavailableReferenceModel.status, 'failed');
  assert.equal(unavailableReferenceModel.epoch, undefined);
  assert.equal(unavailableReferenceModel.debug?.referenceRouting?.route, 'model');

  const fallBackBase = Temporal.ZonedDateTime.from('2026-11-01T01:30:00-04:00[America/New_York]');
  const fallBackEpoch = Math.floor(Number(fallBackBase.epochMilliseconds) / 1000);
  const fallBackHourShift = await executeModelReferenceShift(
    `<t:${fallBackEpoch}:t> 1 hour later`,
    `<t:${fallBackEpoch}:t>`,
    { hours: 1 },
  );
  assert.equal(fallBackHourShift.epoch, fallBackEpoch + 3600);
  assert.match(fallBackHourShift.canonical?.zonedDateTime ?? '', /2026-11-01T01:30:00-05:00/);

  const fallBackDayShift = await executeModelReferenceShift(
    `<t:${fallBackEpoch}:t> 1 day later`,
    `<t:${fallBackEpoch}:t>`,
    { days: 1 },
  );
  assert.equal(
    fallBackDayShift.epoch,
    Math.floor(Number(fallBackBase.add({ days: 1 }).epochMilliseconds) / 1000),
  );
  assert.match(fallBackDayShift.canonical?.zonedDateTime ?? '', /2026-11-02T01:30:00-05:00/);

  const springForwardBase = Temporal.ZonedDateTime.from('2026-03-08T01:30:00-05:00[America/New_York]');
  const springForwardEpoch = Math.floor(Number(springForwardBase.epochMilliseconds) / 1000);
  const springForwardHourShift = await executeModelReferenceShift(
    `<t:${springForwardEpoch}:t> 1 hour later`,
    `<t:${springForwardEpoch}:t>`,
    { hours: 1 },
  );
  assert.equal(springForwardHourShift.epoch, springForwardEpoch + 3600);
  assert.match(springForwardHourShift.canonical?.zonedDateTime ?? '', /2026-03-08T03:30:00-04:00/);

  const springForwardDayShift = await executeModelReferenceShift(
    `<t:${springForwardEpoch}:t> 1 day later`,
    `<t:${springForwardEpoch}:t>`,
    { days: 1 },
  );
  assert.equal(
    springForwardDayShift.epoch,
    Math.floor(Number(springForwardBase.add({ days: 1 }).epochMilliseconds) / 1000),
  );
  assert.match(springForwardDayShift.canonical?.zonedDateTime ?? '', /2026-03-09T01:30:00-04:00/);

  const monthEndBase = Temporal.ZonedDateTime.from('2027-01-31T12:00:00-05:00[America/New_York]');
  const monthEndEpoch = Math.floor(Number(monthEndBase.epochMilliseconds) / 1000);
  const monthEndShift = await executeModelReferenceShift(
    `<t:${monthEndEpoch}:f> 1 month later`,
    `<t:${monthEndEpoch}:f>`,
    { months: 1 },
  );
  assert.equal(
    monthEndShift.epoch,
    Math.floor(Number(monthEndBase.add({ months: 1 }).epochMilliseconds) / 1000),
  );
  assert.match(monthEndShift.canonical?.zonedDateTime ?? '', /2027-02-28T12:00:00-05:00/);

  const explicitIsoInstant = await parse('2026-05-17T10:00:00Z');
  assert.equal(explicitIsoInstant.status, 'resolved');
  assert.equal(explicitIsoInstant.canonical?.isoInstant, '2026-05-17T10:00:00Z');

  const tomorrowAtFive = await parse('tomorrow at 5pm');
  assert.equal(tomorrowAtFive.status, 'resolved');
  assert.equal(tomorrowAtFive.canonical?.zonedDateTime.startsWith('2026-05-16T17:00'), true);

  const tuesdayCompactPm = await parse('tuesday 5p');
  assert.equal(tuesdayCompactPm.status, 'resolved');
  assert.equal(tuesdayCompactPm.suggestedFormatIndex, 5);
  assert.equal(tuesdayCompactPm.canonical?.zonedDateTime.startsWith('2026-05-19T17:00'), true);

  const weekdayDateTimeFormat = await parse('4:30 Tuesday');
  assert.equal(weekdayDateTimeFormat.status, 'needs_clarification');
  assert.deepEqual(
    weekdayDateTimeFormat.clarificationAlternatives?.map((alternative) => alternative.label),
    ['4:30 AM', '4:30 PM'],
  );

  const eventWithMultipleTimes = await parseTemporalExpression({
    text: 'Club night: Friday May 29, doors 8pm, main set 10:30pm',
    timeZone,
    referenceInstant: '2026-05-24T12:00:00Z',
  });
  assert.equal(eventWithMultipleTimes.status, 'needs_clarification');
  assert.deepEqual(
    [...(eventWithMultipleTimes.clarificationAlternatives ?? [])].map((alternative) => alternative.epoch).sort((a, b) => a - b),
    [1780099200, 1780108200],
  );

  const relativeFormat = await parse('in 3 days');
  assert.equal(relativeFormat.status, 'resolved');
  assert.equal(relativeFormat.suggestedFormatIndex, 6);

  const relativeFromNowFormat = await parse('60 days from now');
  assert.equal(relativeFromNowFormat.status, 'resolved');
  assert.equal(relativeFromNowFormat.suggestedFormatIndex, 6);

  const bareTwentyFourHour = await parse('19');
  assert.equal(bareTwentyFourHour.status, 'resolved');
  assert.equal(bareTwentyFourHour.epoch, 1778886000);

  const negativeEpoch = await parse('-1');
  assert.equal(negativeEpoch.status, 'failed');

  const bareTwentyFourHourRollover = await parseTemporalExpression({
    text: '19',
    timeZone,
    referenceInstant: '2026-05-16T01:00:00Z',
  });
  assert.equal(bareTwentyFourHourRollover.status, 'resolved');
  assert.equal(bareTwentyFourHourRollover.epoch, 1778972400);

  const firstSundayNextMonth = await parse('first sunday of next month at 1pm');
  assert.equal(firstSundayNextMonth.status, 'resolved');
  assert.equal(firstSundayNextMonth.method, 'deterministic');
  assert.equal(firstSundayNextMonth.canonical?.zonedDateTime.startsWith('2026-06-07T13:00'), true);

  const dayAfterFirstSunday = await parse('the day after the first sunday of next month at one hour past noon and 10 minutes');
  assert.equal(dayAfterFirstSunday.status, 'resolved');
  assert.equal(dayAfterFirstSunday.method, 'deterministic');
  assert.equal(dayAfterFirstSunday.canonical?.zonedDateTime.startsWith('2026-06-08T13:10'), true);

  const dateOnlyNoon = await parseTemporalExpression({
    text: 'tomorrow',
    timeZone,
    referenceInstant: '2026-05-15T16:34:56Z',
  });
  assert.equal(dateOnlyNoon.status, 'resolved');
  assert.equal(dateOnlyNoon.canonical?.zonedDateTime.startsWith('2026-05-16T12:00:00'), true);

  const explicitDatedRange = await parseTemporalExpression({
    text: 'June 10 2026 3pm-5pm America/Los_Angeles',
    timeZone,
    referenceInstant: '2026-06-08T06:50:00Z',
  });
  assert.equal(explicitDatedRange.status, 'resolved');
  assert.equal(explicitDatedRange.kind, 'time_range');
  assert.equal(explicitDatedRange.method, 'deterministic');
  assert.equal(explicitDatedRange.range?.start.epoch, 1781128800);
  assert.equal(explicitDatedRange.range?.end.epoch, 1781136000);

  const explicitDatedRangeWithConfiguredOpenAi = await parseTemporalExpression({
    text: 'June 10 2026 3pm-5pm America/Los_Angeles',
    timeZone,
    referenceInstant: '2026-06-08T06:50:00Z',
    openaiApiKey: 'sk-test',
    features: { deterministicPreflight: true },
  });
  assert.equal(explicitDatedRangeWithConfiguredOpenAi.status, 'resolved');
  assert.equal(explicitDatedRangeWithConfiguredOpenAi.kind, 'time_range');
  assert.equal(explicitDatedRangeWithConfiguredOpenAi.method, 'deterministic');
  assert.equal(explicitDatedRangeWithConfiguredOpenAi.debug?.finalValidation, undefined);

  const explicitDiscordTimestampRange = await parseTemporalExpression({
    text: '<t:1781038800:f> - <t:1781046000:t>',
    timeZone,
    referenceInstant,
  });
  assert.equal(explicitDiscordTimestampRange.status, 'resolved');
  assert.equal(explicitDiscordTimestampRange.kind, 'time_range');
  assert.equal(explicitDiscordTimestampRange.method, 'deterministic');
  assert.equal(explicitDiscordTimestampRange.range?.start.epoch, 1781038800);
  assert.equal(explicitDiscordTimestampRange.range?.start.suggestedFormatIndex, 4);
  assert.equal(explicitDiscordTimestampRange.range?.end.epoch, 1781046000);
  assert.equal(explicitDiscordTimestampRange.range?.end.suggestedFormatIndex, 2);
  assert.equal(explicitDiscordTimestampRange.range?.discord, '<t:1781038800:f> - <t:1781046000:t>');

  const bareTimeRange = await parseTemporalExpression({
    text: '5pm-7pm',
    timeZone,
    referenceInstant,
  });
  assert.equal(bareTimeRange.status, 'resolved');
  assert.equal(bareTimeRange.kind, 'time_range');
  assert.equal(bareTimeRange.method, 'deterministic');
  assert.equal(bareTimeRange.range?.start.canonical.zonedDateTime.startsWith('2026-05-15T17:00'), true);
  assert.equal(bareTimeRange.range?.end.canonical.zonedDateTime.startsWith('2026-05-15T19:00'), true);

  const bareTimeRangeWithConfiguredOpenAi = await parseTemporalExpression({
    text: '5pm-7pm',
    timeZone,
    referenceInstant,
    openaiApiKey: 'sk-test',
    features: { deterministicPreflight: true },
  });
  assert.equal(bareTimeRangeWithConfiguredOpenAi.status, 'resolved');
  assert.equal(bareTimeRangeWithConfiguredOpenAi.kind, 'time_range');
  assert.equal(bareTimeRangeWithConfiguredOpenAi.method, 'deterministic');
  assert.equal(bareTimeRangeWithConfiguredOpenAi.debug?.finalValidation, undefined);

  const deterministicEaster = await parse('easter');
  assert.equal(deterministicEaster.status, 'failed');
  assert.match(deterministicEaster.generationId ?? '', /^tp_[0-9a-f-]+$/);

  const tools = createDeterministicTemporalToolImplementations();
  const bareAnchor = await tools.resolveCalendarQuery({ query: '<t:1785643200:t>', calendarContext });
  const ignoredResidueValidation = await tools.validateCandidate({
    originalText: 'Use <t:1785643200:t> adjusted for the launch delay',
    candidate: bareAnchor.candidates[0]!,
    calendarContext,
  });
  assert.equal(ignoredResidueValidation.passed, false);
  assert.equal(
    ignoredResidueValidation.errors.some((error) => error.includes('bare Discord timestamp anchor')),
    true,
  );
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

  const easterIndianapolis = await tools.resolveHoliday({
    holidayName: 'easter',
    year: 2056,
    calendarContext: { ...calendarContext, timeZone: 'America/Indianapolis' },
  });
  assert.equal(easterIndianapolis.candidates[0]?.zonedDateTime.startsWith('2056-04-02T12:00'), true);

  const noUsFallbackHoliday = await tools.resolveHoliday({
    holidayName: 'thanksgiving',
    calendarContext: { ...calendarContext, timeZone: 'Europe/Paris' },
  });
  assert.equal(noUsFallbackHoliday.candidates.length, 0);

  const parsedCompound = await parse('day after a week from tomorrow at 133t time');
  assert.equal(parsedCompound.status, 'failed');

  const parsedCompoundTool = await tools.parseExpression({ text: 'day after a week from tomorrow at 133t time', calendarContext });
  assert.equal(parsedCompoundTool.candidates.length, 0);

  const clock = await tools.resolveClockTime({ text: '13:37', calendarContext });
  assert.equal(clock.candidates[0]?.hour, 13);
  assert.equal(clock.candidates[0]?.minute, 37);

  const meridiemClock = await tools.resolveClockTime({ text: '4:30 pm', calendarContext });
  assert.deepEqual(
    meridiemClock.candidates.map(({ hour, minute }) => ({ hour, minute })),
    [{ hour: 16, minute: 30 }],
  );

  const compactClock = await tools.resolveClockTime({ text: '5p', calendarContext });
  assert.equal(compactClock.candidates[0]?.hour, 17);
  assert.equal(compactClock.candidates[0]?.minute, 0);

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
