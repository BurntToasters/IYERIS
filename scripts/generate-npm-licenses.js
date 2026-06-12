import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const outputDir = join(repoRoot, 'public');
const outputPath = join(outputDir, 'licenses.json');
const binaryPath = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'license-checker-rseidelsohn.cmd' : 'license-checker-rseidelsohn'
);

function fail(message, output = '') {
  if (output.trim().length > 0) {
    console.error(output.trim());
  }
  throw new Error(message);
}

const run = spawnSync(binaryPath, ['--production', '--json'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  windowsHide: true,
});

if (run.error) {
  fail(`Failed to execute license-checker-rseidelsohn: ${run.error.message}`);
}

if (run.status !== 0) {
  fail(
    `license-checker-rseidelsohn exited with code ${run.status ?? 'unknown'}`,
    `${run.stdout || ''}${run.stderr || ''}`
  );
}

const rawOutput = (run.stdout || '').trim();
if (!rawOutput) {
  fail('license-checker-rseidelsohn produced no JSON output');
}

let parsed;
try {
  parsed = JSON.parse(rawOutput);
} catch (error) {
  fail(
    `Failed to parse license-checker-rseidelsohn output: ${error instanceof Error ? error.message : String(error)}`,
    rawOutput
  );
}

const normalized = Object.fromEntries(
  Object.entries(parsed)
    .filter(([packageName]) => !packageName.startsWith('iyeris@'))
    .map(([packageName, info]) => {
      const record = info && typeof info === 'object' ? { ...info } : {};
      if (!('parents' in record)) {
        record.parents = 'iyeris';
      }
      return [packageName, record];
    })
);

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(normalized, null, 4)}\n`, 'utf8');
