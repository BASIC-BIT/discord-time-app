import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { TemporalRouterIrSchema, type TemporalRouterIr, type TemporalRouterRoute } from '../src/temporal/router-ir';

type RouteSource = 'labels' | 'predictions' | 'oracle';
type SelectedResult = {
  runner: string;
  model: string;
  passed: boolean;
  status?: string;
  mismatch?: string;
  error?: string;
  latencyMs?: number;
};

type CascadeCaseResult = {
  caseId: string;
  text: string;
  category: string;
  required: boolean;
  routeSource: RouteSource;
  route: TemporalRouterRoute;
  confidence: number;
  reasonCodes: string[];
  expectedRoute?: TemporalRouterRoute;
  routeMatchesLabel?: boolean;
  selected?: SelectedResult;
  knownScored: boolean;
  knownPassed: boolean;
  assumedPassed: boolean;
  missingStrongEvidence: boolean;
  wrongSingularAnswerRisk: boolean;
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
  durationMs: z.number().optional(),
  metrics: z.object({
    firstCorrectDisplayMs: z.number().optional(),
    finalResponseMs: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

const EvalReportSchema = z.object({
  referenceInstant: z.string(),
  timeZone: z.string(),
  results: z.array(EvalResultSchema),
}).passthrough();

const RouterRowSchema = z.object({
  id: z.string(),
  input: z.object({
    text: z.string(),
    referenceInstant: z.string(),
    timeZone: z.string(),
  }).passthrough(),
  output: TemporalRouterIrSchema,
  evidence: z.object({
    category: z.string().optional(),
    required: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

const RouterPredictionRowSchema = z.object({
  id: z.string().optional(),
  caseId: z.string().optional(),
  predicted: z.unknown(),
}).passthrough();

type EvalResult = z.infer<typeof EvalResultSchema>;
type EvalReport = z.infer<typeof EvalReportSchema> & { sourcePath: string };
type RouterRow = z.infer<typeof RouterRowSchema>;
type RouterPredictionRow = z.infer<typeof RouterPredictionRowSchema>;

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultEvalInputs = [
  'reports/temporal-ml/temporal-deterministic-expanded-eval.json',
  'reports/temporal-ml/temporal-trained-expanded-bounded-minimal-current-repeat-1-eval.json',
].join(',');
const evalInputPaths = splitList(process.env['TEMPORAL_CASCADE_EVAL_INPUTS'] ?? defaultEvalInputs).map(resolveApiPath);
const routerRowsPath = resolveOptionalApiPath(process.env['TEMPORAL_CASCADE_ROUTER_ROWS'] ?? 'reports/temporal-ml/temporal-router-ir-current-rows.jsonl');
const routerPredictionsPath = resolveOptionalApiPath(process.env['TEMPORAL_CASCADE_ROUTER_PREDICTIONS']);
const outputPath = resolveApiPath(process.env['TEMPORAL_CASCADE_OUTPUT'] ?? 'reports/temporal-ml/temporal-cascade-current-eval.json');
const routeSource = parseRouteSource(process.env['TEMPORAL_CASCADE_ROUTE_SOURCE'] ?? (routerPredictionsPath === undefined ? 'labels' : 'predictions'));
const deterministicRunner = process.env['TEMPORAL_CASCADE_DETERMINISTIC_RUNNER'] ?? 'deterministic';
const localRunners = new Set(splitList(process.env['TEMPORAL_CASCADE_LOCAL_RUNNERS'] ?? 'trained_plan,endpoint_plan'));
const strongRunners = new Set(splitList(process.env['TEMPORAL_CASCADE_STRONG_RUNNERS'] ?? 'agent,single_call'));
const assumeMissingEscalationPass = parseBoolean(process.env['TEMPORAL_CASCADE_ASSUME_MISSING_ESCALATION_PASS'] ?? '1');

async function main() {
  const reports = await Promise.all(evalInputPaths.map(loadEvalReport));
  const routerRows = routerRowsPath === undefined ? new Map<string, RouterRow>() : await loadRouterRows(routerRowsPath);
  const routerPredictions = routerPredictionsPath === undefined ? new Map<string, TemporalRouterIr>() : await loadRouterPredictions(routerPredictionsPath);
  const groupedResults = groupEvalResults(reports);
  const caseIds = unique([...groupedResults.keys(), ...routerRows.keys(), ...routerPredictions.keys()]).sort();
  const results = caseIds.map((caseId) => scoreCase(caseId, groupedResults, routerRows, routerPredictions));
  const summary = summarize(results);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    routeSource,
    assumeMissingEscalationPass,
    evalInputs: evalInputPaths,
    routerRows: routerRowsPath,
    routerPredictions: routerPredictionsPath,
    summary,
    results,
  }, null, 2)}\n`, 'utf8');

  printSummary(summary, outputPath);
}

async function loadEvalReport(path: string): Promise<EvalReport> {
  const parsed = EvalReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return { ...parsed, sourcePath: path };
}

async function loadRouterRows(path: string): Promise<Map<string, RouterRow>> {
  const rows = new Map<string, RouterRow>();
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const row = RouterRowSchema.parse(JSON.parse(line));
    rows.set(row.id, row);
  }
  return rows;
}

async function loadRouterPredictions(path: string): Promise<Map<string, TemporalRouterIr>> {
  const rows = new Map<string, TemporalRouterIr>();
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const row = RouterPredictionRowSchema.parse(JSON.parse(line));
    const caseId = row.caseId ?? row.id;
    if (caseId === undefined) {
      throw new Error(`Router prediction row is missing id/caseId: ${line.slice(0, 200)}`);
    }
    rows.set(caseId, parsePredictedRouterIr(row.predicted));
  }
  return rows;
}

function groupEvalResults(reports: EvalReport[]): Map<string, EvalResult[]> {
  const grouped = new Map<string, EvalResult[]>();
  for (const report of reports) {
    for (const result of report.results) {
      const existing = grouped.get(result.caseId);
      if (existing === undefined) {
        grouped.set(result.caseId, [result]);
      } else {
        existing.push(result);
      }
    }
  }
  return grouped;
}

function scoreCase(
  caseId: string,
  groupedResults: Map<string, EvalResult[]>,
  routerRows: Map<string, RouterRow>,
  routerPredictions: Map<string, TemporalRouterIr>,
): CascadeCaseResult {
  const evalResults = groupedResults.get(caseId) ?? [];
  const label = routerRows.get(caseId)?.output;
  const first = evalResults[0];
  const route = routeForCase(caseId, evalResults, label, routerPredictions);
  const selected = selectForRoute(route.route, evalResults);
  const missingStrongEvidence = route.route === 'escalate_llm' && selected === undefined;
  const knownScored = selected !== undefined;
  const knownPassed = selected?.passed ?? false;
  const assumedPassed = knownPassed || (missingStrongEvidence && assumeMissingEscalationPass);

  return {
    caseId,
    text: first?.text ?? routerRows.get(caseId)?.input.text ?? '',
    category: first?.category ?? routerRows.get(caseId)?.evidence?.category ?? 'unknown',
    required: first?.required ?? routerRows.get(caseId)?.evidence?.required ?? true,
    routeSource,
    route: route.route,
    confidence: route.confidence,
    reasonCodes: route.reasonCodes,
    expectedRoute: label?.route,
    routeMatchesLabel: label === undefined ? undefined : route.route === label.route,
    selected,
    knownScored,
    knownPassed,
    assumedPassed,
    missingStrongEvidence,
    wrongSingularAnswerRisk: selected === undefined ? false : isWrongSingularAnswerRisk(selected),
  };
}

function routeForCase(caseId: string, evalResults: EvalResult[], label: TemporalRouterIr | undefined, predictions: Map<string, TemporalRouterIr>): TemporalRouterIr {
  if (routeSource === 'labels') {
    if (label === undefined) {
      return fallbackRoute('missing label');
    }
    return label;
  }

  if (routeSource === 'predictions') {
    return predictions.get(caseId) ?? fallbackRoute('missing prediction');
  }

  return deriveOracleRoute(evalResults);
}

function fallbackRoute(reason: string): TemporalRouterIr {
  return TemporalRouterIrSchema.parse({
    route: 'escalate_llm',
    confidence: 0.5,
    reasonCodes: ['missing_local_eval'],
    reason: `Cascade router fallback: ${reason}.`,
  });
}

function deriveOracleRoute(evalResults: EvalResult[]): TemporalRouterIr {
  if (evalResults.some((result) => result.passed && result.status === 'needs_clarification')) {
    return TemporalRouterIrSchema.parse({ route: 'clarify', confidence: 1, reasonCodes: ['clarification_required'], reason: 'Oracle route selected a passing clarification path.' });
  }
  if (stablePassing(evalResults.filter((result) => result.runner === deterministicRunner))) {
    return TemporalRouterIrSchema.parse({ route: 'deterministic_only', confidence: 1, reasonCodes: ['deterministic_passed'], reason: 'Oracle route selected deterministic parsing.' });
  }
  if (stablePassing(evalResults.filter((result) => localRunners.has(result.runner)))) {
    return TemporalRouterIrSchema.parse({ route: 'local_plan', confidence: 1, reasonCodes: ['local_plan_passed'], reason: 'Oracle route selected local Plan-IR.' });
  }
  return TemporalRouterIrSchema.parse({ route: 'escalate_llm', confidence: 1, reasonCodes: ['wrong_singular_risk'], reason: 'Oracle route selected escalation because no local path is stable and passing.' });
}

function selectForRoute(route: TemporalRouterRoute, evalResults: EvalResult[]): SelectedResult | undefined {
  if (route === 'clarify') {
    return selectBest(evalResults.filter((result) => result.passed && result.status === 'needs_clarification'));
  }
  if (route === 'deterministic_only') {
    return selectPreferred(evalResults.filter((result) => result.runner === deterministicRunner));
  }
  if (route === 'local_plan') {
    return selectPreferred(evalResults.filter((result) => localRunners.has(result.runner)));
  }
  return selectPreferred(evalResults.filter((result) => strongRunners.has(result.runner)));
}

function selectPreferred(results: EvalResult[]): SelectedResult | undefined {
  const groups = groupBy(results, (result) => `${result.runner}:${result.model}`);
  const stablePass = [...groups.values()].find((group) => stablePassing(group));
  return selectBest(stablePass ?? results);
}

function selectBest(results: EvalResult[]): SelectedResult | undefined {
  if (results.length === 0) {
    return undefined;
  }
  const sorted = [...results].sort((left, right) => {
    if (left.passed !== right.passed) {
      return left.passed ? -1 : 1;
    }
    return latencyForResult(left) - latencyForResult(right);
  });
  const result = sorted[0]!;
  return {
    runner: result.runner,
    model: result.model,
    passed: result.passed,
    status: result.status,
    mismatch: result.mismatch,
    error: result.error,
    latencyMs: latencyForResult(result),
  };
}

function stablePassing(results: EvalResult[]): boolean {
  return results.length > 0 && results.every((result) => result.passed);
}

function isWrongSingularAnswerRisk(selected: SelectedResult): boolean {
  return !selected.passed && selected.status === 'resolved' && (selected.mismatch ?? '').includes('expected status needs_clarification');
}

function parsePredictedRouterIr(value: unknown): TemporalRouterIr {
  if (typeof value === 'string') {
    return TemporalRouterIrSchema.parse(JSON.parse(value));
  }
  return TemporalRouterIrSchema.parse(value);
}

function summarize(results: CascadeCaseResult[]) {
  const required = results.filter((result) => result.required);
  const knownScored = required.filter((result) => result.knownScored);
  const assumedPassed = required.filter((result) => result.assumedPassed);
  const localAccepted = required.filter((result) => result.route === 'deterministic_only' || result.route === 'local_plan');
  const localAcceptedKnown = localAccepted.filter((result) => result.knownScored);
  const routeCounts = countBy(required.map((result) => result.route));
  const latencies = required.map((result) => result.selected?.latencyMs).filter(isDefined).sort((a, b) => a - b);
  const routeMatches = required.map((result) => result.routeMatchesLabel).filter(isDefined);

  return {
    total: required.length,
    routeCounts,
    knownScored: knownScored.length,
    knownPassed: knownScored.filter((result) => result.knownPassed).length,
    knownAccuracy: ratio(knownScored.filter((result) => result.knownPassed).length, knownScored.length),
    assumedPassed: assumedPassed.length,
    assumedAccuracy: ratio(assumedPassed.length, required.length),
    missingStrongEvidence: required.filter((result) => result.missingStrongEvidence).length,
    escalationRate: ratio(routeCounts.escalate_llm ?? 0, required.length),
    clarificationRate: ratio(routeCounts.clarify ?? 0, required.length),
    localAcceptanceRate: ratio(localAccepted.length, required.length),
    localAcceptedKnown: localAcceptedKnown.length,
    localAcceptedPassed: localAcceptedKnown.filter((result) => result.knownPassed).length,
    localAcceptedPrecision: ratio(localAcceptedKnown.filter((result) => result.knownPassed).length, localAcceptedKnown.length),
    wrongSingularAnswerRisks: required.filter((result) => result.wrongSingularAnswerRisk).length,
    routeDecisionAccuracy: ratio(routeMatches.filter(Boolean).length, routeMatches.length),
    latencyMedianMs: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

function printSummary(summary: ReturnType<typeof summarize>, path: string) {
  console.log(`Cascade route source: ${routeSource}`);
  console.log(`Routes: deterministic_only=${summary.routeCounts.deterministic_only ?? 0}, local_plan=${summary.routeCounts.local_plan ?? 0}, clarify=${summary.routeCounts.clarify ?? 0}, escalate_llm=${summary.routeCounts.escalate_llm ?? 0}`);
  console.log(`Known scored: ${summary.knownPassed}/${summary.knownScored} (${formatRatio(summary.knownAccuracy)})`);
  console.log(`Assumed product score: ${summary.assumedPassed}/${summary.total} (${formatRatio(summary.assumedAccuracy)}), missingStrongEvidence=${summary.missingStrongEvidence}`);
  console.log(`Local accepted precision: ${summary.localAcceptedPassed}/${summary.localAcceptedKnown} (${formatRatio(summary.localAcceptedPrecision)}), localAcceptance=${formatRatio(summary.localAcceptanceRate)}, escalation=${formatRatio(summary.escalationRate)}, clarify=${formatRatio(summary.clarificationRate)}`);
  console.log(`Wrong singular risks: ${summary.wrongSingularAnswerRisks}, routeDecisionAccuracy=${formatRatio(summary.routeDecisionAccuracy)}, latencyMedian=${formatMs(summary.latencyMedianMs)}, latencyP95=${formatMs(summary.latencyP95Ms)}`);
  console.log(`Wrote cascade eval results to ${path}`);
}

function latencyForResult(result: EvalResult): number {
  return result.metrics?.firstCorrectDisplayMs ?? result.metrics?.finalResponseMs ?? result.durationMs ?? 0;
}

function resolveApiPath(path: string): string {
  return isAbsolute(path) ? path : join(apiRoot, path);
}

function resolveOptionalApiPath(path: string | undefined): string | undefined {
  return path === undefined || path.trim().length === 0 ? undefined : resolveApiPath(path);
}

function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseRouteSource(value: string): RouteSource {
  if (value === 'labels' || value === 'predictions' || value === 'oracle') {
    return value;
  }
  throw new Error(`TEMPORAL_CASCADE_ROUTE_SOURCE must be labels, predictions, or oracle. Got: ${value}`);
}

function parseBoolean(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function groupBy<T>(values: T[], keyForValue: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyForValue(value);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [value]);
    } else {
      existing.push(value);
    }
  }
  return groups;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return values[index];
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${Math.round(value)}ms`;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
