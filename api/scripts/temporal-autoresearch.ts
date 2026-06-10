import 'dotenv/config';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportDir = process.env['TEMPORAL_AUTORESEARCH_DIR'] ?? join('reports', 'temporal-autoresearch');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = process.env['TEMPORAL_EVAL_OUTPUT'] ?? join(reportDir, `${stamp}.json`);
const summaryPath = process.env['TEMPORAL_EVAL_SUMMARY'] ?? join(reportDir, `${stamp}.summary.json`);
const reportPath = process.env['TEMPORAL_EVAL_REPORT'] ?? join(reportDir, `${stamp}.html`);

const env = cleanEnv({
  ...process.env,
  TEMPORAL_EVAL_BASELINES: process.env['TEMPORAL_EVAL_BASELINES'] ?? 'deterministic',
  TEMPORAL_EVAL_MODELS: process.env['TEMPORAL_EVAL_MODELS'] ?? (process.env['OPENAI_API_KEY'] ? 'gpt-5.5:low' : ''),
  TEMPORAL_EVAL_EXPERIMENTS: process.env['TEMPORAL_EVAL_EXPERIMENTS'] ?? 'baseline:planIr=false;candidate:planIr=true',
  TEMPORAL_EVAL_OUTPUT: outputPath,
  TEMPORAL_EVAL_SUMMARY: summaryPath,
  TEMPORAL_EVAL_REPORT: reportPath,
});

async function main() {
  await mkdir(reportDir, { recursive: true });
  console.log('Temporal AutoResearch matrix');
  console.log(`  experiments: ${env.TEMPORAL_EVAL_EXPERIMENTS}`);
  console.log(`  baselines:   ${env.TEMPORAL_EVAL_BASELINES}`);
  console.log(`  models:      ${env.TEMPORAL_EVAL_MODELS || '(none)'}`);
  console.log(`  output:      ${outputPath}`);

  const evalCode = await runNpmScript('eval:temporal');
  let reportCode = 0;
  if (await fileExists(outputPath)) {
    reportCode = await runNpmScript('eval:temporal:report');
    console.log(`Temporal AutoResearch JSON: ${outputPath}`);
    console.log(`Temporal AutoResearch summary: ${summaryPath}`);
    console.log(`Temporal AutoResearch report: ${reportPath}`);
  } else {
    console.log('Eval output was not written; skipping report generation.');
  }

  if (evalCode !== 0 || reportCode !== 0) {
    process.exitCode = evalCode !== 0 ? evalCode : reportCode;
  }
}

function runNpmScript(script: string): Promise<number> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(`${npm} run ${script}`, {
        cwd: apiRoot,
        env,
        stdio: 'inherit',
        shell: true,
      })
      : spawn(npm, ['run', script], {
      cwd: apiRoot,
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(record: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
