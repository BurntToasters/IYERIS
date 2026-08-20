#!/usr/bin/env node

/* Temporary regression scanner. Remove together with cargo-safe-update.mjs
 * when stable Cargo minimum-publish-age replaces the wrapper. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_MUTATION = /\bcargo\s+(update|upgrade|add|generate-lockfile)\b/;
const EXCLUDED_FILES = new Set([
  'cargo-safe-update.mjs',
  'cargo-safe-update.test.mjs',
  'check-cargo-update-policy.mjs',
  'check-cargo-update-policy.test.mjs',
]);

/* Files that mention raw Cargo mutation commands in documentation strings
 * only. Every entry needs a reason; keep this list empty where possible. */
const DOCUMENTED_MENTIONS = new Map([
  // "bump-version.js" only prints `cargo generate-lockfile` advice in an
  // error message; it never executes dependency resolution.
  ['bump-version.js', 'error-message text only'],
]);

function listFiles(directory, extension) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(directory, entry.name));
}

function stripCommentLines(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*')
      );
    })
    .join('\n');
}

function scanFile(relativePath, absolutePath, violations) {
  const base = path.basename(relativePath);
  if (EXCLUDED_FILES.has(base)) return;
  let text;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch {
    return;
  }
  const offending = stripCommentLines(text)
    .split(/\r?\n/u)
    .filter((line) => RAW_MUTATION.test(line) && !segmentIsGuarded(line));
  if (offending.length > 0) {
    const documented = DOCUMENTED_MENTIONS.get(base);
    if (!documented) violations.push(relativePath);
  }
}

function commandSegments(command) {
  return command.split(/&&|\|\||;|\n/u);
}

function segmentIsGuarded(segment) {
  return segment.includes('cargo-safe-update');
}

function scanPackageJson(violations) {
  const manifestPath = path.join(repoRoot, 'package.json');
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(manifestPath, 'utf8')).scripts ?? {};
  } catch {
    return;
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    for (const segment of commandSegments(command)) {
      if (RAW_MUTATION.test(segment) && !segmentIsGuarded(segment)) {
        violations.push(`package.json script "${name}"`);
        break;
      }
    }
  }
}

function scanRootFile(name, violations) {
  const absolutePath = path.join(repoRoot, name);
  try {
    if (!statSync(absolutePath).isFile()) return;
  } catch {
    return;
  }
  scanFile(name, absolutePath, violations);
}

function main() {
  const violations = [];
  scanPackageJson(violations);
  for (const file of listFiles(path.join(repoRoot, 'scripts'), '.js')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const file of listFiles(path.join(repoRoot, 'scripts'), '.mjs')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const file of listFiles(path.join(repoRoot, 'scripts'), '.cjs')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const file of listFiles(path.join(repoRoot, 'scripts'), '.ts')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const file of listFiles(path.join(repoRoot, 'scripts'), '.sh')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const file of listFiles(path.join(repoRoot, 'scripts'), '.ps1')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const name of ['Makefile', 'justfile']) scanRootFile(name, violations);
  for (const file of listFiles(repoRoot, '.sh')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  for (const file of listFiles(repoRoot, '.ps1')) {
    scanFile(path.relative(repoRoot, file), file, violations);
  }
  const workflows = path.join(repoRoot, '.github', 'workflows');
  for (const extension of ['.yml', '.yaml']) {
    for (const file of listFiles(workflows, extension)) {
      scanFile(path.relative(repoRoot, file), file, violations);
    }
  }

  if (violations.length > 0) {
    console.error('cargo-update-policy: unguarded dependency mutation found:');
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    console.error(
      'Route dependency updates through scripts/cargo-safe-update.mjs (72-hour publish-age guard).'
    );
    process.exitCode = 1;
    return;
  }
  console.log('cargo-update-policy: no unguarded cargo dependency mutation found.');
}

const isMainModule =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) main();

export { main as checkCargoUpdatePolicy };
