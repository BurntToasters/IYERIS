import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOWS_PATH = path.join(repoRoot, '.github', 'workflows');

// CI validates code and runs smoke checks. Release VMs alone publish artifacts.
const FORBIDDEN = [
  ['write permissions', /\b(?:write-all|[\w-]+:\s*write)\b/u],
  ['release trigger', /^\s*release\s*:/mu],
  ['release mutation', /\bgh\s+release\s+(?:create|edit|upload|delete|delete-asset)\b/u],
  ['release API mutation', /\b(?:PATCH|POST|PUT|DELETE)\b[^\n]*\/releases\b/iu],
  [
    'release script',
    /\bnpm\s+run\s+(?:release(?::[\w:-]+)?|prerelease:[\w:-]+|tauri:build|build:(?:win|mac|linux|msstore)[\w:-]*)\b/u,
  ],
  [
    'release tool',
    /\bnode\s+(?:\.\/)?scripts\/(?:publish-release|sync-beta-manifests|ensure-draft-release|gpg-sign|post-release-assets|finalize-release-assets|tauri-build)\.(?:cjs|js)\b/u,
  ],
  [
    'publishing action',
    /\buses:\s*[^\s]*(?:action-gh-release|release-action|tauri-action|upload-release-asset|create-release|ghaction-github-release)/iu,
  ],
  [
    'publishing credentials',
    /\bsecrets\.(?:GH_TOKEN|GITHUB_TOKEN|TAURI_SIGNING_[\w]+|APPLE_[\w]+|GPG_[\w]+|AZURE_[\w]+)/u,
  ],
];

export function findReleaseWorkflowViolations(workflowText) {
  const text = workflowText
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
  return FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([message]) => message);
}

export function checkReleaseWorkflow(workflowsPath = WORKFLOWS_PATH) {
  try {
    return fs
      .readdirSync(workflowsPath)
      .filter((name) => /\.ya?ml$/u.test(name))
      .flatMap((name) =>
        findReleaseWorkflowViolations(fs.readFileSync(path.join(workflowsPath, name), 'utf8')).map(
          (message) => `${name}: ${message}`
        )
      );
  } catch (error) {
    return [`Cannot read CI workflows: ${error instanceof Error ? error.message : String(error)}`];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkReleaseWorkflow();
  if (violations.length > 0) {
    console.error(`CI test/smoke policy failed:\n- ${violations.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('CI test/smoke policy passed; releases belong to release VMs.');
  }
}
