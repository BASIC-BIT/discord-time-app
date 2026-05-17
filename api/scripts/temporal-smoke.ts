import assert from 'node:assert/strict';
import { parseTemporalExpression } from '../src/temporal';

const referenceInstant = '2026-05-15T16:00:00Z'; // Friday noon in America/New_York.
const timeZone = 'America/New_York';

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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
