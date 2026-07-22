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
  }).trim();
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

function clearQualityGateProof(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_RELATIVE_PATH), { force: true });
}

function recordSuccessfulQualityGate(root = defaultRoot) {
  let status;
  try {
    status = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  } catch {
    return false;
  }
  if (status) {
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
      `Release quality-gate proof is missing or invalid. Run test:all first: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateQualityGate(proof, currentReleaseIdentity(root), options);
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
      `Release build session is missing or invalid. Run release:prepare first: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateReleaseSession(session, currentReleaseIdentity(root), options);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
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
  RELEASE_SESSION_RELATIVE_PATH,
  clearQualityGateProof,
  createReleaseSession,
  currentReleaseIdentity,
  recordSuccessfulQualityGate,
  validateQualityGate,
  validateReleaseSession,
  verifyQualityGate,
  verifyReleaseSession,
};
