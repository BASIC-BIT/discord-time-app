import { convexTest } from 'convex-test';
import { beforeEach, expect, test, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { parseTemporalExpression } from '../api/src/temporal/index';

vi.mock('../api/src/temporal/index', () => ({ parseTemporalExpression: vi.fn() }));
const modules = import.meta.glob('./**/*.ts');
const args = { text: 'tmrw at seventeen hundred', tz: 'America/Indianapolis', now: '2026-11-18T21:18:11.689Z', requestId: 'test-request' };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key'); });

test('rejects unauthenticated and invalid requests before calling OpenAI', async () => {
  const t = convexTest(schema, modules);
  await expect(t.action(api.temporal.parse, args)).rejects.toThrow('Sign in');
  const user = t.withIdentity({ subject: 'user-a', issuer: 'https://clerk.example' });
  for (const invalid of [{ text: '' }, { text: 'x'.repeat(16385) }, { tz: 'invalid/zone' }, { now: 'bad-time' }, { now: '2026-02-30T12:00:00Z' }, { requestId: '' }]) {
    await expect(user.action(api.temporal.parse, { ...args, ...invalid })).rejects.toThrow();
  }
  expect(parseTemporalExpression).not.toHaveBeenCalled();
});

test('uses Luna low, strips traces, and tracks usage separately for each user', async () => {
  const t = convexTest(schema, modules);
  vi.mocked(parseTemporalExpression).mockResolvedValue({
    status: 'resolved', epoch: 1795125600, confidence: 0.9, method: 'agent+plan',
    assumptions: [], ambiguity: [], validation: { passed: true, checks: [], warnings: [] },
    debug: { inputTokens: 100, outputTokens: 30, trace: [{ index: 0, type: 'llm', name: 'private' }] },
  });
  const a = t.withIdentity({ subject: 'user-a', issuer: 'https://clerk.example' });
  const result = await a.action(api.temporal.parse, args);
  expect(parseTemporalExpression).toHaveBeenCalledWith(expect.objectContaining({ openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'low', features: expect.objectContaining({ planIr: true }) }));
  expect(result.debug?.trace).toBeUndefined();
  expect(await a.query(api.usage.mine, {})).toEqual({ requests: 1, inputTokens: 100, outputTokens: 30 });
  const b = t.withIdentity({ subject: 'user-b', issuer: 'https://clerk.example' });
  expect(await b.query(api.usage.mine, {})).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0 });
  expect(await t.query(api.usage.mine, {})).toBeNull();
  await t.run(async ctx => {
    const [usage] = await ctx.db.query('usage').collect();
    expect(usage).not.toHaveProperty('text');
    expect(usage.status).toBe('resolved');
  });
});

test('provider errors stay generic and still record an unsuccessful attempt', async () => {
  const t = convexTest(schema, modules).withIdentity({ subject: 'user-a' });
  vi.mocked(parseTemporalExpression).mockRejectedValue(new Error('private provider error with credential'));
  await expect(t.action(api.temporal.parse, args)).rejects.toThrow('Hosted parsing is unavailable');
  expect(await t.query(api.usage.mine, {})).toEqual({ requests: 1, inputTokens: 0, outputTokens: 0 });
});
