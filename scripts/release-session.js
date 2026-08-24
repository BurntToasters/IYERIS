import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, '..');
const RELEASE_SESSION_RELATIVE_PATH = path.join('release', '.build-session.json');
const QUALITY_GATE_RELATIVE_PATH = path.join('coverage', '.release-quality.json');
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function command(commandName, args, root) {
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function currentReleaseIdentity(root = defaultRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return {
    version: String(packageJson.version ?? ''),
    commit: command('git', ['rev-parse', 'HEAD'], root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rustc: command('rustc', ['--version'], root),
    packageLockSha256: sha256File(path.join(root, 'package-lock.json')),
    cargoLockSha256: sha256File(path.join(root, 'src-tauri', 'Cargo.lock')),
  };
}

function validateIdentity(record, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw new Error(`${label} ${key} does not match this checkout/environment.`);
    }
  }
}

function validateReleaseSession(
  session,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}
) {
  if (!session || typeof session !== 'object') {
    throw new Error('Release build session is not an object.');
  }
  if (!Number.isFinite(session.startedAt)) {
    throw new Error('Release build session has no valid start time.');
  }
  const age = now - session.startedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error('Release build session is expired; run release:prepare again.');
  }

  validateIdentity(session, expected, 'Release build session');
  if (
    !Number.isFinite(session.qualityGateCompletedAt) ||
    session.qualityGateCompletedAt >= session.startedAt
  ) {
    throw new Error('Release build session has no valid quality-gate proof.');
  }
  return session;
}

function validateQualityGate(
  qualityGate,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}
) {
  if (!qualityGate || typeof qualityGate !== 'object') {
    throw new Error('Release quality-gate proof is not an object.');
  }
  if (!Number.isFinite(qualityGate.completedAt)) {
    throw new Error('Release quality-gate proof has no valid completion time.');
  }
  const age = now - qualityGate.completedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error('Release quality-gate proof is expired; run test:all again.');
  }
  validateIdentity(qualityGate, expected, 'Release quality-gate proof');
  return qualityGate;
}

const RELEASE_BOOTSTRAP_PATHS = new Set([
  'run.rosie.iyeris.metainfo.xml',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]);
const RELEASE_BOOTSTRAP_PREFIXES = ['src-tauri/gen/schemas/'];

function normalizePorcelainPath(value) {
  let normalized = String(value).replace(/\\/g, '/');
  if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
    normalized = normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  return normalized;
}

function parsePorcelainPaths(status) {
  return status
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // XY (2 chars) + space + path. Do not trim the line: ` M path` is valid porcelain.
      const match = line.match(/^(.{2}) (.*)$/);
      if (!match) return '';
      const rest = match[2];
      const renameArrow = rest.indexOf(' -> ');
      return normalizePorcelainPath(renameArrow >= 0 ? rest.slice(renameArrow + 4) : rest);
    })
    .filter(Boolean);
}

function isAllowedBootstrapPath(filePath) {
  if (RELEASE_BOOTSTRAP_PATHS.has(filePath)) return true;
  return RELEASE_BOOTSTRAP_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/** Clean tree, or only files that workspace:bootstrap / cargo check may touch before proof. */
function isAcceptableReleaseWorkingTree(status) {
  if (!status.trim()) return true;
  const paths = parsePorcelainPaths(status);
  if (paths.length === 0) return false;
  return paths.every((filePath) => isAllowedBootstrapPath(filePath));
}

function gitPorcelainStatus(root) {
  return command('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
}

function blockingReleaseWorkingTreePaths(root = defaultRoot) {
  let status;
  try {
    status = gitPorcelainStatus(root);
  } catch {
    return ['<git status failed>'];
  }
  if (isAcceptableReleaseWorkingTree(status)) return [];
  return parsePorcelainPaths(status).filter((filePath) => !isAllowedBootstrapPath(filePath));
}

function clearQualityGateProof(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_RELATIVE_PATH), { force: true });
}

function recordSuccessfulQualityGate(root = defaultRoot) {
  let status;
  try {
    status = gitPorcelainStatus(root);
  } catch {
    return false;
  }
  if (!isAcceptableReleaseWorkingTree(status)) {
    return false;
  }
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(
    proofPath,
    `${JSON.stringify({ ...currentReleaseIdentity(root), completedAt: Date.now() })}\n`,
    { mode: 0o600 }
  );
  return true;
}

function verifyQualityGate(root = defaultRoot, options) {
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Release quality-gate proof is missing or invalid. On a clean checkout, run "npm run test:all" (or "npm run workspace:prepare") before release:prepare. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  return validateQualityGate(proof, currentReleaseIdentity(root), options);
}

function writeReleaseSession(session, root = defaultRoot) {
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  return session;
}

function startReleaseSession(root = defaultRoot) {
  const session = createReleaseSession(root);
  writeReleaseSession(session, root);
  return session;
}

function createReleaseSession(root = defaultRoot) {
  const qualityGate = verifyQualityGate(root);
  return {
    ...currentReleaseIdentity(root),
    qualityGateCompletedAt: qualityGate.completedAt,
    startedAt: Date.now(),
  };
}

function verifyReleaseSession(root = defaultRoot, options) {
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. On this machine run "npm run release:prepare" (or the full "npm run release:win" / "release:mac" / "release:linux:*" script), not *:continue alone. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  return validateReleaseSession(session, currentReleaseIdentity(root), options);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  const subcommand = process.argv[2];
  if (subcommand === 'start') {
    try {
      const session = startReleaseSession();
      console.log(
        `release-session: started (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`
      );
    } catch (error) {
      console.error(
        `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  try {
    const session = verifyReleaseSession();
    console.log(
      `release-session: ok (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`
    );
  } catch (error) {
    console.error(
      `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export {
  DEFAULT_MAX_AGE_MS,
  QUALITY_GATE_RELATIVE_PATH,
  RELEASE_BOOTSTRAP_PATHS,
  RELEASE_SESSION_RELATIVE_PATH,
  blockingReleaseWorkingTreePaths,
  clearQualityGateProof,
  createReleaseSession,
  currentReleaseIdentity,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
  recordSuccessfulQualityGate,
  startReleaseSession,
  validateQualityGate,
  validateReleaseSession,
  verifyQualityGate,
  verifyReleaseSession,
};
