const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISCORD_TIMESTAMP_CLASSIFIER_VERSION,
  DISCORD_TIMESTAMP_MAX_INPUT_CHARS,
  parseDiscordTimestampAmount,
  classifyDiscordTimestampInput,
} = require('./index.js');

const classify = (text) => classifyDiscordTimestampInput(text);

test('shares the full routed duration amount vocabulary', () => {
  assert.equal(parseDiscordTimestampAmount('four'), 4);
  assert.equal(parseDiscordTimestampAmount('twenty-one'), 21);
  assert.equal(parseDiscordTimestampAmount('ninety nine'), 99);
  assert.equal(parseDiscordTimestampAmount('999'), 999);
  assert.equal(parseDiscordTimestampAmount('thousand'), null);
});

test('classifies standalone and harmlessly wrapped timestamps', () => {
  const standalone = classify('<t:1785643200:t>');
  assert.equal(standalone.version, DISCORD_TIMESTAMP_CLASSIFIER_VERSION);
  assert.equal(standalone.route, 'direct_instant');
  assert.equal(standalone.reason, 'standalone_timestamp');
  assert.equal(standalone.references[0].epochSeconds, 1785643200);
  assert.equal(standalone.references[0].formatIndex, 2);

  assert.equal(classify('<t:0>').route, 'direct_instant');
  assert.equal(classify('`<t:1785643200:t>`').reason, 'standalone_wrapped_timestamp');
  assert.equal(classify('“<t:1785643200:F>”').reason, 'standalone_wrapped_timestamp');
  assert.equal(classify('<t:000000000001:R>').references[0].epochSeconds, 1);
  for (const style of ['d', 'D', 't', 'T', 'f', 'F', 'R']) {
    assert.equal(classify(`<t:1785643200:${style}>`).route, 'direct_instant');
  }
});

test('classifies exact ranges only when the whole input is consumed', () => {
  assert.equal(classify('<t:1785643200:t> - <t:1785646800:F>').route, 'direct_range');
  assert.equal(classify('<t:1785643200:t> to <t:1785646800:F>').route, 'direct_range');
  const transformedRange = classify('<t:1785643200:t> to <t:1785646800:F>, but move the end one hour later');
  assert.equal(transformedRange.route, 'model');
  assert.equal(transformedRange.reason, 'semantic_residue_requires_model');
  assert.equal(classify('<t:1785646800:t> to <t:1785643200:t>').reason, 'invalid_timestamp_range');
  assert.equal(classify('<t:1785643200:t> to <t:1785643200:t>').reason, 'invalid_timestamp_range');
  const shiftedStart = classify('<t:1785643200:D> to <t:1785733200:F>, move the start 1 hour later');
  assert.equal(shiftedStart.route, 'model');
  assert.equal(shiftedStart.reason, 'semantic_residue_requires_model');
});

test('routes temporal transformation language to model interpretation', () => {
  for (const input of [
    '<t:1785643200:t> 1 hour later',
    '1 hour after <t:1785643200:t>',
    'one hour earlier than <t:1785643200:t>',
    '<t:1785643200:t> - 30 minutes',
    '2 days before <t:1785643200:D>',
    '<t:1785643200:D> 1 hour later',
    '<t:1785643200:R> 1 hour later',
    'change the time of <t:1785643200:t> to 3 pm',
    'change the time of <t:1785643200:t> to 3 pm please',
    'change the time of <t:1785643200:t> to 3 pm, thanks!',
    'change the time of <t:1785643200:t> to 5p',
    'change the time of <t:1785643200:t> at 5 pm',
    'change <t:1785643200:t> to 5 pm',
    'set <t:1785643200:t> to 5 pm UTC',
    'change <t:1785643200:t> to 5 pm UTC',
    'starts at <t:1785643200:t> and ends at 5 pm UTC',
    'set <t:1785643200:t> to 5 pm UTC+02:00',
    'change the time of <t:1785643200:t> to 5.30p',
    'change the time of <t:1785643200:t> to 15.00',
    'change time of <t:1785643200:t> to 15:00',
    'move <t:1785643200:t> to 6:30pm without changing the day',
  ]) {
    const result = classify(input);
    assert.equal(result.route, 'model');
    assert.equal(result.reason, 'semantic_residue_requires_model');
  }
  const fuzzyShift = classify('<t:1785643200:D> about one hour later');
  assert.equal(fuzzyShift.route, 'model');
  assert.equal(fuzzyShift.signals.includes('subday_duration'), true);
  const invalidClockChange = classify('change the time of <t:1785643200:t> to 99 pm');
  assert.equal(invalidClockChange.route, 'clarify');
  assert.equal(invalidClockChange.reason, 'negated_or_corrected_reference');
  const invalidMinuteChange = classify('change the time of <t:1785643200:t> to 12:99');
  assert.equal(invalidMinuteChange.route, 'clarify');
  assert.equal(invalidMinuteChange.reason, 'negated_or_corrected_reference');
  const alternativeClockChange = classify('change the time of <t:1785643200:t> to 3 or 4 pm');
  assert.equal(alternativeClockChange.route, 'clarify');
  assert.equal(alternativeClockChange.reason, 'negated_or_corrected_reference');
  const punctuatedAlternativeClockChange = classify('change the time of <t:1785643200:t> to 3, or 4 pm');
  assert.equal(punctuatedAlternativeClockChange.route, 'clarify');
  assert.equal(punctuatedAlternativeClockChange.reason, 'negated_or_corrected_reference');
});

test('preserves a narrow affirmative copied-prose route and rejects semantic hazards', () => {
  assert.equal(
    classify('The event starts at <t:1785643200:t>; bring a friend and use the north entrance.').route,
    'copied_prose',
  );
  assert.equal(
    classify("Don't use <t:1785643200:t>; the organizer posted the wrong time.").reason,
    'negated_or_corrected_reference',
  );
  assert.equal(
    classify('Maybe the event starts at <t:1785643200:t>?').reason,
    'conditional_or_uncertain_reference',
  );
  assert.equal(
    classify('"The event starts at <t:1785643200:t>; bring a friend."').reason,
    'ambiguous_code_or_url_context',
  );
});

test('fails closed for unsupported relationships and ambiguous contexts', () => {
  assert.equal(
    classify('Compare <t:1785643200:t> with <t:1785646800:t>').reason,
    'unsupported_comparison',
  );
  assert.equal(
    classify('<t:1785643200:t> and <t:1785646800:t>').reason,
    'multiple_timestamps_without_relationship',
  );
  assert.equal(classify('Show <t:1785643200:t> in Pacific time').reason, 'unsupported_timezone_presentation');
  assert.equal(classify('set <t:1785643200:t> to 5 pm UTC+02:99').reason, 'unsupported_timezone_presentation');
  assert.equal(classify('set <t:1785643200:t> to 5 pm UTC+99:99').reason, 'unsupported_timezone_presentation');
  assert.equal(
    classify('starts at <t:1785643200:t> and ends at 5 pm; add the literal label UTC').reason,
    'unsupported_timezone_presentation',
  );
  assert.equal(classify('Schedule <t:1785643200:t> on my calendar').reason, 'unsupported_scheduling');
  assert.equal(classify('`note <t:1785643200:t>`').reason, 'ambiguous_code_or_url_context');
  assert.equal(classify('```\nnote <t:1785643200:t>\n```').reason, 'ambiguous_code_or_url_context');
  assert.equal(classify('https://example.com/<t:1785643200:t>').contextClass, 'url');
  assert.equal(classify('https://example.com/%3Ct%3A1785643200%3At%3E').reason, 'malformed_timestamp_syntax');
});

test('rejects malformed, overflow, unicode-lookalike, and over-limit input', () => {
  assert.equal(classify('<t:1785643200:x>').reason, 'malformed_timestamp_syntax');
  assert.equal(classify('<t:999999999999:F>').reason, 'malformed_timestamp_syntax');
  assert.equal(classify('＜t：1785643200：t＞').reason, 'malformed_timestamp_syntax');
  assert.equal(classify('<t:1785643200').reason, 'malformed_timestamp_syntax');
  assert.equal(classify(`${'x'.repeat(DISCORD_TIMESTAMP_MAX_INPUT_CHARS + 1)}<t:1:t>`).reason, 'input_too_long');
  assert.equal(classify(`${'x'.repeat(5000)} <t:1785643200:t> adjust somehow`).reason, 'model_input_too_long');
  const repeated = Array.from({ length: 100 }, (_, index) => `<t:${index + 1}:t>`).join(' ');
  assert.equal(classify(repeated).reason, 'multiple_timestamps_without_relationship');
});
