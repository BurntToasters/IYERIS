#!/usr/bin/env node

/* Temporary regression scanner. Remove together with cargo-safe-update.mjs
 * when stable Cargo minimum-publish-age replaces the wrapper. */

import console from 'node:console';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CARGO_UPDATE_POLICY_SCANNER_VERSION = 2;
export const CARGO_UPDATE_SCANNER_VERSION = 2;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EXECUTABLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
  '.cmd',
  '.bat',
  '.yml',
  '.yaml',
]);

export const EXACT_AUTOMATION_FILES = new Set([
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  'Taskfile',
  'Taskfile.yml',
  'Taskfile.yaml',
]);

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'release',
  'coverage',
  'vendor',
  '.vite',
  '.next',
  'build',
  'out',
]);

export const EXCLUDED_FILES = new Set([
  'scripts/cargo-safe-update.mjs',
  'scripts/cargo-safe-update.test.mjs',
  'scripts/check-cargo-update-policy.mjs',
  'scripts/check-cargo-update-policy.test.mjs',
]);

export const DOCUMENTED_MENTIONS = new Map([
  ['scripts/bump-version.js', 'prints cargo generate-lockfile troubleshooting text only'],
]);

const RAW_CARGO_MUTATION_REGEX = /\bcargo\s+(update|upgrade|add|generate-lockfile)\b/;
const LOCKFILE_DELETE_REGEX =
  /(?:\b(?:rm|unlink|Remove-Item|ri|del|erase|rmSync|unlinkSync)\b[^\n\r;]*[\\/]Cargo\.lock\b)|(?:\b(?:rm|unlink|Remove-Item|ri|del|erase|rmSync|unlinkSync)\s+[^\n\r;]*\bCargo\.lock\b)|(?:\b(?:rmSync|unlinkSync)\s*\([^)]*Cargo\.lock[^)]*\))/;
const LOCKFILE_TRUNCATE_OVERWRITE_REGEX =
  /(?:>\s*(?:[^\n\r;]*[\\/])?Cargo\.lock\b)|(?:\btruncate\s+[^\n\r;]*\bCargo\.lock\b)/;

export function normalizeRelPath(relPath) {
  return relPath.split(path.sep).join('/');
}

export function commandSegments(command) {
  return command.split(/&&|\|\||;|\n/u);
}

export function segmentIsGuarded(segment) {
  return segment.includes('cargo-safe-update');
}

export function stripCommentLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('REM ') ||
        trimmed.startsWith('rem ') ||
        trimmed.startsWith('::')
      ) {
        return '';
      }
      return line;
    })
    .join('\n');
}

export function classifyLine(line) {
  if (segmentIsGuarded(line)) return null;

  for (const segment of commandSegments(line)) {
    if (segmentIsGuarded(segment)) continue;

    if (RAW_CARGO_MUTATION_REGEX.test(segment)) {
      return {
        kind: 'raw Cargo mutation',
        text: segment.trim(),
      };
    }

    if (LOCKFILE_DELETE_REGEX.test(segment)) {
      return {
        kind: 'Cargo.lock deletion',
        text: segment.trim(),
      };
    }

    if (LOCKFILE_TRUNCATE_OVERWRITE_REGEX.test(segment)) {
      return {
        kind: 'Cargo.lock overwrite/truncate',
        text: segment.trim(),
      };
    }
  }

  return null;
}

export function walkExecutableFiles(root, currentDir = root, results = []) {
  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = normalizeRelPath(path.relative(root, fullPath));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walkExecutableFiles(root, fullPath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXECUTABLE_EXTENSIONS.has(ext) || EXACT_AUTOMATION_FILES.has(entry.name)) {
        results.push({ relPath, fullPath, ext, name: entry.name });
      }
    }
  }

  return results;
}

export function scanFile(relPath, fullPath, violations) {
  const normalizedRel = normalizeRelPath(relPath);
  if (EXCLUDED_FILES.has(normalizedRel)) return;

  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return;
  }

  const stripped = stripCommentLines(content);
  const lines = stripped.split(/\r?\n/u);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const finding = classifyLine(line);
    if (finding) {
      if (DOCUMENTED_MENTIONS.has(normalizedRel)) continue;
      violations.push({
        file: normalizedRel,
        line: i + 1,
        kind: finding.kind,
        text: finding.text,
      });
    }
  }
}

export function scanPackageJson(root, violations) {
  const manifestPath = path.join(root, 'package.json');
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(manifestPath, 'utf8')).scripts ?? {};
  } catch {
    return;
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    for (const segment of commandSegments(command)) {
      const finding = classifyLine(segment);
      if (finding) {
        violations.push({
          file: 'package.json',
          script: name,
          kind: finding.kind,
          text: finding.text,
        });
        break;
      }
    }
  }
}

export function runPolicyCheck({ root = repoRoot, log = console.log, error = console.error } = {}) {
  const violations = [];
  scanPackageJson(root, violations);

  // Scan root automation exact files
  for (const name of EXACT_AUTOMATION_FILES) {
    const fullPath = path.join(root, name);
    try {
      if (statSync(fullPath).isFile()) {
        scanFile(name, fullPath, violations);
      }
    } catch {
      // file does not exist
    }
  }

  // Scan automation directories recursively
  const candidateDirs = [
    'scripts',
    'tools',
    'bin',
    'dev',
    'ops',
    'ci',
    'automation',
    'build-scripts',
    path.join('.github', 'workflows'),
  ];

  for (const dir of candidateDirs) {
    const targetDir = path.join(root, dir);
    try {
      if (statSync(targetDir).isDirectory()) {
        const files = walkExecutableFiles(root, targetDir);
        for (const file of files) {
          scanFile(file.relPath, file.fullPath, violations);
        }
      }
    } catch {
      // directory does not exist
    }
  }

  // Scan root-level shell / powershell / cmd files
  try {
    const rootEntries = readdirSync(root, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.cmd', '.bat'].includes(ext)) {
          scanFile(entry.name, path.join(root, entry.name), violations);
        }
      }
    }
  } catch {
    // ignore
  }

  if (violations.length > 0) {
    error('cargo-update-policy: unguarded dependency mutation found:\n');
    for (const v of violations) {
      if (v.script) {
        error(`  file: ${v.file} (script "${v.script}")\n  kind: ${v.kind}\n  text: ${v.text}\n`);
      } else {
        error(`  file: ${v.file}:${v.line}\n  kind: ${v.kind}\n  text: ${v.text}\n`);
      }
    }
    error(
      'Dependency-changing workflows must route through scripts/cargo-safe-update.mjs (72-hour publish-age guard).'
    );
    return false;
  }

  log('cargo-update-policy: no unguarded cargo dependency mutation found.');
  return true;
}

function main() {
  const success = runPolicyCheck();
  if (!success) {
    process.exitCode = 1;
  }
}

const isMainModule =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) main();

export { runPolicyCheck as checkCargoUpdatePolicy };
