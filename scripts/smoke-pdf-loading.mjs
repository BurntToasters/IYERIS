import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { createSmokeFiles, smokePaths } from '../build/pdf-loading-smoke.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'src');
const publicRoot = path.join(root, 'public');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const viteConfig = path.join(root, 'vite.config.ts');
const artifactPath = path.resolve(
  process.env.IYERIS_PDF_LOADING_ARTIFACT ||
    path.join(root, 'coverage-headless', 'pdf-loading-smoke-artifact.json')
);
const diagnosticsPath = path.join(path.dirname(artifactPath), 'pdf-loading-smoke-diagnostics.log');
const maxDiagnosticLength = 12000;
const artifact = {
  schemaVersion: 1,
  appVersion: packageJson.version,
  status: 'in-progress',
  passed: false,
  startedAt: new Date().toISOString(),
  completedAt: null,
  environment: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
  git: null,
  browser: null,
  checks: [],
  error: null,
};

function writeArtifact(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, filePath);
}

function persist() {
  writeArtifact(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function combineFailure(original, next, label) {
  if (!original) return next;
  return new Error(`${errorText(original)}\n${label}: ${errorText(next)}`);
}

function gitMetadata() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (commit.status !== 0 || status.status !== 0) throw new Error('Could not record git metadata');
  return { commit: commit.stdout.trim(), dirty: status.stdout.length > 0 };
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
    '/Applications/Helium.app/Contents/MacOS/Helium',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
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
  if (!executable) throw new Error('No Chromium browser found; set IYERIS_SMOKE_BROWSER');
  return executable;
}

function getTempBase() {
  if (process.platform !== 'linux' || !fs.existsSync('/snap')) return os.tmpdir();
  const base = path.join(os.homedir(), 'iyeris-tmp');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function makeCdp(browser, state) {
  let nextId = 0;
  let buffer = '';
  const pending = new Map();
  const listeners = new Set();
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  browser.stderr.on('data', (chunk) => {
    state.diagnostics = `${state.diagnostics}${chunk.toString()}`.slice(-maxDiagnosticLength);
  });
  browser.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(frame);
        if (message.method) {
          for (const listener of listeners) listener(message);
          continue;
        }
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } catch (error) {
        rejectPending(error);
      }
    }
  });
  browser.on('error', rejectPending);
  browser.on('exit', (code, signal) => {
    rejectPending(new Error(`Chromium exited (code=${code}, signal=${signal})`));
  });
  const call = (method, params = {}, sessionId, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      browser.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`, (error) => {
        if (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  return {
    call,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status} at ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite server did not become ready: ${lastError}`);
}

async function runPage(call, onEvent, baseUrl, mode, baselineTargetIds) {
  const result = {
    mode,
    url: `${baseUrl}/__iyeris_pdf_loading_smoke__.html`,
    runtimeErrors: [],
    networkErrors: [],
    requests: [],
    screenshot: null,
    app: null,
    overlay: null,
    workerTargets: [],
    allTargets: [],
  };
  const requests = new Map();
  let targetId;
  let sessionId;
  const listener = (event) => {
    if (event.method === 'Target.targetCreated') {
      const targetInfo = event.params?.targetInfo;
      if (targetInfo) {
        result.allTargets.push({
          targetId: targetInfo.targetId,
          type: targetInfo.type,
          url: targetInfo.url,
        });
      }
      return;
    }
    if (event.sessionId !== sessionId) return;
    const params = event.params || {};
    if (event.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      const frames = (details?.stackTrace?.callFrames || [])
        .slice(0, 4)
        .map((frame) => `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`);
      result.runtimeErrors.push(
        [details?.text, details?.exception?.description, ...frames].filter(Boolean).join(' at ') ||
          'Uncaught browser exception'
      );
    } else if (event.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      result.runtimeErrors.push(
        (params.args || [])
          .map((argument) => argument.value || argument.description || '')
          .join(' ')
      );
    } else if (event.method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, {
        url: params.request?.url || '',
        method: params.request?.method || '',
        status: null,
      });
    } else if (event.method === 'Network.responseReceived') {
      const request = requests.get(params.requestId);
      if (request) {
        request.status = params.response?.status ?? null;
        if (request.status >= 400) {
          result.networkErrors.push({
            url: request.url,
            status: request.status,
          });
        }
      }
    } else if (event.method === 'Network.loadingFailed') {
      const request = requests.get(params.requestId);
      result.networkErrors.push({
        url: request?.url || '',
        error: params.errorText || 'request failed',
        canceled: Boolean(params.canceled),
      });
    }
  };
  const targetsBefore = await call('Target.getTargets');
  const pageBaselineTargetIds = new Set([
    ...baselineTargetIds,
    ...(targetsBefore.targetInfos || []).map((targetInfo) => targetInfo.targetId),
  ]);
  const unsubscribe = onEvent(listener);
  try {
    const target = await call('Target.createTarget', { url: 'about:blank' });
    targetId = target.targetId;
    const attached = await call('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
    await call('Runtime.enable', {}, sessionId);
    await call('Page.enable', {}, sessionId);
    await call('Network.enable', {}, sessionId);
    await call('Log.enable', {}, sessionId);
    await call('Page.navigate', { url: result.url }, sessionId);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const evaluation = await call(
        'Runtime.evaluate',
        {
          expression: 'JSON.stringify(globalThis.__iyerisPdfLoadingSmoke || null)',
          returnByValue: true,
        },
        sessionId
      );
      const json = evaluation.result?.value;
      if (typeof json === 'string' && json !== 'null') {
        result.app = JSON.parse(json);
        if (result.app.status !== 'running') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result.app || result.app.status === 'running')
      throw new Error(`${mode} PDF smoke timed out`);
    const overlay = await call(
      'Runtime.evaluate',
      {
        expression:
          "(() => { const node = document.querySelector('vite-error-overlay'); return node ? (node.shadowRoot?.textContent || 'Vite error overlay present').slice(0, 1000) : null; })()",
        returnByValue: true,
      },
      sessionId
    );
    result.overlay = overlay.result?.value ?? null;
    const targets = await call('Target.getTargets');
    result.allTargets.push(
      ...(targets.targetInfos || []).map((targetInfo) => ({
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        url: targetInfo.url,
      }))
    );
    result.requests = [...requests.values()];
    result.workerTargets = result.allTargets
      .filter(
        (targetInfo) =>
          targetInfo.type === 'worker' &&
          !pageBaselineTargetIds.has(targetInfo.targetId) &&
          targetInfo.targetId !== undefined
      )
      .filter(
        (targetInfo, index, targetsForPage) =>
          targetsForPage.findIndex((candidate) => candidate.targetId === targetInfo.targetId) ===
          index
      )
      .map((targetInfo) => ({
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        url: targetInfo.url || result.app.workerSrc,
        urlObservedByCdp: Boolean(targetInfo.url),
      }));
    const expectedWorkerUrl = new URL(result.app.workerSrc, baseUrl).href;
    result.workerRequests = result.requests.filter((request) =>
      request.url.startsWith(expectedWorkerUrl)
    );
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
    const screenshotBytes = Buffer.from(screenshot.data, 'base64');
    if (
      screenshotBytes.length < 100 ||
      !screenshotBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw new Error(`${mode} screenshot was not valid PNG data`);
    }
    result.screenshot = `${mode}-pdf-loading.png`;
    writeArtifact(path.join(path.dirname(artifactPath), result.screenshot), screenshotBytes);
    if (result.app.status !== 'complete')
      throw new Error(`${mode} app status: ${result.app.error}`);
    if (!result.app.loaded || result.app.pageCount !== 1)
      throw new Error(`${mode} PDF did not load one page`);
    if (!result.app.destroyed || !result.app.destroyedAfterReopen) {
      throw new Error(`${mode} PDF viewer did not close cleanly before and after reopening`);
    }
    if (!result.app.canvas?.nonWhitePixels) throw new Error(`${mode} PDF canvas was empty`);
    if (!result.app.failure?.callbackMessage)
      throw new Error(`${mode} PDF failure was not reported clearly`);
    if (result.overlay) throw new Error(`${mode} Vite error overlay: ${result.overlay}`);
    if (result.runtimeErrors.length)
      throw new Error(`${mode} runtime errors: ${result.runtimeErrors.join('; ')}`);
    if (result.networkErrors.length) {
      throw new Error(`${mode} network errors: ${JSON.stringify(result.networkErrors)}`);
    }
    if (result.workerTargets.length === 0 || result.workerRequests.length === 0) {
      throw new Error(
        `${mode} pdf.js worker did not start: ${JSON.stringify(result.workerTargets)}`
      );
    }
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.stack || error.message : String(error);
    error.partialCheck = result;
    throw error;
  } finally {
    unsubscribe();
    if (targetId) {
      await call('Target.closeTarget', { targetId }).catch(() => {});
    }
  }
}

async function startBrowser(executable, temporary, diagnosticsState) {
  const browser = spawn(
    executable,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1280,900',
      `--user-data-dir=${path.join(temporary, 'profile')}`,
      '--remote-debugging-pipe',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  const cdp = makeCdp(browser, diagnosticsState);
  const metadata = await cdp.call('Browser.getVersion', {}, undefined, 120000);
  if (!metadata.product || !metadata.revision) throw new Error('Incomplete Chromium metadata');
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  const targets = await cdp.call('Target.getTargets');
  const baselineTargetIds = new Set(
    (targets.targetInfos || []).map((targetInfo) => targetInfo.targetId)
  );
  return { browser, cdp, metadata, baselineTargetIds };
}

function assertArtifact() {
  const written = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  if (written.status !== artifact.status || written.passed !== artifact.passed) {
    throw new Error(`Artifact did not persist at ${artifactPath}`);
  }
  if (!written.git?.commit || typeof written.git.dirty !== 'boolean') {
    if (written.passed) throw new Error('Artifact is missing git metadata');
  }
  if (!written.browser?.product || !written.browser?.revision) {
    if (written.passed) throw new Error('Artifact is missing browser metadata');
  }
  for (const check of written.checks) {
    if (typeof check.screenshot !== 'string') {
      if (written.passed) throw new Error(`Passed check ${check.mode} has no screenshot`);
      continue;
    }
    if (!fs.existsSync(path.join(path.dirname(artifactPath), check.screenshot))) {
      throw new Error(`Screenshot artifact is missing: ${check.screenshot}`);
    }
  }
}

async function main() {
  let fixturePaths = null;
  let devServer = null;
  let previewServer = null;
  let browser = null;
  let temporary = null;
  let failure;
  const diagnosticsState = { diagnostics: '' };
  const cleanupStep = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failure = combineFailure(failure, error, label);
    }
  };
  try {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    persist();
    fs.mkdirSync(publicRoot, { recursive: true });
    artifact.git = gitMetadata();
    const executable = findBrowser();
    temporary = fs.mkdtempSync(path.join(getTempBase(), 'iyeris-pdf-loading-'));
    const productionRoot = path.join(temporary, 'production');
    fixturePaths = createSmokeFiles(sourceRoot);

    const devPort = await availablePort();
    devServer = await createServer({
      configFile: viteConfig,
      root: sourceRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: devPort, strictPort: true, open: false },
    });
    await devServer.listen();
    const devUrl = `http://127.0.0.1:${devPort}`;
    await waitForHttp(`${devUrl}/__iyeris_pdf_loading_smoke__.html`);

    const vendorCopy = spawnSync(process.execPath, [path.join(root, 'scripts/copy-vendor.js')], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (vendorCopy.status !== 0) throw new Error(`copy-vendor failed: ${vendorCopy.stderr}`);
    await build({
      configFile: viteConfig,
      root: sourceRoot,
      logLevel: 'error',
      build: {
        outDir: productionRoot,
        emptyOutDir: true,
        rolldownOptions: {
          input: {
            main: path.join(sourceRoot, 'index.html'),
            pdfLoadingSmoke: fixturePaths.htmlPath,
          },
        },
      },
    });
    const previewPort = await availablePort();
    previewServer = await preview({
      configFile: viteConfig,
      root: sourceRoot,
      logLevel: 'error',
      build: { outDir: productionRoot },
      preview: { host: '127.0.0.1', port: previewPort, strictPort: true },
    });
    const previewUrl = `http://127.0.0.1:${previewPort}`;
    await waitForHttp(`${previewUrl}/__iyeris_pdf_loading_smoke__.html`);

    const started = await startBrowser(executable, temporary, diagnosticsState);
    browser = started.browser;
    artifact.browser = {
      executable: path.basename(executable),
      product: started.metadata.product,
      revision: started.metadata.revision,
      userAgent: started.metadata.userAgent,
    };
    artifact.checks.push(
      await runPage(started.cdp.call, started.cdp.onEvent, devUrl, 'dev', started.baselineTargetIds)
    );
    artifact.checks.push(
      await runPage(
        started.cdp.call,
        started.cdp.onEvent,
        previewUrl,
        'production',
        started.baselineTargetIds
      )
    );
  } catch (error) {
    if (error?.partialCheck) artifact.checks.push(error.partialCheck);
    failure = error;
  } finally {
    if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
      await cleanupStep(
        'Browser cleanup',
        () =>
          new Promise((resolve, reject) => {
            const onExit = () => {
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(() => {
              try {
                browser.kill();
                resolve();
              } catch (error) {
                browser.off('exit', onExit);
                reject(error);
              }
            }, 10000);
            browser.once('exit', onExit);
            try {
              browser.kill();
            } catch (error) {
              clearTimeout(timeout);
              browser.off('exit', onExit);
              reject(error);
            }
          })
      );
    }
    if (previewServer) await cleanupStep('Preview server cleanup', () => previewServer.close());
    if (devServer) await cleanupStep('Dev server cleanup', () => devServer.close());
    if (fixturePaths) {
      for (const filePath of smokePaths(sourceRoot)) {
        await cleanupStep(`Fixture cleanup (${filePath})`, () =>
          fs.rmSync(filePath, { force: true })
        );
      }
    }
    if (temporary) {
      await cleanupStep('Temporary directory cleanup', () =>
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 })
      );
    }
  }

  artifact.completedAt = new Date().toISOString();
  artifact.status = failure ? 'failed' : 'passed';
  artifact.passed = !failure;
  artifact.error = failure ? failure.stack || String(failure) : null;
  artifact.diagnostics = diagnosticsState.diagnostics.slice(-maxDiagnosticLength);
  writeArtifact(diagnosticsPath, `${artifact.diagnostics}\n`);
  persist();
  try {
    assertArtifact();
  } catch (error) {
    failure = combineFailure(failure, error, 'Artifact validation');
    artifact.status = 'failed';
    artifact.passed = false;
    artifact.error = errorText(failure);
    persist();
  }
  console.log(
    JSON.stringify(
      { artifact: artifactPath, status: artifact.status, error: artifact.error },
      null,
      2
    )
  );
  if (failure || !artifact.passed) process.exitCode = 1;
}

await main();
