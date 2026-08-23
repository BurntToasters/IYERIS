'use strict';

const { spawnSync } = require('node:child_process');

function githubCliEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.GH_TOKEN;
  delete childEnvironment.GITHUB_TOKEN;
  return childEnvironment;
}

function githubStatusCode(detail) {
  const match = String(detail || '').match(/\bHTTP\s+(\d{3})\b|\bstatus(?: code)?\s+(\d{3})\b/i);
  return match ? Number(match[1] || match[2]) : undefined;
}

function githubApiArgs(method, endpoint, hasBody = false) {
  const args = ['api', '--method', method, endpoint];
  if (hasBody) args.push('--input', '-');
  return args;
}

function releaseUploadArgs(repository, tag, filePath, { clobber = false } = {}) {
  return [
    'release',
    'upload',
    tag,
    '--repo',
    repository,
    ...(clobber ? ['--clobber'] : []),
    filePath,
  ];
}

function runGitHub(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: githubCliEnvironment(),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('GitHub CLI is required. Install gh and run `gh auth login` on this release VM.');
    }
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const error = new Error(`gh ${args.join(' ')} failed with status ${result.status}${detail ? `:\n${detail}` : ''}`);
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  return result;
}

function githubOutput(args, options) {
  return String(runGitHub(args, options).stdout || '').trim();
}

function githubJson(args, options) {
  const output = githubOutput(args, options);
  return output ? JSON.parse(output) : {};
}

function githubApi(method, endpoint, body) {
  return githubJson(githubApiArgs(method, endpoint, body !== undefined), {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assertGitHubCliAuthenticated() {
  runGitHub(['auth', 'status', '--hostname', 'github.com']);
}

function uploadReleaseAsset(repository, tag, filePath, options) {
  runGitHub(releaseUploadArgs(repository, tag, filePath, options));
}

module.exports = {
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiArgs,
  githubCliEnvironment,
  githubStatusCode,
  releaseUploadArgs,
  runGitHub,
  uploadReleaseAsset,
};