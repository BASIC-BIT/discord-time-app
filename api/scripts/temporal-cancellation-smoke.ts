import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseTemporalExpression } from '../src/temporal';

async function main() {
  let generationStarted = false;
  let cancellationReceived = false;
  const server = createServer((request, response) => {
    if (request.url === '/v1/cancel') {
      cancellationReceived = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"cancelled":true}');
      return;
    }
    generationStarted = true;
    // Deliberately leave the completion pending until its request is aborted.
    request.once('aborted', () => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address === 'object');

  const controller = new AbortController();
  const parse = parseTemporalExpression({
    text: '<t:1785643200:t> roughly an hour later',
    timeZone: 'America/New_York',
    referenceInstant: '2026-05-15T16:00:00Z',
    requestId: 'cancellation-smoke',
    signal: controller.signal,
    features: { planIr: true, discordReferenceRouting: true },
    planIrEndpoint: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'cancellation-smoke-model',
      instructionPreset: 'minimal',
      api: 'completions',
      promptFormat: 'custom',
      maxTokens: 64,
      timeoutMs: 10_000,
    },
  });

  while (!generationStarted) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await assert.rejects(parse, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(cancellationReceived, true);
  server.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
