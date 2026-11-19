import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TimeParserAPIClient, TimeParserAPIError } from './api-client';
import { canUseHostedFallback, parseHostedTime } from './hosted-parser';
import { ConvexError } from 'convex/values';

const fake = vi.hoisted(() => ({ action: vi.fn(), getToken: vi.fn(), setAuth: vi.fn(), invoke: vi.fn(), configured: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('./hosted-auth', () => ({ getHostedAuthToken: fake.getToken, get hostedConfigured() { return fake.configured; } }));
vi.mock('convex/browser', () => ({ ConvexHttpClient: class { action = fake.action; setAuth = fake.setAuth; } }));
const now = '2026-11-18T21:18:11.689Z';
beforeEach(() => {
  vi.clearAllMocks(); fake.configured = true; fake.getToken.mockResolvedValue('test-session-token');
  fake.action.mockResolvedValue({ status: 'resolved', epoch: 1795125600, method: 'agent+plan', confidence: 0.9, validation: { passed: true } });
});
afterEach(() => vi.unstubAllGlobals());

test('the native bridge preserves warmup failure metadata and the reference instant', async () => {
  fake.invoke.mockResolvedValue({ ok: false, status: 400, body: { error: 'parse_failed', debug: { endpointWarming: true } } });
  const client = new TimeParserAPIClient('http://127.0.0.1:8857', 'test-local-key');
  await expect(client.parseTime('test', 'UTC', undefined, { now, requestId: 'id' })).rejects.toSatisfy(canUseHostedFallback);
  expect(fake.invoke).toHaveBeenCalledWith('parse_time_with_local_service', expect.objectContaining({ request: expect.objectContaining({ now, requestId: 'id' }) }));
});

test('HTTP clients preserve the same warmup failure metadata', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'parse_failed', debug: { endpointWarming: true } }), { status: 400 })));
  const client = new TimeParserAPIClient('http://127.0.0.1:8857', 'test-local-key', 'unavailable', false);
  await expect(client.parseTime('test', 'UTC')).rejects.toSatisfy(canUseHostedFallback);
});

test('only a failed deterministic parse during warmup is eligible', () => {
  expect(canUseHostedFallback(new TimeParserAPIError('failed', 400, 'parse_failed', undefined, undefined, true))).toBe(true);
  for (const error of [new Error('offline'), new TimeParserAPIError('clarify', 400, 'needs_clarification', undefined, undefined, true), new TimeParserAPIError('failed', 400), new TimeParserAPIError('unavailable', 503, undefined, undefined, undefined, true)]) {
    expect(canUseHostedFallback(error)).toBe(false);
  }
});

test('signed-out users receive an explicit sign-in error and make no cloud request', async () => {
  fake.getToken.mockResolvedValue(null);
  await expect(parseHostedTime('test', 'UTC', now, 'id', new AbortController().signal)).rejects.toMatchObject({ status: 401, code: 'sign_in_required' });
  expect(fake.action).not.toHaveBeenCalled();
});

test('unconfigured builds keep the original local failure and make no auth request', async () => {
  fake.configured = false;
  expect(canUseHostedFallback(new TimeParserAPIError('original failure', 400, 'parse_failed', undefined, undefined, true))).toBe(false);
  await expect(parseHostedTime('test', 'UTC', now, 'id', new AbortController().signal)).rejects.toMatchObject({ status: 503 });
  expect(fake.getToken).not.toHaveBeenCalled();
});

test('relay auth and throttle rejections remain actionable', async () => {
  for (const [code, status] of [['sign_in_required', 401], ['rate_limited', 429]] as const) {
    fake.action.mockRejectedValue(new ConvexError({ code, message: 'Actionable message' }));
    await expect(parseHostedTime('test', 'UTC', now, 'id', new AbortController().signal)).rejects.toMatchObject({ code, status, message: 'Actionable message' });
  }
});

test('validated results skip redundant overlay verification', async () => {
  const result = await parseHostedTime('test', 'UTC', now, 'id', new AbortController().signal);
  expect(fake.action).toHaveBeenCalledWith(expect.anything(), { text: 'test', tz: 'UTC', now, requestId: 'id' });
  expect(fake.setAuth).toHaveBeenCalledWith('test-session-token');
  expect(result?.debug?.serverValidated).toBe(true);
  fake.action.mockResolvedValue({ status: 'resolved', epoch: 1, validation: { passed: false } });
  await expect(parseHostedTime('test', 'UTC', now, 'id', new AbortController().signal)).rejects.toThrow('Could not verify');
});

test('cancellation discards a cloud result without waiting for the provider', async () => {
  fake.action.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const promise = parseHostedTime('test', 'UTC', now, 'id', controller.signal);
  await vi.waitFor(() => expect(fake.action).toHaveBeenCalled());
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});
test('the action rejection remains handled after cancellation wins the race', async () => {
  let rejectAction!: (error: Error) => void;
  fake.action.mockReturnValue(new Promise((_, reject) => { rejectAction = reject; }));
  const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
  try {
    const controller = new AbortController();
    const promise = parseHostedTime('test', 'UTC', now, 'id', controller.signal);
    await vi.waitFor(() => expect(fake.action).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    rejectAction(new Error('late provider failure'));
    await new Promise(resolve => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off('unhandledRejection', unhandled); }
});

test('validated ranges survive fallback without requiring a singular epoch', async () => {
  const range = { start: { epoch: 1795125600 }, end: { epoch: 1795129200 } };
  fake.action.mockResolvedValue({ status: 'resolved', kind: 'time_range', range, method: 'agent+plan', confidence: 1, validation: { passed: true } });
  await expect(parseHostedTime('from 5pm to 6pm', 'UTC', now, 'range-id', new AbortController().signal)).resolves.toMatchObject({ kind: 'time_range', range, debug: { serverValidated: true } });
  fake.action.mockResolvedValue({ status: 'resolved', kind: 'time_range', validation: { passed: true } });
  await expect(parseHostedTime('from 5pm to 6pm', 'UTC', now, 'bad-range', new AbortController().signal)).rejects.toThrow('Could not verify');
});

test('cancelling during token refresh never starts a model call', async () => {
  let resolveToken: (token: string) => void = () => {};
  fake.getToken.mockReturnValue(new Promise<string>(resolve => { resolveToken = resolve; }));
  const controller = new AbortController();
  const promise = parseHostedTime('test', 'UTC', now, 'id', controller.signal);
  await vi.waitFor(() => expect(fake.getToken).toHaveBeenCalled());
  controller.abort();
  resolveToken('test-session-token');
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(fake.action).not.toHaveBeenCalled();
});

test('native and HTTP errors do not trigger a second hosted attempt after local LLM work', async () => {
  const body = {error:'parse_failed',debug:{endpointWarming:true,llmFallbackAttempted:true}};
  fake.invoke.mockResolvedValue({ok:false,status:400,body});
  const native = new TimeParserAPIClient('http://127.0.0.1:8857','test-local-key');
  await expect(native.parseTime('test','UTC')).rejects.toSatisfy((error: TimeParserAPIError) => error.llmFallbackAttempted && !canUseHostedFallback(error));
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:400})));
  const http = new TimeParserAPIClient('http://127.0.0.1:8857','test-local-key','unavailable',false);
  await expect(http.parseTime('test','UTC')).rejects.toSatisfy((error: TimeParserAPIError) => error.llmFallbackAttempted && !canUseHostedFallback(error));
});
