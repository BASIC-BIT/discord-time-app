import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TemporalPlanPlannerSchema, type TemporalPlanPlannerOutput, type TemporalPlan, type TemporalPlanStep } from '../src/temporal/plan-ir';

type TemporalIrTrainingRow = {
  id: string;
  split?: string;
  input: {
    text: string;
    referenceInstant: string;
    timeZone: string;
  };
  output: TemporalPlanPlannerOutput;
};

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultInput = join(apiRoot, 'reports', 'temporal-ml', 'temporal-ir-expanded.jsonl');
const defaultOutput = join(apiRoot, 'reports', 'temporal-ml', 'temporal-openai-finetune.jsonl');
const inputPath = resolveApiPath(process.env['TEMPORAL_OPENAI_FINETUNE_INPUT'] ?? defaultInput);
const outputPath = resolveApiPath(process.env['TEMPORAL_OPENAI_FINETUNE_OUTPUT'] ?? defaultOutput);
const splitFilter = splitList(process.env['TEMPORAL_OPENAI_FINETUNE_SPLITS'] ?? 'train,validation');
const limit = parseNonNegativeInt(process.env['TEMPORAL_OPENAI_FINETUNE_LIMIT']) ?? 0;

const instruction = 'Translate the temporal user input into compact Temporal Plan-IR JSON. Return JSON only.';

async function main() {
  let rows = loadRows(await readFile(inputPath, 'utf8'));
  if (splitFilter.length > 0) {
    rows = rows.filter((row) => splitFilter.includes(row.split ?? 'train'));
  }
  if (limit > 0) {
    rows = rows.slice(0, limit);
  }
  if (rows.length < 10) {
    throw new Error(`OpenAI fine-tuning requires at least 10 examples; export would contain ${rows.length}.`);
  }

  const outputRows = rows.map((row) => ({
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: JSON.stringify(row.input, Object.keys(row.input).sort()) },
      { role: 'assistant', content: JSON.stringify(compactPlannerOutput(row.output)) },
    ],
  }));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${outputRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  console.log(`Wrote ${outputRows.length} OpenAI fine-tune rows to ${outputPath}`);
  console.log('Upload manually only after confirming fine-tuning access and cost.');
}

function loadRows(contents: string): TemporalIrTrainingRow[] {
  const rows: TemporalIrTrainingRow[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as TemporalIrTrainingRow;
    rows.push({ ...parsed, output: TemporalPlanPlannerSchema.parse(parsed.output) });
  }
  if (rows.length === 0) {
    throw new Error(`No rows found in ${inputPath}`);
  }
  return rows;
}

function compactPlannerOutput(output: TemporalPlanPlannerOutput) {
  const compact: Record<string, unknown> = {
    outcome: output.outcome,
    reason: output.reason,
    plans: output.plans.map(compactPlan),
  };
  if (output.clarificationQuestion !== null) {
    compact.clarificationQuestion = output.clarificationQuestion;
  }
  return compact;
}

function compactPlan(plan: TemporalPlan) {
  const compact: Record<string, unknown> = {
    label: plan.label,
    steps: plan.steps.map(compactStep),
  };
  if (plan.rationale.length > 0 && plan.rationale !== plan.label) {
    compact.rationale = plan.rationale;
  }
  if (plan.assumptions.length > 0) {
    compact.assumptions = plan.assumptions;
  }
  if (plan.confidence !== 0.8) {
    compact.confidence = plan.confidence;
  }
  if (plan.finalStep !== null) {
    compact.finalStep = plan.finalStep;
  }
  return compact;
}

function compactStep(step: TemporalPlanStep) {
  const compact: Record<string, unknown> = { op: step.operation };
  for (const key of ['query', 'text', 'holidayName', 'weekday', 'weekdayAnchor', 'year', 'baseStep', 'time', 'timeStep', 'isoInstant', 'epochSeconds', 'timeZone', 'precision'] as const) {
    if (step[key] !== null) {
      compact[key] = step[key];
    }
  }
  const delta = Object.fromEntries(Object.entries(step.delta).filter(([, value]) => value !== null));
  if (Object.keys(delta).length > 0) {
    compact.delta = delta;
  }
  if (step.assumptions.length > 0) {
    compact.assumptions = step.assumptions;
  }
  return compact;
}

function resolveApiPath(path: string): string {
  return isAbsolute(path) ? path : join(apiRoot, path);
}

function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, got ${value}`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
