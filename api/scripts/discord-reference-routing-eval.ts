import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { classifyDiscordTimestampInput } from '@hammer-overlay/discord-timestamp-routing';
import { parseTemporalExpression } from '../src/temporal';
import {
  temporalEvalCases,
  type ExpectedRange,
  type TemporalEvalCase,
} from './temporal-model-eval';

const defaultReferenceInstant = process.env['TEMPORAL_EVAL_NOW'] ?? '2026-05-24T12:00:00Z';
// This imported catalog contains fixed expected epochs built for its canonical zone.
// Per-case timeZone values still override this default; a process-level override would
// otherwise change execution without rebuilding those expectations.
const defaultTimeZone = 'America/New_York';

const cases = temporalEvalCases.filter(
  (evalCase): evalCase is TemporalEvalCase & { expectedRoute: NonNullable<TemporalEvalCase['expectedRoute']> } =>
    evalCase.expectedRoute !== undefined,
);

async function main() {
  const endpointBaseUrl = process.env['TEMPORAL_EVAL_ENDPOINT_BASE_URL'];
  const endpointModel = process.env['TEMPORAL_EVAL_ENDPOINT_MODEL'];
  const endpointEnabled = endpointBaseUrl !== undefined && endpointModel !== undefined;
  const results: Array<{
    id: string;
    route: string;
    routeReason: string;
    status: string;
    durationMs: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }> = [];

  for (const evalCase of cases) {
    const clientClassification = classifyDiscordTimestampInput(evalCase.text);
    assert.equal(clientClassification.route, evalCase.expectedRoute, `${evalCase.id}: client route`);
    if (evalCase.expectedRouteReason !== undefined) {
      assert.equal(clientClassification.reason, evalCase.expectedRouteReason, `${evalCase.id}: client route reason`);
    }

    const startedAt = performance.now();
    const parsed = await parseTemporalExpression({
      text: evalCase.text,
      timeZone: evalCase.timeZone ?? defaultTimeZone,
      referenceInstant: evalCase.referenceInstant ?? defaultReferenceInstant,
      modelCost: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
        fixedUsdPerCall: 0,
        configured: true,
      },
      ...(endpointEnabled ? {
        features: { planIr: true, discordReferenceRouting: true },
        planIrEndpoint: {
          baseUrl: endpointBaseUrl,
          model: endpointModel,
          instructionPreset: 'minimal' as const,
          api: 'chat' as const,
          promptFormat: 'chat' as const,
          maxTokens: 512,
          timeoutMs: 15_000,
        },
      } : {}),
    });
    const durationMs = performance.now() - startedAt;
    const offlineModelRoute = !endpointEnabled && evalCase.expectedRoute === 'model';

    if (process.env['TEMPORAL_EVAL_DEBUG_CASE'] === evalCase.id) {
      console.error(JSON.stringify({
        id: evalCase.id,
        status: parsed.status,
        epoch: parsed.epoch,
        method: parsed.method,
        validation: parsed.validation,
        trace: parsed.debug?.trace,
      }, null, 2));
    }

    assert.equal(
      parsed.debug?.referenceRouting?.classifierVersion,
      clientClassification.version,
      `${evalCase.id}: classifier version agreement`,
    );
    assert.equal(
      parsed.debug?.referenceRouting?.route,
      clientClassification.route,
      `${evalCase.id}: client/server route agreement`,
    );
    assert.equal(
      parsed.debug?.referenceRouting?.reason,
      clientClassification.reason,
      `${evalCase.id}: client/server route reason agreement`,
    );

    if (
      offlineModelRoute
      && parsed.status === 'needs_clarification'
      && evalCase.expected.status === 'needs_clarification'
    ) {
      assertParsed(evalCase, parsed);
    } else if (offlineModelRoute) {
      assert.equal(parsed.status, 'failed', `${evalCase.id}: offline model route must not resolve semantic residue`);
    } else {
      assertParsed(evalCase, parsed);
    }

    if (
      clientClassification.meaningfulResidue
      && parsed.status === 'resolved'
      && parsed.range === undefined
      && clientClassification.route === 'model'
    ) {
      assert.notEqual(
        parsed.epoch,
        clientClassification.references[0]?.epochSeconds,
        `${evalCase.id}: bare-anchor fallback`,
      );
    }
    assert.equal(durationMs < 5000, true, `${evalCase.id}: five-second SLO`);

    results.push({
      id: evalCase.id,
      route: clientClassification.route,
      routeReason: clientClassification.reason,
      status: parsed.status,
      durationMs: Math.round(durationMs * 100) / 100,
      modelCalls: parsed.debug?.modelCalls ?? 0,
      inputTokens: parsed.debug?.inputTokens ?? 0,
      outputTokens: parsed.debug?.outputTokens ?? 0,
      estimatedCostUsd: parsed.debug?.estimatedCostUsd ?? 0,
    });
  }

  const routeCounts = Object.fromEntries(
    [...new Set(results.map((result) => result.route))]
      .sort()
      .map((route) => [route, results.filter((result) => result.route === route).length]),
  );
  const maxDurationMs = Math.max(...results.map((result) => result.durationMs));
  const modelCalls = results.reduce((total, result) => total + result.modelCalls, 0);
  const estimatedCostUsd = results.reduce((total, result) => total + result.estimatedCostUsd, 0);
  console.log(JSON.stringify({
    catalog: 'temporalEvalCases',
    mode: endpointEnabled ? 'production-routed' : 'offline',
    model: endpointEnabled ? endpointModel : undefined,
    classifierAgreement: `${results.length}/${results.length}`,
    correctness: `${results.length}/${results.length}`,
    falseFastPath: 0,
    falseModelPath: 0,
    maxDurationMs,
    modelCalls,
    estimatedCostUsd,
    routeCounts,
  }, null, 2));
}

function assertParsed(
  evalCase: TemporalEvalCase,
  parsed: Awaited<ReturnType<typeof parseTemporalExpression>>,
): void {
  assert.equal(parsed.status, evalCase.expected.status, `${evalCase.id}: status`);
  if (evalCase.expected.status === 'resolved') {
    if (evalCase.expected.range !== undefined) {
      assertRange(evalCase.id, evalCase.expected.range, parsed);
      return;
    }
    if (evalCase.expected.epoch !== undefined) {
      assert.equal(parsed.epoch, evalCase.expected.epoch, `${evalCase.id}: epoch`);
    }
    assert.equal(parsed.range, undefined, `${evalCase.id}: unexpected range`);
    if (evalCase.expected.suggestedFormatIndex !== undefined) {
      assert.equal(
        parsed.suggestedFormatIndex,
        evalCase.expected.suggestedFormatIndex,
        `${evalCase.id}: format`,
      );
    }
  }
}

function assertRange(
  caseId: string,
  expected: ExpectedRange,
  parsed: Awaited<ReturnType<typeof parseTemporalExpression>>,
): void {
  assert.equal(parsed.epoch, expected.startEpoch, `${caseId}: range anchor epoch`);
  assert.equal(parsed.range?.start.epoch, expected.startEpoch, `${caseId}: range start`);
  assert.equal(parsed.range?.end.epoch, expected.endEpoch, `${caseId}: range end`);
  if (expected.startFormatIndex !== undefined) {
    assert.equal(parsed.range?.start.suggestedFormatIndex, expected.startFormatIndex, `${caseId}: range start format`);
  }
  if (expected.endFormatIndex !== undefined) {
    assert.equal(parsed.range?.end.suggestedFormatIndex, expected.endFormatIndex, `${caseId}: range end format`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
