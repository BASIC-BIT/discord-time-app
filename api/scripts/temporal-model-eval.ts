import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';
import { parseTemporalExpression } from '../src/temporal';
import type { TemporalParseResponse } from '../src/temporal/types';

type ExpectedResolved = {
  status: 'resolved';
  epoch: number;
  suggestedFormatIndex?: number;
};

type ExpectedClarification = {
  status: 'needs_clarification';
  alternativeEpochs: number[];
};

type TemporalEvalCase = {
  id: string;
  text: string;
  category: string;
  expected: ExpectedResolved | ExpectedClarification;
  required?: boolean;
};

type ModelSpec = {
  runner: 'agent' | 'single_call' | 'deterministic';
  provider: 'openai';
  model: string;
  reasoningEffort: string;
};

type DeterministicSpec = {
  runner: 'deterministic';
  provider: 'local';
  model: 'deterministic';
  reasoningEffort: 'none';
};

type EvalRunnerSpec = ModelSpec | DeterministicSpec;

type EvalParsed = {
  status: TemporalParseResponse['status'];
  epoch?: number;
  suggestedFormatIndex?: number;
  confidence: number;
  method: string;
  clarificationAlternatives?: Array<{ epoch: number }>;
  debug?: TemporalParseResponse['debug'];
};

type EvalResult = {
  runner: EvalRunnerSpec['runner'];
  model: string;
  provider: string;
  reasoningEffort: string;
  caseId: string;
  repeat: number;
  text: string;
  category: string;
  required: boolean;
  passed: boolean;
  durationMs: number;
  status?: string;
  epoch?: number;
  suggestedFormatIndex?: number;
  confidence?: number;
  method?: string;
  error?: string;
  mismatch?: string;
  metrics?: {
    agentAttempts?: number;
    toolPasses?: number;
    totalDurationMs?: number;
    agentDurationMs?: number;
    deterministicDurationMs?: number;
    firstLlmResponseMs?: number;
    firstCandidateMs?: number;
    finalResponseMs?: number;
    llmDurationMs: number;
    toolDurationMs: number;
    finalValidationDurationMs: number;
    llmTurns: number;
    toolCallCount: number;
    finalValidationCount: number;
    toolSequence: string[];
    toolCounts: Record<string, number>;
    maxSystemPromptChars: number;
    maxTotalMessageChars: number;
  };
};

const referenceInstant = process.env['TEMPORAL_EVAL_NOW'] ?? '2026-05-24T12:00:00Z';
const timeZone = process.env['TEMPORAL_EVAL_TZ'] ?? 'America/New_York';
const openaiApiKey = process.env['OPENAI_API_KEY'];
const requireEval = isTruthy(process.env['TEMPORAL_EVAL_REQUIRE_OPENAI']);
const modelSpecs = parseModelSpecs(process.env['TEMPORAL_EVAL_MODELS']);
const baselineSpecs = parseBaselineSpecs(process.env['TEMPORAL_EVAL_BASELINES']);
const outputPath = process.env['TEMPORAL_EVAL_OUTPUT'];
const limit = parsePositiveInt(process.env['TEMPORAL_EVAL_LIMIT']);
const repeats = parsePositiveInt(process.env['TEMPORAL_EVAL_REPEATS']) ?? 1;
const blockingRunners = splitList(process.env['TEMPORAL_EVAL_BLOCKING_RUNNERS'] ?? 'agent');

const SingleCallResponseSchema = z.object({
  status: z.enum(['resolved', 'needs_clarification', 'failed']),
  epoch: z.number().int().nullable(),
  suggestedFormatIndex: z.number().int().min(0).max(6).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  alternatives: z.array(z.object({
    label: z.string(),
    epoch: z.number().int(),
  })),
});

const evalCases: TemporalEvalCase[] = [
  {
    id: 'relative-date-default-noon',
    text: 'tomorrow',
    category: 'deterministic-baseline',
    expected: { status: 'resolved', epoch: 1779724800, suggestedFormatIndex: 1 },
  },
  {
    id: 'bare-hour-clarification',
    text: 'tom 430',
    category: 'clarification',
    expected: { status: 'needs_clarification', alternativeEpochs: [1779697800, 1779741000] },
  },
  {
    id: 'weekday-bare-hour-clarification',
    text: 'saturday at 3',
    category: 'clarification',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780124400, 1780167600] },
  },
  {
    id: 'anchor-offset-date',
    text: 'day after next saturday',
    category: 'agent-composition',
    expected: { status: 'resolved', epoch: 1780243200, suggestedFormatIndex: 6 },
  },
  {
    id: 'anchor-offset-clock',
    text: 'day after next saturday at 13:37',
    category: 'agent-composition',
    expected: { status: 'resolved', epoch: 1780249020, suggestedFormatIndex: 5 },
  },
  {
    id: 'anchor-offset-fuzzy-clock',
    text: 'day after next saturday at l33t time',
    category: 'fuzzy-clock',
    expected: { status: 'resolved', epoch: 1780249020, suggestedFormatIndex: 5 },
  },
  {
    id: 'weekday-fuzzy-clock',
    text: 'next saturday at l33t time',
    category: 'fuzzy-clock',
    expected: { status: 'resolved', epoch: 1780162620, suggestedFormatIndex: 5 },
  },
  {
    id: 'explicit-year-holiday',
    text: 'easter 2026 noon',
    category: 'holiday',
    expected: { status: 'resolved', epoch: 1775404800, suggestedFormatIndex: 4 },
  },
  {
    id: 'future-year-holiday',
    text: 'easter 2028',
    category: 'holiday',
    expected: { status: 'resolved', epoch: 1839513600, suggestedFormatIndex: 1 },
  },
  {
    id: 'next-weekday-boundary-sunday',
    text: 'next saturday 10pm',
    category: 'weekday-boundary-ambiguity',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780192800, 1780797600] },
    required: false,
  },
  {
    id: 'simple-weekday-shortcut-pressure',
    text: 'next tuesday',
    category: 'latency-shortcut-pressure',
    expected: { status: 'resolved', epoch: 1779811200, suggestedFormatIndex: 1 },
    required: false,
  },
  {
    id: 'event-post-text-start-end',
    text: 'Club night: Friday May 29, doors 8pm, main set 10:30pm',
    category: 'future-event-extraction-pressure',
    expected: { status: 'resolved', epoch: 1780108200, suggestedFormatIndex: 5 },
    required: false,
  },
];

async function main() {
  const runnerSpecs: EvalRunnerSpec[] = [...modelSpecs, ...baselineSpecs];
  if (runnerSpecs.length === 0) {
    if (requireEval) {
      throw new Error('TEMPORAL_EVAL_MODELS or TEMPORAL_EVAL_BASELINES is required when TEMPORAL_EVAL_REQUIRE_OPENAI=1.');
    }
    console.log('Skipping temporal model eval because TEMPORAL_EVAL_MODELS and TEMPORAL_EVAL_BASELINES are not configured.');
    return;
  }

  if (runnerSpecs.some((spec) => spec.runner !== 'deterministic') && openaiApiKey === undefined) {
    if (requireEval) {
      throw new Error('OPENAI_API_KEY is required when TEMPORAL_EVAL_REQUIRE_OPENAI=1.');
    }
    console.log('Skipping OpenAI temporal eval runners because OPENAI_API_KEY is not configured.');
  }

  const cases = limit === undefined ? evalCases : evalCases.slice(0, limit);
  const results: EvalResult[] = [];
  for (const modelSpec of runnerSpecs.filter((spec) => spec.runner === 'deterministic' || openaiApiKey !== undefined)) {
    for (const evalCase of cases) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        results.push(await runCase(modelSpec, evalCase, repeat));
      }
    }
  }

  printSummary(results);
  if (outputPath !== undefined) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ referenceInstant, timeZone, results }, null, 2)}\n`, 'utf8');
    console.log(`Wrote temporal eval results to ${outputPath}`);
  }

  if (results.some((result) => result.required && !result.passed && blockingRunners.includes(result.runner))) {
    process.exitCode = 1;
  }
}

async function runCase(modelSpec: EvalRunnerSpec, evalCase: TemporalEvalCase, repeat: number): Promise<EvalResult> {
  const startedAt = Date.now();
  try {
    const parsed = await runEvalRunner(modelSpec, evalCase.text);
    const mismatch = evaluateParsed(evalCase, parsed);
    return {
      runner: modelSpec.runner,
      model: modelSpec.model,
      provider: modelSpec.provider,
      reasoningEffort: modelSpec.reasoningEffort,
      caseId: evalCase.id,
      repeat,
      text: evalCase.text,
      category: evalCase.category,
      required: evalCase.required ?? true,
      passed: mismatch === undefined,
      durationMs: Date.now() - startedAt,
      status: parsed.status,
      epoch: parsed.epoch,
      suggestedFormatIndex: parsed.suggestedFormatIndex,
      confidence: parsed.confidence,
      method: parsed.method,
      mismatch,
      metrics: metricsFromResponse(parsed),
    };
  } catch (error) {
    return {
      runner: modelSpec.runner,
      model: modelSpec.model,
      provider: modelSpec.provider,
      reasoningEffort: modelSpec.reasoningEffort,
      caseId: evalCase.id,
      repeat,
      text: evalCase.text,
      category: evalCase.category,
      required: evalCase.required ?? true,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runEvalRunner(modelSpec: EvalRunnerSpec, text: string): Promise<EvalParsed> {
  if (modelSpec.runner === 'deterministic') {
    return parseTemporalExpression({ text, timeZone, referenceInstant });
  }

  if (modelSpec.runner === 'single_call') {
    return runSingleCallBaseline(modelSpec, text);
  }

  return parseTemporalExpression({
    text,
    timeZone,
    referenceInstant,
    openaiApiKey: openaiApiKey!,
    openaiModel: modelSpec.model,
    openaiReasoningEffort: modelSpec.reasoningEffort,
    langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
  });
}

async function runSingleCallBaseline(modelSpec: ModelSpec, text: string): Promise<EvalParsed> {
  const startedAt = Date.now();
  const system = `Convert natural language temporal text into one exact timestamp or an explicit clarification request.

Return JSON matching the requested schema only.
Use epoch seconds for all timestamps.
Reference instant: ${referenceInstant}
Time zone: ${timeZone}
Discord format indexes: 0 short date, 1 long date, 2 short time, 3 long time, 4 short date/time, 5 long date/time, 6 relative.
If AM/PM, "next weekday", or another phrase is materially ambiguous, return needs_clarification with alternatives.
Do not call tools. Do not explain outside the schema.`;
  const human = JSON.stringify({ text, referenceInstant, timeZone });
  const model = createChatModel(modelSpec.model, modelSpec.reasoningEffort).withStructuredOutput(SingleCallResponseSchema);
  const result = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const durationMs = Date.now() - startedAt;
  const parsed: EvalParsed = {
    status: result.status,
    confidence: result.confidence,
    method: 'single-call',
    debug: {
      model: modelSpec.model,
      reasoningEffort: modelSpec.reasoningEffort,
      totalDurationMs: durationMs,
      agentDurationMs: durationMs,
      firstLlmResponseMs: durationMs,
      finalResponseMs: durationMs,
      trace: [{
        index: 1,
        type: 'llm',
        name: 'single_call',
        durationMs,
        input: {
          messageCount: 2,
          systemPromptChars: system.length,
          totalMessageChars: system.length + human.length,
        },
        output: result,
      }],
    },
  };
  if (result.epoch !== null) {
    parsed.epoch = result.epoch;
  }
  if (result.suggestedFormatIndex !== null) {
    parsed.suggestedFormatIndex = result.suggestedFormatIndex;
  }
  if (result.status !== 'failed') {
    parsed.debug!.firstCandidateMs = durationMs;
  }
  if (result.alternatives.length > 0) {
    parsed.clarificationAlternatives = result.alternatives.map((alternative) => ({ epoch: alternative.epoch }));
  }
  return parsed;
}

function evaluateParsed(evalCase: TemporalEvalCase, parsed: EvalParsed): string | undefined {
  if (parsed.status !== evalCase.expected.status) {
    return `expected status ${evalCase.expected.status}, got ${parsed.status}`;
  }

  if (evalCase.expected.status === 'resolved') {
    if (parsed.epoch !== evalCase.expected.epoch) {
      return `expected epoch ${evalCase.expected.epoch}, got ${parsed.epoch ?? 'none'}`;
    }
    if (evalCase.expected.suggestedFormatIndex !== undefined && parsed.suggestedFormatIndex !== evalCase.expected.suggestedFormatIndex) {
      return `expected format ${evalCase.expected.suggestedFormatIndex}, got ${parsed.suggestedFormatIndex ?? 'none'}`;
    }
    return undefined;
  }

  const actual = [...(parsed.clarificationAlternatives ?? [])]
    .map((alternative) => alternative.epoch)
    .sort((a, b) => a - b);
  const expected = [...evalCase.expected.alternativeEpochs].sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return `expected alternatives ${expected.join(',')}, got ${actual.join(',') || 'none'}`;
  }
  return undefined;
}

function metricsFromResponse(parsed: EvalParsed): EvalResult['metrics'] {
  const trace = parsed.debug?.trace ?? [];
  const llmDurationMs = trace
    .filter((step) => step.type === 'llm')
    .reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const toolDurationMs = trace
    .filter((step) => step.type === 'tool')
    .reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const finalValidationDurationMs = trace
    .filter((step) => step.type === 'final_validation')
    .reduce((total, step) => total + (step.durationMs ?? 0), 0);
  const promptInputs = trace
    .filter((step) => step.type === 'llm')
    .map((step) => step.input)
    .filter(isPromptMetrics);
  const toolSequence = trace.filter((step) => step.type === 'tool').map((step) => step.name);
  const toolCounts = countBy(toolSequence);

  return {
    agentAttempts: parsed.debug?.agentAttempts,
    toolPasses: parsed.debug?.toolPasses,
    totalDurationMs: parsed.debug?.totalDurationMs,
    agentDurationMs: parsed.debug?.agentDurationMs,
    deterministicDurationMs: parsed.debug?.deterministicDurationMs,
    firstLlmResponseMs: parsed.debug?.firstLlmResponseMs,
    firstCandidateMs: parsed.debug?.firstCandidateMs,
    finalResponseMs: parsed.debug?.finalResponseMs,
    llmDurationMs,
    toolDurationMs,
    finalValidationDurationMs,
    llmTurns: trace.filter((step) => step.type === 'llm').length,
    toolCallCount: toolSequence.length,
    finalValidationCount: trace.filter((step) => step.type === 'final_validation').length,
    toolSequence,
    toolCounts,
    maxSystemPromptChars: Math.max(0, ...promptInputs.map((input) => input.systemPromptChars)),
    maxTotalMessageChars: Math.max(0, ...promptInputs.map((input) => input.totalMessageChars)),
  };
}

function isPromptMetrics(value: unknown): value is { systemPromptChars: number; totalMessageChars: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['systemPromptChars'] === 'number' && typeof record['totalMessageChars'] === 'number';
}

function printSummary(results: EvalResult[]) {
  for (const modelKey of unique(results.map((result) => `${result.runner}:${result.model}:${result.reasoningEffort}`))) {
    const modelResults = results.filter((result) => `${result.runner}:${result.model}:${result.reasoningEffort}` === modelKey);
    const firstResult = modelResults[0]!;
    const requiredResults = modelResults.filter((result) => result.required);
    const diagnosticResults = modelResults.filter((result) => !result.required);
    const passed = requiredResults.filter((result) => result.passed).length;
    const diagnosticPassed = diagnosticResults.filter((result) => result.passed).length;
    const durations = modelResults.map((result) => result.durationMs).sort((a, b) => a - b);
    const median = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);
    const maxPromptChars = Math.max(0, ...modelResults.map((result) => result.metrics?.maxTotalMessageChars ?? 0));
    const meanTools = mean(modelResults.map((result) => result.metrics?.toolCallCount ?? 0));
    const meanLlmTurns = mean(modelResults.map((result) => result.metrics?.llmTurns ?? 0));
    const meanFirstLlm = mean(modelResults.map((result) => result.metrics?.firstLlmResponseMs ?? 0));
    const diagnosticSummary = diagnosticResults.length > 0 ? `, diagnostics=${diagnosticPassed}/${diagnosticResults.length}` : '';
    console.log(`${firstResult.runner}/${firstResult.model}: required=${passed}/${requiredResults.length}${diagnosticSummary}, median=${median}ms, p95=${p95}ms, tools=${meanTools.toFixed(1)}, llmTurns=${meanLlmTurns.toFixed(1)}, firstLlm=${Math.round(meanFirstLlm)}ms, maxPromptChars=${maxPromptChars}`);
    for (const result of modelResults) {
      const status = result.required ? (result.passed ? 'PASS' : 'FAIL') : (result.passed ? 'DIAG-PASS' : 'DIAG');
      const detail = result.error ?? result.mismatch ?? `${result.status} epoch=${result.epoch ?? 'none'}`;
      const repeatSuffix = repeats > 1 ? `#${result.repeat}` : '';
      console.log(`  ${status} ${result.caseId}${repeatSuffix}: ${detail} (${result.durationMs}ms)`);
    }
  }
}

function parseModelSpecs(value: string | undefined): ModelSpec[] {
  return splitList(value).map((entry) => {
    const [model, reasoningEffort] = entry.split(':');
    return {
      runner: 'agent',
      provider: 'openai',
      model: model ?? entry,
      reasoningEffort: reasoningEffort ?? process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
    };
  });
}

function parseBaselineSpecs(value: string | undefined): EvalRunnerSpec[] {
  return splitList(value).map((entry) => {
    if (entry === 'deterministic') {
      return { runner: 'deterministic', provider: 'local', model: 'deterministic', reasoningEffort: 'none' };
    }

    const [kind, model, reasoningEffort] = entry.split(':');
    if ((kind === 'single' || kind === 'single-call') && model !== undefined && model.length > 0) {
      return {
        runner: 'single_call',
        provider: 'openai',
        model,
        reasoningEffort: reasoningEffort ?? process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
      };
    }

    throw new Error(`Unknown TEMPORAL_EVAL_BASELINES entry: ${entry}`);
  });
}

function createChatModel(model: string, reasoningEffort: string): ChatOpenAI {
  if (model.startsWith('gpt-5')) {
    return new ChatOpenAI({ apiKey: openaiApiKey!, model, reasoning: { effort: normalizeReasoningEffort(reasoningEffort), summary: 'auto' }, useResponsesApi: true });
  }
  return new ChatOpenAI({ apiKey: openaiApiKey!, model, temperature: 0 });
}

function normalizeReasoningEffort(effort: string): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'none' || effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  return 'low';
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index] ?? 0;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
