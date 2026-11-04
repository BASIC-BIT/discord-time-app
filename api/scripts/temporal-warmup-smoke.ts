import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { parseTemporalExpression } from '../src/temporal';
import { PlanIrEndpointWarmth } from '../src/temporal/endpoint-warmth';
import type { TemporalPlanIrEndpointConfig } from '../src/temporal/types';

type Seen = { url: string | undefined; headers: IncomingMessage['headers']; body: Record<string, unknown> };

async function startFakeEndpoint(respond: () => { status: number; body: string } | null) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> });
    const reply = respond();
    if (reply === null) return; // never answer: lets the client time out
    const { status, body } = reply;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const endpoint: TemporalPlanIrEndpointConfig = {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    model: 'warmup-smoke-model',
    apiKey: 'warmup-smoke-key',
    instructionPreset: 'minimal',
    api: 'chat',
    promptFormat: 'chat',
    maxTokens: 64,
    timeoutMs: 5_000,
  };
  return { seen, endpoint, close: () => { server.closeAllConnections(); server.close(); } };
}

async function main() {
  let clock = 1_000_000;
  const now = () => clock;
  const options = { enabled: true, readyTtlMs: 240_000, timeoutMs: 5_000, now };

  // (a) cold -> one deduplicated warm request -> ready; (b) TTL expiry -> cold.
  {
    const fake = await startFakeEndpoint(() => ({ status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}' }));
    const warmth = new PlanIrEndpointWarmth(fake.endpoint, options);
    assert.equal(warmth.status().state, 'cold');
    assert.equal(warmth.shouldShortCircuit(), true);
    const first = warmth.warm();
    const second = warmth.warm();
    assert.equal(first, second);
    assert.equal(warmth.status().state, 'warming');
    await Promise.all([first, second]);
    assert.equal(fake.seen.length, 1);
    assert.equal(fake.seen[0]?.url, '/v1/chat/completions');
    assert.equal(fake.seen[0]?.body['max_tokens'], 1);
    assert.deepEqual(fake.seen[0]?.body['messages'], [{ role: 'user', content: 'warm' }]);
    assert.equal(fake.seen[0]?.headers['authorization'], 'Bearer warmup-smoke-key');
    assert.match(String(fake.seen[0]?.headers['x-request-id']), /^warmup-[0-9a-f-]{36}$/);
    assert.equal(warmth.status().state, 'ready');
    assert.equal(warmth.shouldShortCircuit(), false);

    clock += 240_001;
    assert.equal(warmth.status().state, 'cold');
    assert.equal(warmth.shouldShortCircuit(), true);
    fake.close();
  }

  // (c) 503 -> cold with lastError, and a retry within 10 s sends nothing.
  {
    const fake = await startFakeEndpoint(() => ({ status: 503, body: 'scaling up' }));
    const warmth = new PlanIrEndpointWarmth({ ...fake.endpoint, api: 'completions' }, options);
    await warmth.warm();
    assert.equal(fake.seen.length, 1);
    assert.equal(fake.seen[0]?.url, '/v1/completions');
    assert.equal(fake.seen[0]?.body['prompt'], 'warm');
    const status = warmth.status();
    assert.equal(status.state, 'cold');
    assert.match(status.lastError ?? '', /HTTP 503/);
    clock += 9_000;
    await warmth.warm();
    assert.equal(fake.seen.length, 1);
    clock += 2_000;
    await warmth.warm();
    assert.equal(fake.seen.length, 2);
    fake.close();
  }

  // (c2) nudge(): retries a failed warm after the throttle; a fresh instance with no warm request stays quiet.
  {
    const fake = await startFakeEndpoint(() => ({ status: 503, body: 'no workers available' }));
    const warmth = new PlanIrEndpointWarmth(fake.endpoint, options);
    warmth.nudge();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fake.seen.length, 0);
    assert.equal(warmth.status().lastWarmRequestedAt, null);
    await warmth.warm();
    assert.equal(fake.seen.length, 1);
    assert.equal(warmth.status().lastWarmRequestedAt, new Date(clock).toISOString());
    clock += 11_000;
    warmth.nudge();
    assert.equal(warmth.status().state, 'warming');
    await warmth.warm();
    assert.equal(fake.seen.length, 2);
    fake.close();
  }

  // (c3) a warm that times out at the window edge still gets a nudged retry (window runs from settle).
  {
    let calls = 0;
    const fake = await startFakeEndpoint(() => (calls++ === 0 ? null : { status: 503, body: 'still cold' }));
    const warmth = new PlanIrEndpointWarmth(fake.endpoint, { ...options, timeoutMs: 2_000 });
    const pending = warmth.warm();
    clock += 179_000; // the slow cold start eats almost the whole window before the timeout lands
    await pending;
    assert.equal(fake.seen.length, 1);
    assert.match(warmth.status().lastError ?? '', /timed out after 2000ms/);
    clock += 11_000; // 190 s after the client request, 11 s after the warm settled
    warmth.nudge();
    await warmth.warm(); // joins the nudged in-flight warm
    assert.equal(fake.seen.length, 2);
    fake.close();
  }

  // (c4) backoff, failure cap, fresh client warm, and window expiry.
  {
    const fake = await startFakeEndpoint(() => ({ status: 503, body: 'bad image' }));
    const warmth = new PlanIrEndpointWarmth(fake.endpoint, options);
    const nudgeAndSettle = async () => {
      warmth.nudge();
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await warmth.warm();
    assert.equal(warmth.status().consecutiveFailures, 1);
    clock += 11_000;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 2);
    assert.equal(warmth.status().consecutiveFailures, 2);
    // (e) 2 failures -> 20 s throttle.
    clock += 11_000;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 2);
    clock += 10_000;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 3);
    clock += 41_000;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 4);
    clock += 61_000;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 5);
    assert.equal(warmth.status().consecutiveFailures, 5);
    // (d) capped: no more nudged retries inside the window, a client warm() sends again.
    clock += 61_000;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 5);
    await warmth.warm();
    assert.equal(fake.seen.length, 6);
    assert.equal(warmth.status().consecutiveFailures, 1);
    // (f) past the window from the last request/settle: quiet.
    clock += 180_001;
    await nudgeAndSettle();
    assert.equal(fake.seen.length, 6);
    fake.close();
  }

  // (d) disabled.
  {
    const warmth = new PlanIrEndpointWarmth({ baseUrl: 'http://127.0.0.1:1', model: 'm', instructionPreset: 'minimal', api: 'chat', promptFormat: 'chat', maxTokens: 1, timeoutMs: 1 }, { ...options, enabled: false });
    assert.equal(warmth.status().state, 'disabled');
    assert.equal(warmth.shouldShortCircuit(), false);
    assert.equal(new PlanIrEndpointWarmth(undefined, options).status().state, 'disabled');
  }

  // End to end: the parse observer reports HTTP success and transport failure.
  for (const [status, expected] of [[200, 'success'], [500, 'failure']] as const) {
    const fake = await startFakeEndpoint(() => ({ status, body: '{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}]}' }));
    const calls: string[] = [];
    await parseTemporalExpression({
      text: 'tomorrow at 3pm',
      timeZone: 'America/New_York',
      referenceInstant: '2026-05-15T16:00:00Z',
      features: { planIr: true, deterministicPreflight: false },
      planIrEndpoint: fake.endpoint,
      planIrEndpointObserver: {
        onSuccess: () => calls.push('success'),
        onFailure: (error) => calls.push(`failure:${error}`),
      },
    });
    assert.equal(fake.seen.length, 1, `endpoint called for HTTP ${status}`);
    assert.equal(calls.length, 1);
    assert(calls[0]?.startsWith(expected), `HTTP ${status} -> ${calls[0]}`);
    fake.close();
  }

  console.log('temporal warmup smoke passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
