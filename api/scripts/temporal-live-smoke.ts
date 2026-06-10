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
  generationId?: string;
  alternatives?: ParseAlternative[];
};
type LiveResult = LiveSuccess | LiveFailure;
type LiveContext = { referenceInstant?: string; timeZone?: string };

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
  await expectClarification('next saturday at l33t time', [1780162620, 1780767420]);
  await expectResolved('easter 2028', 1839513600, 1);
  await expectClarification('saturday at 3', [1780124400, 1780167600]);
  await expectClarification('next saturday at 5pm', [1780174800, 1780779600]);
  await expectClarification('next tuesday', [1779811200, 1780416000]);
  await expectClarification('next saturday', [1780156800, 1780761600], { referenceInstant: '2026-05-29T16:00:00Z' });
  if (isTruthy(process.env['TEMPORAL_FEATURE_PLAN_IR'])) {
    await expectResolved('day after a week from tomorrow at 133t time', 1780421820, 4);
    await expectClarification('sunday after next 5pm', [1780866000, 1781470800]);
  }

  console.log('Live temporal smoke tests passed.');
}

async function expectResolved(text: string, epoch: number, suggestedFormatIndex: number, context?: LiveContext) {
  const result = await parseLive(text, context);
  assert.equal(result.ok, true, `${text} should resolve`);
  if (!result.ok) {
    return;
  }
  assert.equal(result.epoch, epoch, `${text} epoch`);
  assert.equal(result.suggestedFormatIndex, suggestedFormatIndex, `${text} suggested format`);
  assert.match(result.method, /agent|tool/i, `${text} should use the live agent/tool path`);
}

async function expectClarification(text: string, epochs: number[], context?: LiveContext) {
  const result = await parseLive(text, context);
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

async function parseLive(text: string, context: LiveContext = {}): Promise<LiveResult> {
  if (apiBaseUrl !== undefined) {
    return parseViaApi(text, context);
  }

  if (openaiApiKey === undefined) {
    throw new Error('OPENAI_API_KEY is required for direct live parser tests.');
  }

  const parseReferenceInstant = context.referenceInstant ?? referenceInstant;
  const parseTimeZone = context.timeZone ?? timeZone;
  const features = temporalFeaturesFromEnv();
  const parsed = await parseTemporalExpression({
    text,
    timeZone: parseTimeZone,
    referenceInstant: parseReferenceInstant,
    openaiApiKey,
    openaiModel: process.env['OPENAI_MODEL'] ?? 'gpt-5.5',
    openaiReasoningEffort: process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
    ...(features === undefined ? {} : { features }),
    langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
  });

  if (parsed.status === 'resolved' && parsed.epoch !== undefined && parsed.suggestedFormatIndex !== undefined) {
    return {
      ok: true,
      generationId: parsed.generationId ?? '',
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
    generationId: parsed.generationId,
    alternatives: parsed.clarificationAlternatives,
  };
}

async function parseViaApi(text: string, context: LiveContext = {}): Promise<LiveResult> {
  const features = temporalFeaturesFromEnv();
  const response = await fetch(`${apiBaseUrl}/parse`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-api-version': '1',
    },
    body: JSON.stringify({
      text,
      tz: context.timeZone ?? timeZone,
      now: context.referenceInstant ?? referenceInstant,
      ...(features === undefined ? {} : { features }),
    }),
  });

  if (response.ok) {
    const parsed = await response.json() as ParseResponse;
    return { ok: true, ...parsed };
  }

  const parsed = await response.json() as { error: string; message?: string; generationId?: string; alternatives?: ParseAlternative[] };
  return { ok: false, status: response.status, ...parsed };
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function temporalFeaturesFromEnv(): TemporalFeatureFlags | undefined {
  const features: TemporalFeatureFlags = {};
  const deterministicPreflight = optionalBoolean(process.env['TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT']);
  const ordinalWeekdayGrammar = optionalBoolean(process.env['TEMPORAL_FEATURE_ORDINAL_WEEKDAY_GRAMMAR']);
  const planIr = optionalBoolean(process.env['TEMPORAL_FEATURE_PLAN_IR']);
  const semanticConsistencyGate = optionalBoolean(process.env['TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE']);
  if (deterministicPreflight !== undefined) {
    features.deterministicPreflight = deterministicPreflight;
  }
  if (ordinalWeekdayGrammar !== undefined) {
    features.ordinalWeekdayGrammar = ordinalWeekdayGrammar;
  }
  if (planIr !== undefined) {
    features.planIr = planIr;
  }
  if (semanticConsistencyGate !== undefined) {
    features.semanticConsistencyGate = semanticConsistencyGate;
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
