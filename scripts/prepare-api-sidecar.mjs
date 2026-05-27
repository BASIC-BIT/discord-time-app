import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(rootDir, 'api');
const tauriDir = path.join(rootDir, 'src-tauri');
const sidecarDir = path.join(tauriDir, 'sidecars', 'hammer-overlay-api');
const sidecarBinDir = path.join(sidecarDir, 'bin');
const sidecarNodePath = path.join(sidecarBinDir, process.platform === 'win32' ? 'node.exe' : 'node');
const stampPath = path.join(sidecarDir, '.sidecar-stamp');

if (!existsSync(path.join(apiDir, 'dist', 'index.js'))) {
  throw new Error('api/dist/index.js is missing. Run `npm --prefix api run build` first.');
}

if (!existsSync(process.execPath)) {
  throw new Error(`Could not find the current Node runtime at ${process.execPath}`);
}

function hashFile(hash, filePath) {
  hash.update(path.relative(rootDir, filePath));
  hash.update('\0');
  hash.update(readFileSync(filePath));
  hash.update('\0');
}

function hashDirectory(hash, dirPath) {
  const entries = readdirSync(dirPath).sort();
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      hashDirectory(hash, entryPath);
    } else if (stats.isFile()) {
      hashFile(hash, entryPath);
    }
  }
}

function computeStamp() {
  const hash = createHash('sha256');
  hash.update(process.version);
  hash.update(process.platform);
  hash.update(process.arch);
  hashFile(hash, path.join(apiDir, 'package.json'));
  hashFile(hash, path.join(apiDir, 'package-lock.json'));
  hashDirectory(hash, path.join(apiDir, 'dist'));
  hashFile(hash, process.execPath);
  return hash.digest('hex');
}

const nextStamp = computeStamp();
const previousStamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : '';

if (
  previousStamp === nextStamp &&
  existsSync(path.join(sidecarDir, 'dist', 'index.js')) &&
  existsSync(path.join(sidecarDir, 'node_modules')) &&
  existsSync(sidecarNodePath)
) {
  console.log('API sidecar staging is up to date.');
  process.exit(0);
}

rmSync(sidecarDir, { force: true, recursive: true });
mkdirSync(sidecarBinDir, { recursive: true });

cpSync(path.join(apiDir, 'dist'), path.join(sidecarDir, 'dist'), { recursive: true });
copyFileSync(path.join(apiDir, 'package.json'), path.join(sidecarDir, 'package.json'));
copyFileSync(path.join(apiDir, 'package-lock.json'), path.join(sidecarDir, 'package-lock.json'));
copyFileSync(process.execPath, sidecarNodePath);

console.log('Installing production API dependencies for bundled sidecar...');
if (process.platform === 'win32') {
  execSync('npm ci --omit=dev --no-audit --fund=false --loglevel=warn', {
    cwd: sidecarDir,
    stdio: 'inherit',
  });
} else {
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--fund=false', '--loglevel=warn'], {
    cwd: sidecarDir,
    stdio: 'inherit',
  });
}

writeFileSync(stampPath, `${nextStamp}\n`);
console.log(`Prepared API sidecar resources in ${path.relative(rootDir, sidecarDir)}`);
