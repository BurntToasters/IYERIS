import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './direct-execution.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Release notes belong in CHANGELOG.md and the GitHub release body. Keep the
// docs tree for durable product/developer documentation only.
const forbiddenPath =
  /(?:^|[-_.])(release|releases|changelog|note|notes|roadmap|soak|promotion|beta|stable)(?:[-_.]|$)/iu;
const whatsNewPath = /(?:^|[-_.])what(?:s|['’]s)?[-_.]+new(?:[-_.]|$)/iu;
const forbiddenHeading =
  /^\s{0,3}#{1,6}\s+.*(?:\b(?:release\s+notes?|changelog|release\s+plan|beta\s+soak|promotion)\b|\bwhat(?:'|’)?s\s+new(?:\s+in)?\s+v?\d+\.\d+|\bv?\d+\.\d+(?:\.\d+)?(?:[-._][0-9a-z]+)*\b.*\b(?:improvement|improvements|changes|notes)\b)/imu;
const versionOnlyStem = /^v?\d+\.\d+\.\d+(?:[-_.][0-9a-z]+)*$/iu;
const durableDocsAllowlist = new Set(['DEPENDENCY_UPDATES.md']);

function listFiles(directory, relative = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryRelative = path.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute, entryRelative) : [entryRelative];
  });
}

export function findDocsPolicyViolations(root = repoRoot) {
  const directory = path.join(root, 'docs');
  const violations = [];
  for (const relativePath of listFiles(directory)) {
    const normalized = relativePath.replaceAll(path.sep, '/');
    const basename = path.posix.basename(normalized);
    const stem = basename.replace(/\.[^.]+$/u, '');
    const versionDirectory = normalized
      .split('/')
      .slice(0, -1)
      .some((segment) => versionOnlyStem.test(segment));
    if (!durableDocsAllowlist.has(normalized))
      violations.push(`${normalized}: documentation must be on the durable allowlist`);
    if (
      forbiddenPath.test(normalized) ||
      whatsNewPath.test(normalized) ||
      versionOnlyStem.test(stem) ||
      versionDirectory
    )
      violations.push(`${normalized}: forbidden release-document path`);
    try {
      const content = fs.readFileSync(path.join(directory, relativePath), 'utf8');
      if (forbiddenHeading.test(content))
        violations.push(`${normalized}: release-document heading`);
    } catch (error) {
      violations.push(
        `${normalized}: cannot read (${error instanceof Error ? error.message : String(error)})`
      );
      continue;
    }
  }
  return violations;
}

export function checkDocsPolicy(root = repoRoot) {
  const violations = findDocsPolicyViolations(root);
  if (violations.length > 0) {
    throw new Error(
      `docs/ policy violation:\n${violations.map((entry) => `- ${entry}`).join('\n')}`
    );
  }
  return true;
}

if (isDirectExecution(import.meta.url)) {
  try {
    checkDocsPolicy();
    console.log('docs/ policy passed: no release documents found.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
