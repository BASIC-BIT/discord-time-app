import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type EvalFile = {
  referenceInstant?: string;
  timeZone?: string;
  results: EvalResult[];
};

type EvalResult = {
  experimentLabel?: string;
  featureFlags?: Record<string, boolean>;
  runner?: string;
  model: string;
  provider: string;
  reasoningEffort: string;
  caseId: string;
  repeat?: number;
  text: string;
  category: string;
  required?: boolean;
  passed: boolean;
  durationMs: number;
  status?: string;
  epoch?: number;
  suggestedFormatIndex?: number;
  confidence?: number;
  method?: string;
  error?: string;
  mismatch?: string;
  metrics?: EvalMetrics;
};

type EvalMetrics = {
  agentAttempts?: number;
  toolPasses?: number;
  totalDurationMs?: number;
  agentDurationMs?: number;
  deterministicDurationMs?: number;
  firstLlmResponseMs?: number;
  firstCandidateMs?: number;
  firstCorrectDisplayMs?: number;
  finalResponseMs?: number;
  llmDurationMs?: number;
  toolDurationMs?: number;
  finalValidationDurationMs?: number;
  llmTurns?: number;
  toolCallCount?: number;
  finalValidationCount?: number;
  toolSequence?: string[];
  toolCounts?: Record<string, number>;
  maxSystemPromptChars?: number;
  maxTotalMessageChars?: number;
};

type ModelSummary = {
  key: string;
  experimentLabel: string;
  featureFlags: Record<string, boolean>;
  runner: string;
  model: string;
  provider: string;
  reasoningEffort: string;
  requiredPassed: number;
  requiredTotal: number;
  diagnosticPassed: number;
  diagnosticTotal: number;
  requiredPassRate: number;
  medianDurationMs: number;
  medianFirstCorrectDisplayMs?: number;
  p95FirstCorrectDisplayMs?: number;
  p75DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  meanFirstLlmMs: number;
  meanFirstCandidateMs: number;
  meanFinalResponseMs: number;
  meanLlmTurns: number;
  meanToolCalls: number;
  meanFinalValidationMs: number;
  maxPromptChars: number;
  topTools: Array<{ name: string; count: number }>;
  topSequences: Array<{ sequence: string; count: number }>;
};

const inputPath = process.env['TEMPORAL_EVAL_INPUT'] ?? process.env['TEMPORAL_EVAL_OUTPUT'];
const reportPath = process.env['TEMPORAL_EVAL_REPORT'] ?? 'reports/temporal-eval.html';
const summaryPath = process.env['TEMPORAL_EVAL_SUMMARY'];

async function main() {
  if (inputPath === undefined || inputPath.trim() === '') {
    throw new Error('Set TEMPORAL_EVAL_INPUT or TEMPORAL_EVAL_OUTPUT to an eval JSON file.');
  }

  const evalFile = JSON.parse(await readFile(inputPath, 'utf8')) as EvalFile;
  if (!Array.isArray(evalFile.results) || evalFile.results.length === 0) {
    throw new Error(`No eval results found in ${inputPath}.`);
  }

  const summaries = summarizeByModel(evalFile.results);
  const html = renderHtml(evalFile, summaries);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, html, 'utf8');
  console.log(`Wrote temporal eval report to ${reportPath}`);

  if (summaryPath !== undefined && summaryPath.trim() !== '') {
    await mkdir(dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, `${JSON.stringify({ summaries }, null, 2)}\n`, 'utf8');
    console.log(`Wrote temporal eval summary to ${summaryPath}`);
  }
}

function summarizeByModel(results: EvalResult[]): ModelSummary[] {
  return [...groupBy(results, (result) => `${result.experimentLabel ?? 'default'}:${result.runner ?? 'agent'}:${result.provider}:${result.model}:${result.reasoningEffort}`).entries()]
    .map(([key, modelResults]) => summarizeModel(key, modelResults))
    .sort((a, b) => b.requiredPassRate - a.requiredPassRate || a.p95DurationMs - b.p95DurationMs || a.medianDurationMs - b.medianDurationMs);
}

function summarizeModel(key: string, results: EvalResult[]): ModelSummary {
  const first = results[0]!;
  const required = results.filter((result) => result.required !== false);
  const diagnostics = results.filter((result) => result.required === false);
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const firstCorrectDurations = results
    .map((result) => result.metrics?.firstCorrectDisplayMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const toolCounts = mergeCounts(results.map((result) => result.metrics?.toolCounts ?? {}));
  const sequenceCounts = countBy(results
    .map((result) => result.metrics?.toolSequence?.join(' -> ') ?? '')
    .filter((sequence) => sequence.length > 0));

  return {
    key,
    experimentLabel: first.experimentLabel ?? 'default',
    featureFlags: first.featureFlags ?? {},
    runner: first.runner ?? 'agent',
    model: first.model,
    provider: first.provider,
    reasoningEffort: first.reasoningEffort,
    requiredPassed: required.filter((result) => result.passed).length,
    requiredTotal: required.length,
    diagnosticPassed: diagnostics.filter((result) => result.passed).length,
    diagnosticTotal: diagnostics.length,
    requiredPassRate: ratio(required.filter((result) => result.passed).length, required.length),
    medianDurationMs: percentile(durations, 0.5),
    medianFirstCorrectDisplayMs: firstCorrectDurations.length === 0 ? undefined : percentile(firstCorrectDurations, 0.5),
    p95FirstCorrectDisplayMs: firstCorrectDurations.length === 0 ? undefined : percentile(firstCorrectDurations, 0.95),
    p75DurationMs: percentile(durations, 0.75),
    p95DurationMs: percentile(durations, 0.95),
    maxDurationMs: Math.max(0, ...durations),
    meanFirstLlmMs: mean(results.map((result) => result.metrics?.firstLlmResponseMs)),
    meanFirstCandidateMs: mean(results.map((result) => result.metrics?.firstCandidateMs)),
    meanFinalResponseMs: mean(results.map((result) => result.metrics?.finalResponseMs)),
    meanLlmTurns: mean(results.map((result) => result.metrics?.llmTurns)),
    meanToolCalls: mean(results.map((result) => result.metrics?.toolCallCount)),
    meanFinalValidationMs: mean(results.map((result) => result.metrics?.finalValidationDurationMs)),
    maxPromptChars: Math.max(0, ...results.map((result) => result.metrics?.maxTotalMessageChars ?? 0)),
    topTools: topEntries(toolCounts, 8).map(([name, count]) => ({ name, count })),
    topSequences: topEntries(sequenceCounts, 5).map(([sequence, count]) => ({ sequence, count })),
  };
}

function renderHtml(evalFile: EvalFile, summaries: ModelSummary[]): string {
  const failures = evalFile.results.filter((result) => !result.passed);
  const slowest = [...evalFile.results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 20);
  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Temporal Eval Report</title>
  <style>
    :root { color-scheme: dark; --bg: #101214; --panel: #171a1f; --soft: #242933; --text: #f3f5f7; --muted: #98a2b3; --good: #3ddc97; --bad: #ff6b6b; --warn: #f6c177; --accent: #56b6ff; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1320px; margin: 0 auto; padding: 28px; }
    h1, h2 { margin: 0 0 12px; line-height: 1.1; }
    h1 { font-size: 30px; }
    h2 { font-size: 20px; margin-top: 28px; }
    .meta { color: var(--muted); margin-bottom: 22px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--soft); border-radius: 12px; padding: 14px; }
    .card strong { display: block; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--soft); border-radius: 12px; overflow: hidden; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--soft); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: #14171c; }
    tr:last-child td { border-bottom: 0; }
    code { background: #2a303a; border-radius: 5px; padding: 1px 5px; color: #d7dde7; }
    .pass { color: var(--good); font-weight: 700; }
    .fail { color: var(--bad); font-weight: 700; }
    .diag { color: var(--warn); font-weight: 700; }
    .muted { color: var(--muted); }
    .bar { min-width: 120px; height: 8px; background: #26303c; border-radius: 999px; overflow: hidden; margin-top: 4px; }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--good), var(--accent)); }
    .wrap { max-width: 420px; overflow-wrap: anywhere; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip { background: #252b35; border: 1px solid #343c49; border-radius: 999px; padding: 2px 7px; color: #d7dde7; }
  </style>
</head>
<body>
<main>
  <h1>Temporal Eval Report</h1>
  <div class="meta">Generated ${escapeHtml(generatedAt)} from ${escapeHtml(inputPath ?? '')}. Reference ${escapeHtml(evalFile.referenceInstant ?? 'unknown')} in ${escapeHtml(evalFile.timeZone ?? 'unknown')}.</div>
  <section class="grid">
    <div class="card"><span class="muted">Models</span><strong>${summaries.length}</strong></div>
    <div class="card"><span class="muted">Runs</span><strong>${evalFile.results.length}</strong></div>
    <div class="card"><span class="muted">Required Failures</span><strong>${evalFile.results.filter((result) => result.required !== false && !result.passed).length}</strong></div>
    <div class="card"><span class="muted">Diagnostic Signals</span><strong>${evalFile.results.filter((result) => result.required === false && !result.passed).length}</strong></div>
  </section>
  <h2>Leaderboard</h2>
  ${renderLeaderboard(summaries)}
  <h2>Failures And Diagnostics</h2>
  ${renderResultTable(failures, true)}
  <h2>Slowest Runs</h2>
  ${renderResultTable(slowest, false)}
  <h2>Tool Chains</h2>
  ${renderToolChains(summaries)}
</main>
</body>
</html>`;
}

function renderLeaderboard(summaries: ModelSummary[]): string {
  return `<table>
    <thead><tr><th>Model</th><th>Required</th><th>Diagnostics</th><th>Latency</th><th>First Signals</th><th>Graph</th><th>Prompt</th><th>Top Tools</th></tr></thead>
    <tbody>
      ${summaries.map((summary) => `<tr>
        <td><strong>${escapeHtml(summary.experimentLabel)} / ${escapeHtml(summary.model)}</strong><br><span class="muted">${escapeHtml(summary.runner)} / ${escapeHtml(summary.provider)} / ${escapeHtml(summary.reasoningEffort)}</span><br>${renderFlags(summary.featureFlags)}</td>
        <td>${formatPassRate(summary.requiredPassed, summary.requiredTotal)}${renderBar(summary.requiredPassRate)}</td>
        <td>${summary.diagnosticTotal === 0 ? '<span class="muted">none</span>' : formatPassRate(summary.diagnosticPassed, summary.diagnosticTotal)}</td>
        <td>first correct median ${formatMs(summary.medianFirstCorrectDisplayMs)}<br>first correct p95 ${formatMs(summary.p95FirstCorrectDisplayMs)}<br>final median ${formatMs(summary.medianDurationMs)}<br>final p95 ${formatMs(summary.p95DurationMs)}<br>max ${formatMs(summary.maxDurationMs)}</td>
        <td>first LLM ${formatMs(summary.meanFirstLlmMs)}<br>first candidate ${formatMs(summary.meanFirstCandidateMs)}<br>final ${formatMs(summary.meanFinalResponseMs)}</td>
        <td>LLM turns ${summary.meanLlmTurns.toFixed(1)}<br>tool calls ${summary.meanToolCalls.toFixed(1)}<br>validator ${formatMs(summary.meanFinalValidationMs)}</td>
        <td>${summary.maxPromptChars.toLocaleString()} chars max</td>
        <td><div class="chips">${summary.topTools.map((tool) => `<span class="chip">${escapeHtml(tool.name)} ${tool.count}</span>`).join('')}</div></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderResultTable(results: EvalResult[], includeMismatch: boolean): string {
  if (results.length === 0) {
    return '<div class="card muted">No rows.</div>';
  }
  return `<table>
    <thead><tr><th>Result</th><th>Model</th><th>Case</th><th>Text</th><th>Output</th><th>Timing</th>${includeMismatch ? '<th>Mismatch</th>' : ''}</tr></thead>
    <tbody>
      ${results.map((result) => `<tr>
        <td>${result.passed ? '<span class="pass">PASS</span>' : result.required === false ? '<span class="diag">DIAG</span>' : '<span class="fail">FAIL</span>'}<br><span class="muted">repeat ${result.repeat ?? 1}</span></td>
        <td>${escapeHtml(result.experimentLabel ?? 'default')} / ${escapeHtml(result.model)}<br><span class="muted">${escapeHtml(result.runner ?? 'agent')} / ${escapeHtml(result.reasoningEffort)}</span><br>${renderFlags(result.featureFlags ?? {})}</td>
        <td>${escapeHtml(result.caseId)}<br><span class="muted">${escapeHtml(result.category)}</span></td>
        <td class="wrap">${escapeHtml(result.text)}</td>
        <td>${escapeHtml(result.status ?? 'error')}<br>epoch ${escapeHtml(String(result.epoch ?? 'none'))}<br><span class="muted">${escapeHtml(result.method ?? '')}</span></td>
        <td>first correct ${formatMs(result.metrics?.firstCorrectDisplayMs)}<br>final ${formatMs(result.durationMs)}<br>first LLM ${formatMs(result.metrics?.firstLlmResponseMs)}<br>tools ${result.metrics?.toolCallCount ?? 0}</td>
        ${includeMismatch ? `<td class="wrap">${escapeHtml(result.error ?? result.mismatch ?? '')}</td>` : ''}
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderToolChains(summaries: ModelSummary[]): string {
  return `<table>
    <thead><tr><th>Model</th><th>Common Sequences</th></tr></thead>
    <tbody>
      ${summaries.map((summary) => `<tr>
        <td>${escapeHtml(summary.experimentLabel)} / ${escapeHtml(summary.model)}<br><span class="muted">${escapeHtml(summary.runner)} / ${escapeHtml(summary.reasoningEffort)}</span></td>
        <td>${summary.topSequences.length === 0 ? '<span class="muted">No tool calls recorded.</span>' : summary.topSequences.map((sequence) => `<div class="wrap"><code>${escapeHtml(sequence.sequence)}</code> <span class="muted">x${sequence.count}</span></div>`).join('')}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderFlags(flags: Record<string, boolean>): string {
  const entries = Object.entries(flags);
  if (entries.length === 0) {
    return '<span class="muted">flags: default</span>';
  }
  return `<div class="chips">${entries.map(([name, value]) => `<span class="chip">${escapeHtml(name)}=${value ? 'on' : 'off'}</span>`).join('')}</div>`;
}

function formatPassRate(passed: number, total: number): string {
  return `${passed}/${total} (${Math.round(ratio(passed, total) * 100)}%)`;
}

function renderBar(value: number): string {
  return `<div class="bar"><span style="width:${Math.round(value * 100)}%"></span></div>`;
}

function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.round(value)}ms`;
}

function groupBy<T>(values: T[], keyFn: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFn(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function mergeCounts(counts: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const count of counts) {
    for (const [key, value] of Object.entries(count)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function topEntries(counts: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index] ?? 0;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function mean(values: Array<number | undefined>): number {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
