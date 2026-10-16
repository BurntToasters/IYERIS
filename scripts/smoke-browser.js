import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const EXPECTED_SUITE_MODES = [
  'grid',
  'list',
  'dual-pane',
  'column-view',
  'search',
  'tabs-and-navigation',
  'selection-and-sort',
  'command-palette-and-bookmarks',
  'previews-and-markdown',
  'operations-and-modals',
  'thumbnails-fingerprint-and-inflight',
  'archive-whitespace-password',
  'operation-queue-lifetime',
];
const MAX_ERROR_LENGTH = 4000;
const MAX_DIAGNOSTICS_LENGTH = 8000;
const artifactPath = path.resolve(
  process.env.IYERIS_SMOKE_ARTIFACT ||
    path.join(root, 'coverage-headless', 'browser-smoke-artifact.json')
);
const diagnosticsPath = path.join(path.dirname(artifactPath), 'browser-smoke-diagnostics.log');
const startedAt = new Date().toISOString();

const artifact = {
  schemaVersion: 2,
  appVersion: packageJson.version,
  status: 'in-progress',
  passed: false,
  startedAt,
  completedAt: null,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  git: { commit: null, dirty: null },
  browser: null,
  suiteCount: 0,
  suites: [],
  diagnostics: '',
  error: null,
};

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function persistArtifact() {
  atomicWrite(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

function persistDiagnostics() {
  atomicWrite(diagnosticsPath, `${artifact.diagnostics || ''}\n`);
}

function getGitMetadata() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (commit.status !== 0 || status.status !== 0) {
    throw new Error(
      'Could not capture the current Git commit and working-tree state for the smoke artifact.'
    );
  }
  return {
    commit: commit.stdout.trim(),
    dirty: status.stdout.length > 0,
  };
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBrowser() {
  if (Object.hasOwn(process.env, 'IYERIS_SMOKE_BROWSER')) {
    const explicit = process.env.IYERIS_SMOKE_BROWSER;
    if (!explicit || !isExecutableFile(explicit)) {
      throw new Error(
        `IYERIS_SMOKE_BROWSER must point to an existing Chromium browser executable; received ${JSON.stringify(explicit)}.`
      );
    }
    return path.resolve(explicit);
  }

  const candidates = [
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
    ...(process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, 'imput/Helium/Application/chrome.exe')]
      : []),
  ];
  const executable = candidates.find(isExecutableFile);
  if (!executable) {
    throw new Error(
      'No installed Chromium browser was found. Set IYERIS_SMOKE_BROWSER to an existing browser executable.'
    );
  }
  return executable;
}

function boundedError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function validateSuites(suites) {
  if (!Array.isArray(suites)) {
    throw new Error(`Browser smoke returned ${typeof suites} instead of suite outputs.`);
  }
  const modes = suites.map((suite) => suite?.mode);
  if (modes.some((mode) => typeof mode !== 'string' || mode.length === 0)) {
    throw new Error('Browser smoke returned a suite without a mode identifier.');
  }
  const actual = new Set(modes);
  const duplicates = modes.filter((mode, index) => modes.indexOf(mode) !== index);
  const missing = EXPECTED_SUITE_MODES.filter((mode) => !actual.has(mode));
  const unexpected = [...actual].filter((mode) => !EXPECTED_SUITE_MODES.includes(mode));
  if (
    duplicates.length ||
    missing.length ||
    unexpected.length ||
    suites.length !== EXPECTED_SUITE_MODES.length
  ) {
    throw new Error(
      `Browser smoke suite modes mismatch: missing=${JSON.stringify(missing)}, duplicate=${JSON.stringify([...new Set(duplicates)])}, unexpected=${JSON.stringify(unexpected)}, count=${suites.length}.`
    );
  }
}

function makeCdpClient(browser, state) {
  let sequence = 0;
  let buffer = '';
  const pending = new Map();

  const failPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  browser.stderr.on('data', (chunk) => {
    state.diagnostics = `${state.diagnostics}${chunk.toString()}`.slice(-MAX_DIAGNOSTICS_LENGTH);
  });
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(frame);
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } catch (error) {
        failPending(error);
      }
    }
  });
  browser.on('error', (error) => failPending(error));
  browser.on('exit', (code, signal) => {
    failPending(
      new Error(
        `Browser exited before the smoke completed (code=${code}, signal=${signal}): ${state.diagnostics}`
      )
    );
  });

  const call = (method, params = {}, sessionId, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser timeout: ${method}; ${state.diagnostics}`));
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
      try {
        browser.stdio[3].write(
          `${JSON.stringify({ id, method, params, sessionId })}\0`,
          (error) => {
            if (error) {
              pending.delete(id);
              clearTimeout(timeout);
              reject(error);
            }
          }
        );
      } catch (error) {
        pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });

  return { call };
}

async function runBrowserSuites(executable, temporary, state) {
  const browser = spawn(
    executable,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      // Wide enough that viewport-gated panels stay enabled in headless mode.
      '--window-size=1400,900',
      `--user-data-dir=${path.join(temporary, 'profile')}`,
      '--remote-debugging-pipe',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  state.browserProcess = browser;
  const { call } = makeCdpClient(browser, state);
  const browserVersion = await call('Browser.getVersion');
  const browserMetadata = {
    executable: path.basename(executable),
    product: browserVersion.product,
    revision: browserVersion.revision,
    userAgent: browserVersion.userAgent,
  };
  if (!browserMetadata.product || !browserMetadata.revision || !browserMetadata.userAgent) {
    throw new Error('CDP Browser.getVersion returned incomplete browser version metadata.');
  }
  state.onBrowserMetadata(browserMetadata);

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
      expression: `new Promise((resolve) => {
  const finish = (value) => resolve(value);
  const start = Date.now();
  const poll = () => {
    if (globalThis.runFileRenderSmoke) {
      globalThis.runFileRenderSmoke().then(
        (suites) => finish({ suites }),
        (error) => finish({ error: String(error?.stack || error), suites: globalThis.fileRenderSmokeResults || [] })
      );
    } else if (Date.now() - start > 10000) {
      finish({ error: 'Smoke page failed to load', suites: globalThis.fileRenderSmokeResults || [] });
    } else {
      setTimeout(poll, 20);
    }
  };
  poll();
})`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
    120000
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)
    );
  }
  const value = result.result.value;
  state.suites = Array.isArray(value?.suites) ? value.suites : [];
  if (value?.error) {
    const error = new Error(value.error);
    error.partialSuites = state.suites;
    throw error;
  }
  validateSuites(state.suites);
}

function cleanupBrowser(browser) {
  if (!browser?.pid || browser.exitCode !== null || browser.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.kill();
      reject(new Error('Browser process did not exit during cleanup.'));
    }, 10000);
    browser.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      browser.kill();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

async function main() {
  const state = { browserProcess: null, diagnostics: '', suites: [] };
  let temporary;
  let failure;

  try {
    // Replace any previous result before discovery/build so a failed run cannot
    // leave a stale passed artifact behind.
    persistArtifact();
    persistDiagnostics();

    artifact.git = getGitMetadata();
    persistArtifact();

    const executable = findBrowser();
    artifact.browser = {
      executable: path.basename(executable),
      product: null,
      revision: null,
      userAgent: null,
    };
    persistArtifact();

    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-browser-smoke-'));
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
    // This script must execute after the parser opens <body>; the suites replace
    // body contents while exercising the renderer controllers.
    fs.writeFileSync(
      path.join(temporary, 'page/index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="smoke.css"><body><script src="smoke.js"></script></body>'
    );
    state.onBrowserMetadata = (metadata) => {
      artifact.browser = metadata;
      persistArtifact();
    };
    await runBrowserSuites(executable, temporary, state);
    artifact.suites = state.suites;
    artifact.suiteCount = state.suites.length;
  } catch (error) {
    if (Array.isArray(error?.partialSuites)) state.suites = error.partialSuites;
    artifact.suites = state.suites;
    artifact.suiteCount = state.suites.length;
    failure = error;
  }

  try {
    await cleanupBrowser(state.browserProcess);
  } catch (error) {
    failure = failure
      ? new Error(`${boundedError(failure)}\nCleanup: ${boundedError(error)}`)
      : error;
  }
  if (temporary) {
    try {
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      failure = failure
        ? new Error(`${boundedError(failure)}\nProfile cleanup: ${boundedError(error)}`)
        : error;
    }
  }

  artifact.diagnostics = state.diagnostics.slice(-MAX_DIAGNOSTICS_LENGTH);
  artifact.completedAt = new Date().toISOString();
  artifact.status = failure ? 'failed' : 'passed';
  artifact.passed = !failure;
  artifact.error = failure ? boundedError(failure) : null;

  try {
    persistDiagnostics();
    persistArtifact();
    const written = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (written.status !== artifact.status || written.passed !== artifact.passed) {
      throw new Error(`Browser smoke artifact verification failed at ${artifactPath}`);
    }
    if (!failure) {
      validateSuites(written.suites);
      if (
        typeof written.startedAt !== 'string' ||
        typeof written.completedAt !== 'string' ||
        !written.git?.commit ||
        typeof written.git.dirty !== 'boolean' ||
        !written.browser?.product ||
        !written.browser?.revision ||
        !written.browser?.userAgent
      ) {
        throw new Error(`Browser smoke artifact is missing required run metadata: ${artifactPath}`);
      }
      console.log(
        JSON.stringify(
          {
            artifact: artifactPath,
            diagnostics: diagnosticsPath,
            browser: artifact.browser,
            suiteCount: artifact.suiteCount,
            suites: artifact.suites,
          },
          null,
          2
        )
      );
      return;
    }
  } catch (error) {
    failure = failure
      ? new Error(`${boundedError(failure)}\nArtifact write: ${boundedError(error)}`)
      : error;
    artifact.status = 'failed';
    artifact.passed = false;
    artifact.error = boundedError(failure);
    artifact.completedAt = new Date().toISOString();
    try {
      persistDiagnostics();
      persistArtifact();
    } catch (fallbackError) {
      console.error(
        `Could not persist the browser smoke failure artifact: ${boundedError(fallbackError)}`
      );
    }
  }

  console.error(`Browser smoke failed; failure artifact: ${artifactPath}`);
  if (artifact.error) console.error(artifact.error);
  process.exitCode = 1;
}

await main();
