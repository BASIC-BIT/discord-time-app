import 'dotenv/config';
import assert from 'node:assert/strict';
import { parseTemporalExpression } from '../src/temporal';
import type { ParseAlternative, ParseResponse } from '../src/types';
import type { TemporalFeatureFlags } from '../src/temporal/types';

type LiveSuccess = ParseResponse & { ok: true };
type LiveFailure = {
  ok: false;
  status: number;
  error: string;
  message?: string;
  alternatives?: ParseAlternative[];
};
type LiveResult = LiveSuccess | LiveFailure;

const referenceInstant = process.env['TEMPORAL_LIVE_SMOKE_NOW'] ?? '2026-05-24T12:00:00Z';
const timeZone = process.env['TEMPORAL_LIVE_SMOKE_TZ'] ?? 'America/New_York';
const apiBaseUrl = stripTrailingSlash(process.env['TEMPORAL_LIVE_API_URL']);
const apiKey = process.env['TEMPORAL_LIVE_API_KEY'] ?? process.env['STATIC_API_KEY'] ?? 'STATIC_KEY_123';
const openaiApiKey = nonBlank(process.env['OPENAI_API_KEY']);
const requireLive = isTruthy(process.env['TEMPORAL_LIVE_SMOKE_REQUIRE_OPENAI']);

async function main() {
  if (apiBaseUrl === undefined && openaiApiKey === undefined) {
    if (requireLive) {
      throw new Error('OPENAI_API_KEY or TEMPORAL_LIVE_API_URL is required for live temporal smoke tests.');
    }
    console.log('Skipping live temporal smoke tests because OPENAI_API_KEY and TEMPORAL_LIVE_API_URL are not configured.');
    return;
  }

  console.log(`Running live temporal smoke tests via ${apiBaseUrl === undefined ? 'direct parser' : 'HTTP API'} with reference ${referenceInstant}.`);

  await expectResolved('day after next saturday', 1780243200, 6);
  await expectResolved('day after next saturday at 13:37', 1780249020, 5);
  await expectResolved('day after next saturday at l33t time', 1780249020, 5);
  await expectResolved('next saturday at l33t time', 1780162620, 5);
  await expectResolved('easter 2028', 1839513600, 1);
  await expectClarification('saturday at 3', [1780124400, 1780167600]);

  console.log('Live temporal smoke tests passed.');
}

async function expectResolved(text: string, epoch: number, suggestedFormatIndex: number) {
  const result = await parseLive(text);
  assert.equal(result.ok, true, `${text} should resolve`);
  if (!result.ok) {
    return;
  }
  assert.equal(result.epoch, epoch, `${text} epoch`);
  assert.equal(result.suggestedFormatIndex, suggestedFormatIndex, `${text} suggested format`);
  assert.match(result.method, /agent|tool/i, `${text} should use the live agent/tool path`);
}

async function expectClarification(text: string, epochs: number[]) {
  const result = await parseLive(text);
  assert.equal(result.ok, false, `${text} should need clarification`);
  if (result.ok) {
    return;
  }
  assert.equal(result.error, 'needs_clarification');
  assert.deepEqual(
    [...(result.alternatives ?? [])].map((alternative) => alternative.epoch).sort((a, b) => a - b),
    epochs,
  );
}

async function parseLive(text: string): Promise<LiveResult> {
  if (apiBaseUrl !== undefined) {
    return parseViaApi(text);
  }

  if (openaiApiKey === undefined) {
    throw new Error('OPENAI_API_KEY is required for direct live parser tests.');
  }

  const features = temporalFeaturesFromEnv();
  const parsed = await parseTemporalExpression({
    text,
    timeZone,
    referenceInstant,
    openaiApiKey,
    openaiModel: process.env['OPENAI_MODEL'] ?? 'gpt-5.5',
    openaiReasoningEffort: process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
    ...(features === undefined ? {} : { features }),
    langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
  });

  if (parsed.status === 'resolved' && parsed.epoch !== undefined && parsed.suggestedFormatIndex !== undefined) {
    return {
      ok: true,
      epoch: parsed.epoch,
      suggestedFormatIndex: parsed.suggestedFormatIndex,
      confidence: parsed.confidence,
      method: parsed.method,
    };
  }

  return {
    ok: false,
    status: parsed.status === 'needs_clarification' ? 400 : 500,
    error: parsed.status === 'needs_clarification' ? 'needs_clarification' : 'parse_failed',
    message: parsed.clarificationQuestion ?? parsed.ambiguity[0],
    alternatives: parsed.clarificationAlternatives,
  };
}

async function parseViaApi(text: string): Promise<LiveResult> {
  const response = await fetch(`${apiBaseUrl}/parse`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-api-version': '1',
    },
    body: JSON.stringify({ text, tz: timeZone, now: referenceInstant }),
  });

  if (response.ok) {
    const parsed = await response.json() as ParseResponse;
    return { ok: true, ...parsed };
  }

  const parsed = await response.json() as { error: string; message?: string; alternatives?: ParseAlternative[] };
  return { ok: false, status: response.status, ...parsed };
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function temporalFeaturesFromEnv(): TemporalFeatureFlags | undefined {
  const features: TemporalFeatureFlags = {};
  const ordinalWeekdayGrammar = optionalBoolean(process.env['TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR']);
  const planIr = optionalBoolean(process.env['TEMPORAL_FEATURE_PLAN_IR']);
  if (ordinalWeekdayGrammar !== undefined) {
    features.ordinalWeekdayGrammar = ordinalWeekdayGrammar;
  }
  if (planIr !== undefined) {
    features.planIr = planIr;
  }
  return Object.keys(features).length === 0 ? undefined : features;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return undefined;
  }
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function stripTrailingSlash(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.replace(/\/+$/, '');
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
