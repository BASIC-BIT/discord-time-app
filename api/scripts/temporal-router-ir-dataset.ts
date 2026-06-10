import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { TemporalRouterIrSchema, type TemporalRouterIr, type TemporalRouterReasonCode } from '../src/temporal/router-ir';

type RouterTrainingRow = {
  id: string;
  input: {
    text: string;
    referenceInstant: string;
    timeZone: string;
  };
  output: TemporalRouterIr;
  evidence: {
    category: string;
    required: boolean;
    deterministic: RunnerEvidence;
    local: RunnerEvidence;
    sourceReports: string[];
  };
};

type RunnerEvidence = {
  count: number;
  passed: number;
  failed: number;
  statuses: string[];
  mismatches: string[];
  errors: string[];
  models: string[];
};

const EvalResultSchema = z.object({
  runner: z.string(),
  model: z.string(),
  caseId: z.string(),
  text: z.string(),
  category: z.string().optional(),
  required: z.boolean().optional(),
  passed: z.boolean(),
  status: z.string().optional(),
  mismatch: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const EvalReportSchema = z.object({
  referenceInstant: z.string(),
  timeZone: z.string(),
  results: z.array(EvalResultSchema),
}).passthrough();

type EvalResult = z.infer<typeof EvalResultSchema>;

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultEvalInput = join(apiRoot, 'reports', 'temporal-ml', 'temporal-trained-expanded-bounded-minimal-current-repeat-1-eval.json');
const defaultOutput = join(apiRoot, 'reports', 'temporal-ml', 'temporal-router-ir-rows.jsonl');
const evalInputPaths = splitList(process.env['TEMPORAL_ROUTER_EVAL_INPUTS'] ?? defaultEvalInput).map(resolveApiPath);
const outputPath = resolveApiPath(process.env['TEMPORAL_ROUTER_OUTPUT'] ?? defaultOutput);
const localRunners = new Set(splitList(process.env['TEMPORAL_ROUTER_LOCAL_RUNNERS'] ?? 'trained_plan,endpoint_plan'));
const deterministicRunner = process.env['TEMPORAL_ROUTER_DETERMINISTIC_RUNNER'] ?? 'deterministic';

async function main() {
  const loaded = await Promise.all(evalInputPaths.map(loadReport));
  const groups = new Map<string, { referenceInstant: string; timeZone: string; sourceReports: Set<string>; results: EvalResult[] }>();

  for (const report of loaded) {
    for (const result of report.results) {
      const existing = groups.get(result.caseId);
      if (existing === undefined) {
        groups.set(result.caseId, {
          referenceInstant: report.referenceInstant,
          timeZone: report.timeZone,
          sourceReports: new Set([report.sourcePath]),
          results: [result],
        });
      } else {
        existing.sourceReports.add(report.sourcePath);
        existing.results.push(result);
      }
    }
  }

  const rows = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, group]) => buildRouterRow(caseId, group));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const routeCounts = countBy(rows.map((row) => row.output.route));
  console.log(`Wrote ${rows.length} Temporal Router-IR rows to ${outputPath}`);
  console.log(`Routes: deterministic_only=${routeCounts.deterministic_only ?? 0}, local_plan=${routeCounts.local_plan ?? 0}, clarify=${routeCounts.clarify ?? 0}, escalate_llm=${routeCounts.escalate_llm ?? 0}`);
}

async function loadReport(path: string) {
  const parsed = EvalReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return { ...parsed, sourcePath: path };
}

function buildRouterRow(
  caseId: string,
  group: { referenceInstant: string; timeZone: string; sourceReports: Set<string>; results: EvalResult[] },
): RouterTrainingRow {
  const first = group.results[0];
  if (first === undefined) {
    throw new Error(`No eval results for ${caseId}`);
  }

  const deterministic = group.results.filter((result) => result.runner === deterministicRunner);
  const local = group.results.filter((result) => localRunners.has(result.runner));
  const output = deriveRouterOutput(deterministic, local);
  const row: RouterTrainingRow = {
    id: caseId,
    input: {
      text: first.text,
      referenceInstant: group.referenceInstant,
      timeZone: group.timeZone,
    },
    output,
    evidence: {
      category: first.category ?? 'unknown',
      required: first.required ?? true,
      deterministic: summarizeRunner(deterministic),
      local: summarizeRunner(local),
      sourceReports: [...group.sourceReports].sort(),
    },
  };
  TemporalRouterIrSchema.parse(row.output);
  return row;
}

function deriveRouterOutput(deterministic: EvalResult[], local: EvalResult[]): TemporalRouterIr {
  const deterministicStable = deterministic.length > 0 && deterministic.every((result) => result.passed);
  const localStable = local.length > 0 && local.every((result) => result.passed);
  const localHasFailures = local.some((result) => !result.passed);
  const anyPassedClarification = [...deterministic, ...local].some((result) => result.passed && result.status === 'needs_clarification');
  const anyAcceptedFailure = [...deterministic, ...local].some((result) => result.passed && result.status === 'failed');

  if (anyPassedClarification) {
    return routerOutput('clarify', 0.92, ['clarification_required'], 'Executor-backed eval expects a clarification path.');
  }

  if (deterministicStable) {
    const reasonCodes: TemporalRouterReasonCode[] = ['deterministic_passed'];
    if (anyAcceptedFailure) {
      reasonCodes.push('accepted_failure_status');
    }
    return routerOutput('deterministic_only', 0.95, reasonCodes, 'Deterministic parser already passed every available eval repeat.');
  }

  if (localStable) {
    const reasonCodes: TemporalRouterReasonCode[] = ['local_plan_passed'];
    if (anyAcceptedFailure) {
      reasonCodes.push('accepted_failure_status');
    }
    return routerOutput('local_plan', 0.9, reasonCodes, 'Local Plan-IR model passed every available eval repeat.');
  }

  if (local.length === 0) {
    return routerOutput('escalate_llm', 0.72, ['missing_local_eval'], 'No local Plan-IR eval result is available for this case.');
  }

  if (localHasFailures && local.some((result) => result.passed)) {
    return routerOutput('escalate_llm', 0.82, ['local_plan_unstable', 'wrong_singular_risk'], 'Local Plan-IR results are mixed, so fallback is safer than a singular answer.');
  }

  return routerOutput('escalate_llm', 0.88, ['local_plan_failed', 'wrong_singular_risk'], 'Local Plan-IR did not pass executor-backed eval, so use the stronger path.');
}

function routerOutput(route: TemporalRouterIr['route'], confidence: number, reasonCodes: TemporalRouterReasonCode[], reason: string): TemporalRouterIr {
  return TemporalRouterIrSchema.parse({ route, confidence, reasonCodes: unique(reasonCodes), reason });
}

function summarizeRunner(results: EvalResult[]): RunnerEvidence {
  return {
    count: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    statuses: unique(results.map((result) => result.status ?? 'unknown')),
    mismatches: unique(results.map((result) => result.mismatch).filter(isDefined)),
    errors: unique(results.map((result) => result.error).filter(isDefined)),
    models: unique(results.map((result) => result.model)),
  };
}

function resolveApiPath(path: string): string {
  return isAbsolute(path) ? path : join(apiRoot, path);
}

function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
