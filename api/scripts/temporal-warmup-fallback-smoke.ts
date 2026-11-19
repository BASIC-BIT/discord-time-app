import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTemporalPlanPlannerOutput } from '../src/temporal/plan-ir';
import { parseTemporalExpression } from '../src/temporal';

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function checkStrictSchema(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if ('properties' in value && value.properties !== null && typeof value.properties === 'object') {
    assert('required' in value && Array.isArray(value.required));
    assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort());
  }
  for (const nested of Object.values(value)) checkStrictSchema(nested);
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-warmup-fallback-'));
  assert(directory.startsWith(join(tmpdir(), 'temporal-warmup-fallback-')));
  let llmCalls = 0;
  let slmCalls = 0;
  let verdict: 'accept' | 'reject' | 'unavailable' | 'pending' = 'accept';
  let slmReady = false;
  let rejectNextValidation = false;
  const plan = parseTemporalPlanPlannerOutput({ outcome: 'plans', reason: 'Synthetic clock interpretation.', plans: [{
    label: '5 PM', confidence: 0.9, finalStep: 0,
    steps: [{ op: 'resolve_calendar_query', query: 'November 18 2026 5pm', precision: 'datetime' }],
  }] });
  let providerPlan = plan;
  let firstProviderPlan: typeof plan | undefined;
  const llm = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    llmCalls += 1;
    if (verdict === 'pending') return;
    if (verdict === 'unavailable') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"test provider unavailable","type":"authentication_error"}}');
      return;
    }
    const body: unknown = JSON.parse(raw);
    assert(body !== null && typeof body === 'object');
    try {
      checkStrictSchema(body);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"Structured-output schema must require every property","type":"invalid_request_error"}}');
      return;
    }
    const tools = 'tools' in body ? body.tools : [];
    assert(Array.isArray(tools));
    const names = tools.map((entry: unknown) => {
      assert(entry !== null && typeof entry === 'object' && 'function' in entry);
      const fn = entry.function;
      assert(fn !== null && typeof fn === 'object' && 'name' in fn && typeof fn.name === 'string');
      return fn.name;
    });
    const planning = raw.includes('"outcome"');
    if (!planning && 'messages' in body && Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (message.role !== 'user' || typeof message.content !== 'string') continue;
        const packet = JSON.parse(message.content);
        if (packet.originalText === 'May 26th (Tuesday) 2026 at 5pm') {
          assert.equal(packet.facts.referenceLocalDate, '2026-05-15');
          assert.equal(packet.facts.calendarDayOffsetFromReference, 11);
        }
      }
    }
    const selectedPlan = firstProviderPlan ?? providerPlan;
    const args = planning
      ? { ...selectedPlan, plans: selectedPlan.plans.map(entry => ({ ...entry, kind: 'instant', presentationFormat: null })) }
      : { accepted: verdict === 'accept' && !rejectNextValidation, confidence: 0.9, reason: 'Synthetic independent validation.', missingOrContradictedSignals: [] };
    if (planning) firstProviderPlan = undefined;
    if (!planning) rejectNextValidation = false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: `test-${llmCalls}`, object: 'chat.completion', created: 1, model: 'test-llm',
      choices: [{ index: 0, finish_reason: names.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: names.length ? null : JSON.stringify(args),
        ...(names.length ? { tool_calls: [{ id: `tool-${llmCalls}`, type: 'function', function: { name: names[0], arguments: JSON.stringify(args) } }] } : {}),
      } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const slm = createServer((_request, response) => {
    slmCalls += 1;
    response.writeHead(slmReady ? 200 : 503, { 'content-type': 'application/json' });
    response.end(slmReady ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }) : 'warming');
  });
  const llmUrl = await listen(llm);
  const slmUrl = await listen(slm);
  try {
    for (const { configured, warming } of [
      { configured: true, warming: true },
      { configured: false, warming: true },
      { configured: true, warming: false },
    ]) {
      slmReady = !warming;
      const reservation = createServer();
      const apiUrl = await listen(reservation);
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, NODE_ENV: 'production', PORT: new URL(apiUrl).port,
          STATIC_API_KEY: 'test-local-key', DB_PATH: join(directory, `${configured}-${warming}.db`), LANGFUSE_ENABLED: 'false',
          TELEMETRY_HMAC_KEY: 'test-warmup-telemetry-key',
          OPENAI_API_KEY: configured ? 'sk-test-llm-key' : '', OPENAI_MODEL: 'test-llm', OPENAI_BASE_URL: `${llmUrl}/v1`,
          TEMPORAL_FEATURE_PLAN_IR: 'true', TEMPORAL_FEATURE_DETERMINISTIC_PREFLIGHT: 'false',
          TEMPORAL_FEATURE_SEMANTIC_CONSISTENCY_GATE: 'false',
          TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL: slmUrl, TEMPORAL_PLAN_IR_ENDPOINT_MODEL: 'test-cold-slm',
          TEMPORAL_PLAN_IR_ENDPOINT_API: 'chat', TEMPORAL_PLAN_IR_ENDPOINT_WARMUP: String(warming),
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      try {
        const deadline = Date.now() + 15_000;
        while (!output.includes('Server listening on port')) {
          assert(child.exitCode === null && Date.now() < deadline, output);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const parse = (text: string, timeoutMs = 10_000) => fetch(`${apiUrl}/parse`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-local-key', 'x-api-version': '1' },
          body: JSON.stringify({ requestId: 'warmup-fallback-test', text, tz: 'America/Indianapolis', now: '2026-11-18T21:18:11.689Z', features: { deterministicPreflight: false } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const before = llmCalls;
        const resolved = await parse('5pm');
        assert.equal(resolved.status, 200);
        const resolvedBody = await resolved.json();
        assert.equal(resolvedBody.epoch, 1795039200);
        if (!warming) {
          assert.equal(resolvedBody.method, 'agent+plan');
          assert.equal(resolvedBody.debug?.endpointWarming, undefined);
          assert.equal(llmCalls, before, 'the normal RunPod path must not invoke the LLM');
          continue;
        }
        const clarification = await parse('tomorrow at 3');
        assert.equal(clarification.status, 400);
        assert.equal((await clarification.json()).error, 'needs_clarification');
        assert.equal(llmCalls, before, 'resolved and clarification results must not call an LLM');

        verdict = 'accept';
        const fallback = await parse('fuzzy evening marker');
        const result = await fallback.json();
        if (configured) {
          assert.equal(fallback.status, 200, JSON.stringify(result));
          assert.equal(result.method, 'agent+plan');
          assert.equal(result.epoch, 1795039200);
          assert.equal(result.debug?.endpointWarming, true);
          assert.equal(llmCalls - before, 2, 'agent proposal and independent validation must both run');
          verdict = 'reject';
          const locallyRejected = await parse('fuzzy evening marker');
          assert.equal(locallyRejected.status, 400, 'rejected LLM answers must stay failed');
          assert.equal((await locallyRejected.json()).debug.llmFallbackAttempted, true);
          verdict = 'unavailable';
          assert.equal((await parse('fuzzy evening marker')).status, 400, 'provider failure must stay failed');
          verdict = 'pending';
          const callsBeforeCancellation = llmCalls;
          const pending = parse('fuzzy evening marker');
          const cancellationDeadline = Date.now() + 5_000;
          while (llmCalls === callsBeforeCancellation) {
            assert(Date.now() < cancellationDeadline, 'LLM fallback did not start');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          const cancellation = await fetch(`${apiUrl}/parse/cancel`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-local-key', 'x-api-version': '1' },
            body: JSON.stringify({ requestId: 'warmup-fallback-test' }),
          });
          assert.equal((await cancellation.json()).cancelled, true);
          assert.equal((await pending).status, 499);
          const timedOut = await parse('fuzzy evening marker', 35_000);
          assert.equal(timedOut.status, 504);
          assert.equal((await timedOut.json()).error, 'parse_timeout', 'server budget expiry is not user cancellation');
        } else {
          assert.equal(fallback.status, 400);
          assert.equal(result.debug?.llmFallbackAttempted, false);
          assert.equal(result.debug?.endpointWarming, true, 'credential-free clients need the warming signal to use the relay');
          assert.equal(llmCalls, before, 'missing credentials must not call the LLM');
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await once(child, 'exit');
        }
      }
    }
    assert(slmCalls > 0, 'RunPod warming must continue alongside parsing');
    const previousBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = `${llmUrl}/v1`;
      verdict = 'accept';
      const beforeContextualWord = llmCalls;
      const contextualWord = await parseTemporalExpression({ text: 'the standup ist tomorrow um seventeen hundred', timeZone: 'America/New_York', referenceInstant: '2026-11-17T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: true }, langfuse: { enabled: false } });
      assert.equal(contextualWord.status, 'resolved');
      assert.equal(contextualWord.canonical?.isoInstant, '2026-11-18T22:00:00Z');
      assert.equal(llmCalls - beforeContextualWord, 2, 'interpret the ordinary word with a model, then independently validate');
      providerPlan = parseTemporalPlanPlannerOutput({outcome:'plans', reason:'Interpret an ordinal date with an incidental weekday.', plans:[{label:'May 26 at 5pm',confidence:1,finalStep:0,steps:[{op:'resolve_calendar_query',query:'May 26 2026 at 5pm',precision:'datetime'}]}]});
      const beforeOrdinal = llmCalls;
      const ordinal = await parseTemporalExpression({text:'May 26th (Tuesday) 2026 at 5pm',timeZone:'America/New_York',referenceInstant:'2026-05-15T16:00:00Z',openaiApiKey:'synthetic-test-key',openaiModel:'test-llm',features:{planIr:true,deterministicPreflight:true},langfuse:{enabled:false}});
      assert.equal(ordinal.status,'resolved');
      assert.equal(ordinal.epoch,1779829200);
      assert.equal(llmCalls-beforeOrdinal,2,'model composes separate chrono fragments, followed by independent validation');
      rejectNextValidation = true;
      providerPlan = parseTemporalPlanPlannerOutput({ outcome: 'plans', reason: 'Repair a rejected heuristic.', plans: [{ label: 'Six days later', rationale: 'Resolve tomorrow then shift five calendar days.', confidence: 1, finalStep: 1, steps: [{ op: 'resolve_calendar_query', query: 'tomorrow' }, { op: 'shift_datetime', baseStep: 0, delta: { days: 5 } }] }] });
      const observedUsage: ({ inputTokens: number; outputTokens: number } | null)[] = [];
      const beforeRepair = llmCalls;
      const repaired = await parseTemporalExpression({ onModelUsage: usage => { observedUsage.push(usage); }, text: 'the day after the day after the day after the day after the day after tomorrow', timeZone: 'America/New_York', referenceInstant: '2026-05-24T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: true }, langfuse: { enabled: false } });
      assert.equal(repaired.status, 'resolved');
      assert.equal(repaired.method, 'agent+plan');
      assert.equal(repaired.canonical?.isoInstant, '2026-05-30T16:00:00Z');
      assert.equal(llmCalls - beforeRepair, 3, 'reject heuristic, plan repair, independently validate repair');
      assert.equal(repaired.debug?.modelCalls, 3, 'include the rejected preflight validation in usage');
      assert.equal(repaired.debug?.inputTokens, 3);
      assert.deepEqual(observedUsage, Array.from({length: 3}, () => ({inputTokens: 1, outputTokens: 1})));
      assert.equal(repaired.debug?.outputTokens, 3);
      rejectNextValidation = true;
      const beforeLegacy = llmCalls;
      const rejected = await parseTemporalExpression({ text: 'tomorrow at 5pm', timeZone: 'America/New_York', referenceInstant: '2026-05-24T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: false, deterministicPreflight: true }, langfuse: { enabled: false } });
      assert.equal(rejected.status, 'needs_clarification');
      assert.equal(llmCalls - beforeLegacy, 1, 'a rejected answer cannot escalate into the unvalidated legacy agent');

      const invalidPlan = parseTemporalPlanPlannerOutput({ outcome: 'plans', reason: 'Synthetic empty final step.', plans: [{ label: 'Broken plan', finalStep: 0, steps: [{ op: 'propose_candidate', precision: 'datetime' }] }] });
      firstProviderPlan = invalidPlan;
      providerPlan = plan;
      const beforePlanRepair = llmCalls;
      const planRepair = await parseTemporalExpression({ text: 'fuzzy evening marker', timeZone: 'America/New_York', referenceInstant: '2026-11-18T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: false }, langfuse: { enabled: false } });
      assert.equal(planRepair.status, 'resolved');
      assert.equal(llmCalls - beforePlanRepair, 3, 'broken plan, feedback repair, independent validation');
      assert.equal(planRepair.debug?.agentAttempts, 2);
      assert.equal(planRepair.debug?.modelCalls, 3);
      assert.equal(planRepair.debug?.inputTokens, 3);
      assert.equal(planRepair.debug?.outputTokens, 3);
      assert.ok(planRepair.debug?.trace?.some(step => step.name === 'plan_ir_plan_failed'));
      assert.ok(planRepair.debug?.trace?.some(step => step.name === 'plan_ir_repair_requested'));
      assert.deepEqual(planRepair.debug?.trace?.map(step => step.index), planRepair.debug?.trace?.map((_, index) => index + 1));

      firstProviderPlan = parseTemporalPlanPlannerOutput({ outcome: 'plans', reason: 'Synthetic wrong field.', plans: [{ label: 'Reference in text instead of query', finalStep: 0, steps: [{ op: 'resolve_calendar_query', text: '<t:1785643200:t>' }] }] });
      providerPlan = parseTemporalPlanPlannerOutput({ outcome: 'plans', reason: 'Use the exact reference operand.', plans: [{ label: 'One hour later', finalStep: 1, steps: [{ op: 'resolve_calendar_query', query: '<t:1785643200:t>' }, { op: 'shift_datetime', baseStep: 0, delta: { hours: 1 } }] }] });
      const beforeGuardRepair = llmCalls;
      const guardRepair = await parseTemporalExpression({ text: '<t:1785643200:t> one hour later', timeZone: 'America/New_York', referenceInstant: '2026-11-18T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: false }, langfuse: { enabled: false } });
      assert.equal(guardRepair.status, 'resolved');
      assert.equal(guardRepair.epoch, 1785646800);
      assert.equal(llmCalls - beforeGuardRepair, 3, 'reference guard rejection receives the same bounded repair');
      assert.ok(guardRepair.debug?.trace?.some(step => step.name === 'plan_ir_repair_requested'));
      assert.equal(guardRepair.debug?.modelCalls, 3);

      providerPlan = invalidPlan;
      const beforeFailedRepair = llmCalls;
      const failedRepair = await parseTemporalExpression({ text: 'fuzzy evening marker', timeZone: 'America/New_York', referenceInstant: '2026-11-18T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: false }, langfuse: { enabled: false } });
      assert.equal(failedRepair.status, 'failed');
      assert.equal(llmCalls - beforeFailedRepair, 2, 'repair is bounded to one attempt');
      const beforeLateRepair = llmCalls;
      const lateRepair = await parseTemporalExpression({ text: 'fuzzy evening marker', timeZone: 'America/New_York', referenceInstant: '2026-11-18T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: false }, deadlineMs: Date.now() + 12_000, langfuse: { enabled: false } });
      assert.equal(lateRepair.status, 'failed');
      assert.equal(llmCalls - beforeLateRepair, 1, 'do not pay for repair without time to finish it');
      assert.ok(lateRepair.debug?.trace?.some(step => step.name === 'plan_ir_repair_skipped'));
      providerPlan = parseTemporalPlanPlannerOutput({outcome:'clarification',reason:'The timezone abbreviation requires a region.',clarificationQuestion:'Which region did you mean by CST?',plans:[]});
      const beforeQuestion = llmCalls;
      const question = await parseTemporalExpression({text:'tomorrow 5pm CST',timeZone:'America/New_York',referenceInstant:'2026-05-24T12:00:00Z',openaiApiKey:'synthetic-test-key',openaiModel:'test-llm',features:{planIr:true,deterministicPreflight:false},langfuse:{enabled:false}});
      assert.equal(question.status,'needs_clarification');
      assert.equal(question.clarificationQuestion,'Which region did you mean by CST?');
      assert.equal(question.epoch,undefined);
      assert.equal(question.clarificationAlternatives,undefined);
      assert.equal(question.debug?.agentAttempts,1);
      assert.equal(llmCalls-beforeQuestion,1,'a valid question-only answer needs no repair or timestamp validation');
      rejectNextValidation = true;
      providerPlan = parseTemporalPlanPlannerOutput({ outcome: 'no_plan', reason: 'Synthetic unrepresentable interpretation.', plans: [] });
      const beforeNoPlan = llmCalls;
      const noPlan = await parseTemporalExpression({ text: 'tomorrow at 5pm', timeZone: 'America/New_York', referenceInstant: '2026-05-24T12:00:00Z', openaiApiKey: 'synthetic-test-key', openaiModel: 'test-llm', features: { planIr: true, deterministicPreflight: true }, langfuse: { enabled: false } });
      assert.equal(noPlan.status, 'failed');
      assert.equal(noPlan.epoch, undefined, 'failed repair must not restore a rejected timestamp');
      assert.equal(llmCalls - beforeNoPlan, 2, 'no-plan remains terminal after rejected preflight validation');
    } finally {
      if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBase;
    }
    console.log('HTTP warmup fallback smoke passed: deterministic, clarification, LLM success/rejection/failure, cancellation, missing key, background warming, normal SLM route.');
  } finally {
    llm.closeAllConnections();
    slm.closeAllConnections();
    llm.close();
    slm.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
