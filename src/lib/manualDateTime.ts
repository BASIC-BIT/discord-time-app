import { Temporal } from '@js-temporal/polyfill';
import { DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS } from '@hammer-overlay/discord-timestamp-routing';

export type ManualDraft = { date: string; time: string; timeZone: string; offset: string | null };
export type InstantChoice = { epochSeconds: number; offset: string };
export type DraftResolution =
  | { kind: 'valid'; choice: InstantChoice }
  | { kind: 'ambiguous'; choices: readonly [InstantChoice, InstantChoice] }
  | { kind: 'invalid'; message: string };

function isSupportedEpoch(epochSeconds: number): boolean {
  return Number.isInteger(epochSeconds) && epochSeconds >= 0 && epochSeconds <= DISCORD_TIMESTAMP_MAX_EPOCH_SECONDS;
}

export function seedManualDraft(input: { epochSeconds: number | null; now: Date; timeZone: string }): ManualDraft {
  const { epochSeconds, now, timeZone } = input;
  if (epochSeconds !== null && !isSupportedEpoch(epochSeconds)) {
    throw new RangeError('Timestamp is outside the supported range.');
  }
  const milliseconds = epochSeconds === null ? now.getTime() : epochSeconds * 1000;
  const zoned = Temporal.Instant.fromEpochMilliseconds(milliseconds).toZonedDateTimeISO(timeZone);
  // Round calendar fields, since historical timezone offsets can include seconds.
  const local = epochSeconds === null
    ? zoned.toPlainDateTime().with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
    : zoned.toPlainDateTime();
  return {
    // HTML dates use unsigned years with at least four digits, including 10000
    // when an allowed UTC boundary instant falls in the next local year.
    date: `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
    time: local.toPlainTime().toString({ smallestUnit: 'second' }),
    timeZone,
    offset: epochSeconds === null ? null : zoned.offset,
  };
}

export function resolveManualDraft(draft: ManualDraft): DraftResolution {
  if (!/^\d{4,6}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(draft.time)) {
    return { kind: 'invalid', message: 'Enter a complete date and time.' };
  }
  try {
    const [year, month, day] = draft.date.split('-').map(Number);
    const [hour, minute, second = 0] = draft.time.split(':').map(Number);
    const local = Temporal.PlainDateTime.from({ year, month, day, hour, minute, second }, { overflow: 'reject' });
    const earlier = local.toZonedDateTime(draft.timeZone, { disambiguation: 'earlier' });
    const later = local.toZonedDateTime(draft.timeZone, { disambiguation: 'later' });
    if (!earlier.toPlainDateTime().equals(local) || !later.toPlainDateTime().equals(local)) {
      return { kind: 'invalid', message: 'This local time does not exist because the clocks move forward.' };
    }
    const first: InstantChoice = { epochSeconds: earlier.epochMilliseconds / 1000, offset: earlier.offset };
    const last: InstantChoice = { epochSeconds: later.epochMilliseconds / 1000, offset: later.offset };
    if (!isSupportedEpoch(first.epochSeconds) || !isSupportedEpoch(last.epochSeconds)) {
      return { kind: 'invalid', message: 'Timestamp is outside the supported range.' };
    }
    if (draft.offset !== null) {
      const choice = first.offset === draft.offset ? first : last.offset === draft.offset ? last : null;
      return choice === null
        ? { kind: 'invalid', message: 'Choose a UTC offset that matches this date and time.' }
        : { kind: 'valid', choice };
    }
    return first.epochSeconds === last.epochSeconds
      ? { kind: 'valid', choice: first }
      : { kind: 'ambiguous', choices: [first, last] };
  } catch {
    return { kind: 'invalid', message: 'Enter a valid calendar date, time, and timezone.' };
  }
}
