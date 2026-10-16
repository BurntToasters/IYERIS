import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
  // The bundle runs synchronously during parsing, so the script must sit inside
  // the body: suites assign to document.body.innerHTML and it is null until the
  // parser has opened the body element.
  fs.writeFileSync(
    path.join(temporary, 'page/index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="smoke.css"><body><script src="smoke.js"></script></body>'
  );
  browser = spawn(
    executable,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      // Wide enough that viewport-gated panels (preview, sort menu) stay
      // enabled; Chromium's default headless window is 800x600.
      '--window-size=1400,900',
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
  const call = (method, params = {}, sessionId, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser timeout: ${method}; ${diagnostics}`));
      }, timeoutMs);
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
  // The whole E2E suite runs inside one evaluate awaiting the page's promise,
  // so this call needs a much longer budget than the individual CDP commands.
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
    sessionId,
    120000
  );
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)
    );
  const suites = result.result.value;
  if (!Array.isArray(suites) || suites.length < 9) {
    throw new Error(
      `Browser smoke returned ${Array.isArray(suites) ? suites.length : typeof suites} suites`
    );
  }
  for (const suite of suites) {
    if (typeof suite?.mode !== 'string' || suite.mode.length === 0) {
      throw new Error(`Browser smoke suite is missing a mode: ${JSON.stringify(suite)}`);
    }
  }
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
        suiteCount: suites.length,
        suites,
      },
      null,
      2
    )}\n`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Browser smoke artifact was not written: ${artifactPath}`);
  }
  // Read the file back through the same path a consumer would use so a
  // truncated or malformed write fails the run instead of shipping.
  const artifactText = fs.readFileSync(artifactPath, 'utf8');
  if (artifactText.trim().length === 0) {
    throw new Error(`Browser smoke artifact is empty: ${artifactPath}`);
  }
  const artifact = JSON.parse(artifactText);
  if (artifact.passed !== true) {
    throw new Error(`Browser smoke artifact recorded failure: ${artifactPath}`);
  }
  if (artifact.suites.length !== 10) {
    throw new Error(
      `Browser smoke artifact expected 10 suites, found ${artifact.suites.length}: ${artifactPath}`
    );
  }
  console.log(
    JSON.stringify(
      { browser: executable, artifact: artifactPath, suiteCount: artifact.suites.length, suites },
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
