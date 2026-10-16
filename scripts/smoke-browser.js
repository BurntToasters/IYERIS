import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (process.env.GITHUB_ACTIONS !== 'true' && !process.env.IYERIS_SMOKE_BROWSER) {
  throw new Error(
    'Local browser smoke requires an explicitly selected IYERIS_SMOKE_BROWSER. Automatic discovery runs only in CI.'
  );
}
const candidates = [
  process.env.IYERIS_SMOKE_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((base) => [
      path.join(base, 'Google/Chrome/Application/chrome.exe'),
      path.join(base, 'Microsoft/Edge/Application/msedge.exe'),
    ]),
].filter(Boolean);
const executable = candidates.find((candidate) => fs.existsSync(candidate));
if (!executable) throw new Error('Set IYERIS_SMOKE_BROWSER to an installed Chromium browser.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-browser-smoke-'));
let browser;
let sequence = 0;
const pending = new Map();
try {
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      outDir: path.join(temporary, 'page'),
      emptyOutDir: true,
      lib: {
        entry: path.join(root, 'build/browser-file-render-smoke.js'),
        formats: ['iife'],
        name: 'IyerisSmoke',
        fileName: () => 'smoke.js',
        cssFileName: 'smoke',
      },
    },
  });
  fs.writeFileSync(
    path.join(temporary, 'page/index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="smoke.css"><script src="smoke.js"></script>'
  );
  browser = spawn(
    executable,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--user-data-dir=${path.join(temporary, 'profile')}`,
      '--remote-debugging-pipe',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
  );
  let diagnostics = '';
  browser.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-8000);
  });
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  browser.on('error', fail);
  browser.on('exit', (code) => fail(new Error(`Browser exited (${code}): ${diagnostics}`)));
  let buffer = '';
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    }
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser timeout: ${method}; ${diagnostics}`));
      }, 30000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      browser.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call(
    'Page.navigate',
    { url: pathToFileURL(path.join(temporary, 'page/index.html')).href },
    sessionId
  );
  const result = await call(
    'Runtime.evaluate',
    {
      expression: `new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => { if (globalThis.runFileRenderSmoke) globalThis.runFileRenderSmoke().then(resolve, reject);
      else if (Date.now() - start > 10000) reject(new Error('Smoke page failed to load'));
      else setTimeout(poll, 20); }; poll();
  })`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)
    );
  const artifactPath =
    process.env.IYERIS_SMOKE_ARTIFACT ||
    path.join(root, 'coverage-headless', 'browser-smoke-artifact.json');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appVersion: packageJson.version,
        browser: path.basename(executable),
        passed: true,
        suites: result.result.value,
      },
      null,
      2
    )}\n`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Browser smoke artifact was not written: ${artifactPath}`);
  }
  console.log(
    JSON.stringify(
      { browser: executable, artifact: artifactPath, suites: result.result.value },
      null,
      2
    )
  );
} finally {
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await exited;
  }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
