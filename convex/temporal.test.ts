import { convexTest } from 'convex-test';
import { beforeEach, expect, test, vi } from 'vitest';
import schema from './schema';
import { rateLimiter as limits } from './limits';
import { api, internal } from './_generated/api';
import { parseTemporalExpression } from '../api/src/temporal/index';
import rateLimiter from '@convex-dev/rate-limiter/test';

vi.mock('../api/src/temporal/index', () => ({ parseTemporalExpression: vi.fn() }));
const modules = import.meta.glob('./**/*.ts');
const args = { text: 'tmrw at seventeen hundred', tz: 'America/Indianapolis', now: '2026-11-18T21:18:11.689Z', requestId: 'test-request' };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key'); });

test('rejects unauthenticated and invalid requests before calling OpenAI', async () => {
  const t = convexTest(schema, modules);
  rateLimiter.register(t);
  await expect(t.action(api.temporal.parse, args)).rejects.toThrow('Sign in');
  const user = t.withIdentity({ subject: 'user-a', issuer: 'https://clerk.example' });
  for (const invalid of [{ text: '' }, { text: 'x'.repeat(16385) }, { tz: 'invalid/zone' }, { now: 'bad-time' }, { now: '2026-02-30T12:00:00Z' }, { requestId: '' }]) {
    await expect(user.action(api.temporal.parse, { ...args, ...invalid })).rejects.toThrow();
  }
  expect(parseTemporalExpression).not.toHaveBeenCalled();
});

test('uses Luna low, strips traces, and tracks usage separately for each user', async () => {
  const t = convexTest(schema, modules);
  rateLimiter.register(t);
  vi.mocked(parseTemporalExpression).mockResolvedValue({
    status: 'resolved', epoch: 1795125600, confidence: 0.9, method: 'agent+plan',
    assumptions: [], ambiguity: [], validation: { passed: true, checks: [], warnings: [] },
    debug: { inputTokens: 100, outputTokens: 30, trace: [{ index: 0, type: 'llm', name: 'private' }] },
  });
  const a = t.withIdentity({ subject: 'user-a', issuer: 'https://clerk.example' });
  const result = await a.action(api.temporal.parse, args);
  expect(parseTemporalExpression).toHaveBeenCalledWith(expect.objectContaining({ openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'low', features: expect.objectContaining({ planIr: true, deterministicPreflight: false, discordReferenceRouting: true }) }));
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
  const base = convexTest(schema, modules); rateLimiter.register(base);
  const t = base.withIdentity({ subject: 'user-a' });
  vi.mocked(parseTemporalExpression).mockRejectedValue(new Error('private provider error with credential'));
  await expect(t.action(api.temporal.parse, args)).rejects.toThrow('Hosted parsing is unavailable');
  expect(await t.query(api.usage.mine, {})).toEqual({ requests: 1, inputTokens: 0, outputTokens: 0 });
});
test('nonthrowing provider diagnostics and validation details do not cross into the client', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  const privateMessage = 'Incorrect API key sk-synthetic-fragment at private-provider.example';
  vi.mocked(parseTemporalExpression).mockResolvedValue({ status: 'failed', confidence: 0, method: 'fallback', assumptions: [], ambiguity: [privateMessage], clarificationQuestion: privateMessage, validation: { passed: false, warnings: [privateMessage], checks: [] }, debug: { finalValidation: { accepted: false, confidence: 0, reason: privateMessage, missingOrContradictedSignals: [] } } });
  const result = await t.withIdentity({ subject: 'provider-warning' }).action(api.temporal.parse, args);
  expect(JSON.stringify(result)).not.toContain(privateMessage);
  expect(result.validation.warnings).toEqual(['Smart parsing could not verify this expression.']);
  expect(result.debug?.finalValidation).toBeUndefined();
  expect(result.ambiguity).toEqual(['Smart parsing could not verify this expression.']);
  expect(result.clarificationQuestion).toBeUndefined();
});

test('throttles duplicate bursts before model work and isolates accounts', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  const a = t.withIdentity({ subject: 'burst-a' });
  const b = t.withIdentity({ subject: 'burst-b' });
  vi.mocked(parseTemporalExpression).mockResolvedValue({ status: 'failed', confidence: 0, method: 'agent+plan', assumptions: [], ambiguity: [], validation: { passed: false, warnings: [], checks: [] } });
  await a.action(api.temporal.parse, args);
  await a.action(api.temporal.parse, args);
  await a.action(api.temporal.parse, args);
  await expect(a.action(api.temporal.parse, args)).rejects.toThrow('Wait a few seconds');
  expect(parseTemporalExpression).toHaveBeenCalledTimes(3);
  await b.action(api.temporal.parse, args);
  expect(parseTemporalExpression).toHaveBeenCalledTimes(4);
});
test('bounds deployment-wide model calls even across distinct admitted identities', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  vi.mocked(parseTemporalExpression).mockResolvedValue({ status: 'failed', confidence: 0, method: 'agent+plan', assumptions: [], ambiguity: [], validation: { passed: false, warnings: [], checks: [] } });
  for (let index = 0; index < 100; index += 1) {
    await t.withIdentity({ subject: `daily-${index}` }).action(api.temporal.parse, args);
  }
  await expect(t.withIdentity({ subject: 'one-more-account' }).action(api.temporal.parse, args)).rejects.toMatchObject({ data: expect.objectContaining({ code: 'shared_limit' }) });
  expect(parseTemporalExpression).toHaveBeenCalledTimes(100);
  const rejected = t.withIdentity({subject: 'one-more-account'});
  await rejected.run(async ctx => {
    const identity = await ctx.auth.getUserIdentity();
    const burst = await limits.getValue(ctx, 'fallback', {key: identity!.tokenIdentifier});
    expect(burst.value).toBe(3);
  });
});

test('tracking failure cannot replace a successful validated result', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(parseTemporalExpression).mockResolvedValue({ status: 'resolved', epoch: 1, confidence: 1, method: 'agent+plan', assumptions: [], ambiguity: [], validation: { passed: true, warnings: [], checks: [] }, debug: { inputTokens: 'invalid-counter' as unknown as number } });
  await expect(t.withIdentity({ subject: 'tracking-failure' }).action(api.temporal.parse, args)).resolves.toMatchObject({ status: 'resolved', epoch: 1 });
  expect(warning).toHaveBeenCalled(); warning.mockRestore();
});

test('keeps completed usage when a later provider call fails', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  vi.mocked(parseTemporalExpression).mockImplementation(async params => {
    params.onModelUsage?.({inputTokens: 123, outputTokens: 45});
    params.onModelUsage?.(null);
    throw new Error('later provider failure');
  });
  await expect(t.withIdentity({subject: 'partial-usage'}).action(api.temporal.parse, args)).rejects.toThrow('Hosted parsing is unavailable');
  await t.run(async ctx => {
    const [usage] = await ctx.db.query('usage').collect();
    expect(usage).toMatchObject({inputTokens: 123, outputTokens: 45, usageComplete: false, status: 'error'});
  });
});

test('one account can continue beyond twenty spaced attempts without a personal day-long lockout', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  let now = new Date('2026-11-19T12:00:00Z').getTime();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(parseTemporalExpression).mockResolvedValue({ status: 'failed', confidence: 0, method: 'agent+plan', assumptions: [], ambiguity: [], validation: { passed: false, warnings: [], checks: [] } });
  try {
    const user = t.withIdentity({subject: 'daily-user'});
    for (let index=0; index<20; index++) { await user.action(api.temporal.parse, args); now += 60_000; }
    await user.action(api.temporal.parse, args);
    expect(parseTemporalExpression).toHaveBeenCalledTimes(21);
    await t.withIdentity({subject: 'another-user'}).action(api.temporal.parse, args);
    expect(parseTemporalExpression).toHaveBeenCalledTimes(22);
  } finally { clock.mockRestore(); }
});

test('retains 30 days of attempt rows while preserving lifetime usage totals', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  let now = new Date('2026-10-01T12:00:00Z').getTime();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(parseTemporalExpression).mockResolvedValue({status:'resolved',epoch:1,confidence:1,method:'agent+plan',assumptions:[],ambiguity:[],validation:{passed:true,warnings:[],checks:[]},debug:{inputTokens:5,outputTokens:2}});
  try {
    const user = t.withIdentity({subject:'retention-user'});
    await user.action(api.temporal.parse,args);
    now += 31*24*60*60*1000;
    await user.action(api.temporal.parse,args);
    expect(await user.query(api.usage.mine,{})).toEqual({requests:2,inputTokens:10,outputTokens:4});
    await t.mutation(internal.usage.prune,{});
    await t.run(async ctx => {expect(await ctx.db.query('usage').collect()).toHaveLength(1);});
    expect(await user.query(api.usage.mine,{})).toEqual({requests:2,inputTokens:10,outputTokens:4});
    expect(parseTemporalExpression).toHaveBeenCalledTimes(2);
  } finally {clock.mockRestore();}
});

test('shared exhaustion recovers with refill instead of waiting for a fixed daily boundary', async () => {
  const t = convexTest(schema, modules); rateLimiter.register(t);
  let now = new Date('2026-11-19T12:00:00Z').getTime();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(parseTemporalExpression).mockResolvedValue({status:'failed',confidence:0,method:'agent+plan',assumptions:[],ambiguity:[],validation:{passed:false,warnings:[],checks:[]}});
  try {
    for(let i=0;i<100;i++) await t.withIdentity({subject:'refill-'+i}).action(api.temporal.parse,args);
    await expect(t.withIdentity({subject:'before-refill'}).action(api.temporal.parse,args)).rejects.toThrow('shared daily limit');
    now += 15*60*1000;
    await t.withIdentity({subject:'after-refill'}).action(api.temporal.parse,args);
    await expect(t.withIdentity({subject:'no-second-token'}).action(api.temporal.parse,args)).rejects.toThrow('shared daily limit');
    expect(parseTemporalExpression).toHaveBeenCalledTimes(101);
  } finally {clock.mockRestore();}
});

test.each([false, true])('reports the server deadline distinctly, including late parser returns (%s)', async lateReturn => {
  const t=convexTest(schema,modules); rateLimiter.register(t);
  const controller=new AbortController();
  const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
  vi.mocked(parseTemporalExpression).mockImplementation(async params=>{
    expect(params.signal).toBe(controller.signal);
    params.onModelUsage?.({inputTokens:10,outputTokens:2});
    controller.abort(new DOMException('private timeout diagnostic','TimeoutError'));
    if(!lateReturn) throw controller.signal.reason;
    return {status:'resolved',epoch:1,confidence:1,method:'agent+plan',assumptions:[],ambiguity:[],validation:{passed:true,warnings:[],checks:[]}};
  });
  try {
    const user=t.withIdentity({subject:'timeout-user'});
    await expect(user.action(api.temporal.parse,args)).rejects.toMatchObject({data:expect.objectContaining({code:'parse_timeout'})});
    expect(timeout).toHaveBeenCalledWith(30000);
    expect(await user.query(api.usage.mine,{})).toEqual({requests:1,inputTokens:10,outputTokens:2});
    await t.run(async ctx=>{const [usage]=await ctx.db.query('usage').collect();expect(usage.status).toBe('timeout');});
  } finally {timeout.mockRestore();}
});

test('new parser fields and nested diagnostics stay private by default',async()=>{
  const t=convexTest(schema,modules);rateLimiter.register(t);
  const canonical={isoInstant:'2026-01-01T00:00:00Z',zonedDateTime:'2026-01-01T00:00:00+00:00[UTC]',timeZone:'UTC',precision:'datetime' as const,privateField:'private-diagnostic'};
  const range={start:{epoch:1,suggestedFormatIndex:4,canonical,privateField:'private-diagnostic'},end:{epoch:2,suggestedFormatIndex:4,canonical},discord:'<t:1:f> - <t:2:f>',privateField:'private-diagnostic'};
  const raw={status:'resolved' as const,kind:'time_range' as const,range,confidence:1,method:'agent+plan' as const,assumptions:['private-diagnostic'],ambiguity:[],validation:{passed:true,warnings:[],checks:['private-diagnostic']},privateField:'private-diagnostic'};
  vi.mocked(parseTemporalExpression).mockResolvedValue(raw);
  const result=await t.withIdentity({subject:'allowlist-user'}).action(api.temporal.parse,args);
  expect(result.range?.start.epoch).toBe(1);expect(result.range?.end.epoch).toBe(2);
  expect(result.assumptions).toEqual([]);expect(result.validation.checks).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('private-diagnostic');
});
