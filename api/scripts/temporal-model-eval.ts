import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  provider: 'openai';
  model: string;
  reasoningEffort: string;
};

type EvalResult = {
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
    maxSystemPromptChars: number;
    maxTotalMessageChars: number;
  };
};

const referenceInstant = process.env['TEMPORAL_EVAL_NOW'] ?? '2026-05-24T12:00:00Z';
const timeZone = process.env['TEMPORAL_EVAL_TZ'] ?? 'America/New_York';
const openaiApiKey = process.env['OPENAI_API_KEY'];
const requireEval = isTruthy(process.env['TEMPORAL_EVAL_REQUIRE_OPENAI']);
const modelSpecs = parseModelSpecs(process.env['TEMPORAL_EVAL_MODELS']);
const outputPath = process.env['TEMPORAL_EVAL_OUTPUT'];
const limit = parsePositiveInt(process.env['TEMPORAL_EVAL_LIMIT']);
const repeats = parsePositiveInt(process.env['TEMPORAL_EVAL_REPEATS']) ?? 1;

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
    id: 'next-weekday-boundary-sunday',
    text: 'next saturday 10pm',
    category: 'weekday-boundary-ambiguity',
    expected: { status: 'needs_clarification', alternativeEpochs: [1780192800, 1780797600] },
    required: false,
  },
];

async function main() {
  if (modelSpecs.length === 0) {
    if (requireEval) {
      throw new Error('TEMPORAL_EVAL_MODELS is required when TEMPORAL_EVAL_REQUIRE_OPENAI=1.');
    }
    console.log('Skipping temporal model eval because TEMPORAL_EVAL_MODELS is not configured.');
    return;
  }

  if (openaiApiKey === undefined) {
    if (requireEval) {
      throw new Error('OPENAI_API_KEY is required when TEMPORAL_EVAL_REQUIRE_OPENAI=1.');
    }
    console.log('Skipping temporal model eval because OPENAI_API_KEY is not configured.');
    return;
  }

  const cases = limit === undefined ? evalCases : evalCases.slice(0, limit);
  const results: EvalResult[] = [];
  for (const modelSpec of modelSpecs) {
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

  if (results.some((result) => result.required && !result.passed)) {
    process.exitCode = 1;
  }
}

async function runCase(modelSpec: ModelSpec, evalCase: TemporalEvalCase, repeat: number): Promise<EvalResult> {
  const startedAt = Date.now();
  try {
    const parsed = await parseTemporalExpression({
      text: evalCase.text,
      timeZone,
      referenceInstant,
      openaiApiKey: openaiApiKey!,
      openaiModel: modelSpec.model,
      openaiReasoningEffort: modelSpec.reasoningEffort,
      langfuse: { enabled: isTruthy(process.env['LANGFUSE_ENABLED']) },
    });
    const mismatch = evaluateParsed(evalCase, parsed);
    return {
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

function evaluateParsed(evalCase: TemporalEvalCase, parsed: TemporalParseResponse): string | undefined {
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

function metricsFromResponse(parsed: TemporalParseResponse): EvalResult['metrics'] {
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
  for (const model of unique(results.map((result) => result.model))) {
    const modelResults = results.filter((result) => result.model === model);
    const requiredResults = modelResults.filter((result) => result.required);
    const diagnosticResults = modelResults.filter((result) => !result.required);
    const passed = requiredResults.filter((result) => result.passed).length;
    const diagnosticPassed = diagnosticResults.filter((result) => result.passed).length;
    const durations = modelResults.map((result) => result.durationMs).sort((a, b) => a - b);
    const median = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);
    const maxPromptChars = Math.max(0, ...modelResults.map((result) => result.metrics?.maxTotalMessageChars ?? 0));
    const diagnosticSummary = diagnosticResults.length > 0 ? `, diagnostics=${diagnosticPassed}/${diagnosticResults.length}` : '';
    console.log(`${model}: required=${passed}/${requiredResults.length}${diagnosticSummary}, median=${median}ms, p95=${p95}ms, maxPromptChars=${maxPromptChars}`);
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
      provider: 'openai',
      model: model ?? entry,
      reasoningEffort: reasoningEffort ?? process.env['OPENAI_REASONING_EFFORT'] ?? 'low',
    };
  });
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
