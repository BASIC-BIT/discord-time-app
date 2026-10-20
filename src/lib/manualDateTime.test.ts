/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS } from '@hammer-overlay/discord-timestamp-routing';
import { resolveManualDraft, seedManualDraft } from './manualDateTime.ts';
import type { ManualDraft } from './manualDateTime.ts';

const utc: ManualDraft = { date: '2026-06-10', time: '14:30:00', timeZone: 'UTC', offset: null };
const fold: ManualDraft = { date: '2026-11-01', time: '01:30:00', timeZone: 'America/New_York', offset: null };
const now = new Date('2026-06-10T14:30:45.987Z');

test('resolves an exact UTC instant including seconds', () => {
  assert.deepEqual(resolveManualDraft({date: '2026-06-10', time: '14:30:45', timeZone: 'UTC', offset: null}),
    {kind: 'valid', choice: {epochSeconds: 1781101845, offset: '+00:00'}});
  assert.deepEqual(resolveManualDraft(utc), { kind: 'valid', choice: { epochSeconds: 1781101800, offset: '+00:00' } });
  assert.deepEqual(resolveManualDraft({ ...utc, time: '14:30' }), resolveManualDraft(utc));
});

test('new drafts freeze the supplied clock at its local minute', () => {
  assert.deepEqual(seedManualDraft({ epochSeconds: null, now, timeZone: 'America/New_York' }),
    { date: '2026-06-10', time: '10:30:00', timeZone: 'America/New_York', offset: null });
  assert.equal(now.toISOString(), '2026-06-10T14:30:45.987Z');
});

test('new repeated-hour drafts still require an explicit offset choice', () => {
  const draft = seedManualDraft({ epochSeconds: null, now: new Date('2026-11-01T05:30:45Z'), timeZone: 'America/New_York' });
  assert.equal(draft.offset, null);
  assert.equal(resolveManualDraft(draft).kind, 'ambiguous');
});

test('new drafts floor the local minute even with historical offset seconds', () => {
  const draft = seedManualDraft({ epochSeconds: null, now: new Date('1971-06-10T14:30:45Z'), timeZone: 'Africa/Monrovia' });
  assert.equal(draft.time, '13:46:00');
  assert.deepEqual(resolveManualDraft(draft), { kind: 'valid', choice: { epochSeconds: 45412230, offset: '-00:44:30' } });
});

test('existing drafts preserve seconds independently of the supplied clock', () => {
  assert.deepEqual(seedManualDraft({ epochSeconds: 1781101845, now, timeZone: 'UTC' }),
    { ...utc, time: '14:30:45', offset: '+00:00' });
});

test('rejects a daylight-saving gap', () => {
  assert.equal(resolveManualDraft({ ...fold, date: '2026-03-08', time: '02:30:00' }).kind, 'invalid');
  assert.equal(resolveManualDraft({ ...fold, date: '2026-03-08', time: '02:30:00', offset: '-05:00' }).kind, 'invalid');
});

test('requires an offset for a repeated hour', () => {
  assert.deepEqual(resolveManualDraft(fold), { kind: 'ambiguous', choices: [
    { epochSeconds: 1793511000, offset: '-04:00' },
    { epochSeconds: 1793514600, offset: '-05:00' },
  ] });
  for (const [offset, epochSeconds] of [['-04:00', 1793511000], ['-05:00', 1793514600]] as const) {
    assert.deepEqual(resolveManualDraft({ ...fold, offset }), { kind: 'valid', choice: { epochSeconds, offset } });
  }
  assert.equal(resolveManualDraft({ ...fold, offset: '-06:00' }).kind, 'invalid');
});

test('preserves either existing repeated-hour instant', () => {
  for (const epochSeconds of [1793511000, 1793514600]) {
    const draft = seedManualDraft({ epochSeconds, now, timeZone: 'America/New_York' });
    assert.equal(draft.date, fold.date);
    assert.equal(draft.time, fold.time);
    assert.deepEqual(resolveManualDraft(draft), { kind: 'valid', choice: { epochSeconds, offset: draft.offset } });
  }
});

test('accepts epoch zero and the shared maximum', () => {
  assert.equal(DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS, 253402300799);
  for (const epochSeconds of [0, DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS]) {
    const draft = seedManualDraft({ epochSeconds, now, timeZone: 'UTC' });
    assert.deepEqual(resolveManualDraft(draft), { kind: 'valid', choice: { epochSeconds, offset: '+00:00' } });
  }
});

test('rejects incomplete or normalized invalid dates', () => {
  for (const date of ['', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-06-00', '2026-6-10']) {
    assert.equal(resolveManualDraft({ ...utc, date }).kind, 'invalid', date);
  }
  for (const time of ['', '14', '14:', '24:00:00', '14:60:00', '14:30:60', '14:30:00.5']) {
    assert.equal(resolveManualDraft({ ...utc, time }).kind, 'invalid', time);
  }
  assert.equal(resolveManualDraft({ ...utc, timeZone: 'Not/A_Zone' }).kind, 'invalid');
  assert.equal(resolveManualDraft({ ...utc, offset: '-04:00' }).kind, 'invalid');
});

test('rejects epochs outside the shared bounds', () => {
  for (const epochSeconds of [-1, DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS + 1, 0.5, NaN, Infinity]) {
    assert.throws(() => seedManualDraft({ epochSeconds, now, timeZone: 'UTC' }), RangeError);
  }
  for (const date of ['1969-12-31', '10000-01-01']) {
    assert.equal(resolveManualDraft({ ...utc, date }).kind, 'invalid');
  }
  assert.equal(resolveManualDraft({ ...utc, date: '1970-01-01', time: '00:00:00', timeZone: 'Asia/Tokyo' }).kind, 'invalid');
  assert.equal(resolveManualDraft({ ...utc, date: '9999-12-31', time: '23:59:59', timeZone: 'America/New_York' }).kind, 'invalid');
  assert.throws(() => seedManualDraft({ epochSeconds: null, now: new Date(NaN), timeZone: 'UTC' }), RangeError);
});

test('round-trips boundary instants whose local date crosses the UTC year boundary', () => {
  for (const [epochSeconds, timeZone] of [[0, 'America/New_York'], [DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS, 'Asia/Tokyo']] as const) {
    const draft = seedManualDraft({ epochSeconds, now, timeZone });
    assert.deepEqual(resolveManualDraft(draft), { kind: 'valid', choice: { epochSeconds, offset: draft.offset } });
    if (timeZone === 'Asia/Tokyo') assert.equal(draft.date, '10000-01-01');
  }
});
