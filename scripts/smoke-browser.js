import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
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
  'visual-uplift',
];
const MAX_ERROR_LENGTH = 4000;
const MAX_DIAGNOSTICS_LENGTH = 8000;
// The page calls this binding to ask Node for a screenshot and then waits for the reply.
const SCREENSHOT_BINDING = 'iyerisSmokeScreenshot';
const SCREENSHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCREENSHOT_FILE_RE = /^browser-smoke-[a-z0-9-]+\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  screenshots: [],
  buildCss: null,
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
  if (!executable) {
    throw new Error(
      'No installed Chromium browser was found. Set IYERIS_SMOKE_BROWSER to an existing browser executable.'
    );
  }
  return executable;
}

// Snap Chromium cannot read file:// pages under its private /tmp.
function getTempBase() {
  if (process.platform !== 'linux' || !fs.existsSync('/snap')) return os.tmpdir();
  const base = path.join(os.homedir(), 'iyeris-tmp');
  fs.mkdirSync(base, { recursive: true });
  return base;
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
  const listeners = new Set();

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
        // Events have a method and no id. Responses have an id and no method.
        if (typeof message.method === 'string') {
          for (const listener of listeners) listener(message);
          continue;
        }
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

  const onEvent = (listener) => {
    listeners.add(listener);
  };

  return { call, onEvent };
}

// Chromium ignores the -webkit- prefixed backdrop-filter, so every rule that sets the prefixed
// form must also set the unprefixed one. Counts are global. Per-rule checking reads each
// innermost { ... } block, which is safe for minified output because declaration values never
// contain braces.
function auditBackdropFilterCss(cssText) {
  const unprefixed = (cssText.match(/(?<![-\w])backdrop-filter\s*:/g) || []).length;
  const prefixed = (cssText.match(/-webkit-backdrop-filter\s*:/g) || []).length;
  const prefixOnlySelectors = [];
  for (const match of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2];
    if (/-webkit-backdrop-filter\s*:/.test(body) && !/(?<![-\w])backdrop-filter\s*:/.test(body)) {
      prefixOnlySelectors.push(match[1].trim().slice(0, 160));
    }
  }
  return {
    file: 'smoke.css',
    unprefixedBackdropFilter: unprefixed,
    prefixedBackdropFilter: prefixed,
    prefixOnlyRules: prefixOnlySelectors.length,
    prefixOnlySelectors: prefixOnlySelectors.slice(0, 5),
  };
}

function removeStaleScreenshots() {
  const directory = path.dirname(artifactPath);
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    if (SCREENSHOT_FILE_RE.test(entry)) fs.rmSync(path.join(directory, entry), { force: true });
  }
}

// Writes one page-requested PNG to coverage-headless/browser-smoke-<name>.png.
// Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what Page.captureScreenshot emits) into raw
// pixels. Every filter type is applied, so the result matches the rendered image exactly.
function decodePng(buffer) {
  let offset = PNG_SIGNATURE.length;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (
    !header ||
    header.bitDepth !== 8 ||
    header.interlace !== 0 ||
    ![2, 6].includes(header.colorType)
  ) {
    throw new Error('Unsupported PNG layout for pixel sampling.');
  }
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * header.height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else throw new Error(`Unknown PNG filter ${filter}.`);
      current[x] = (line[x] + predicted) & 0xff;
    }
    previous = current;
  }
  return { width: header.width, height: header.height, channels, pixels };
}

// Luminance mean and standard deviation over a rectangle given in CSS pixels. The rectangle is
// scaled to the image, so the device pixel ratio does not matter.
function regionLuminance(image, region, viewportWidth) {
  const scale = image.width / viewportWidth;
  const x0 = Math.max(0, Math.floor(region.x * scale));
  const y0 = Math.max(0, Math.floor(region.y * scale));
  const x1 = Math.min(image.width, Math.ceil((region.x + region.width) * scale));
  const y1 = Math.min(image.height, Math.ceil((region.y + region.height) * scale));
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * image.width + x) * image.channels;
      const luma =
        0.299 * image.pixels[index] +
        0.587 * image.pixels[index + 1] +
        0.114 * image.pixels[index + 2];
      count += 1;
      sum += luma;
      sumSquares += luma * luma;
    }
  }
  if (count === 0) throw new Error(`Pixel region ${region.name} is empty at this scale.`);
  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);
  return {
    name: region.name,
    pixels: count,
    mean: Number(mean.toFixed(2)),
    stdDev: Number(Math.sqrt(variance).toFixed(3)),
  };
}

async function captureNamedScreenshot(call, sessionId, state, request) {
  const name = request?.name;
  if (typeof name !== 'string' || !SCREENSHOT_NAME_RE.test(name)) {
    throw new Error(`Invalid smoke screenshot name ${JSON.stringify(name)}.`);
  }
  if (state.screenshots.some((shot) => shot.name === name)) {
    throw new Error(`Duplicate smoke screenshot name ${name}.`);
  }
  const { data } = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  const bytes = Buffer.from(data, 'base64');
  if (
    bytes.length <= PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`Page.captureScreenshot returned non-PNG data for ${name}.`);
  }
  const file = `browser-smoke-${name}.png`;
  atomicWrite(path.join(path.dirname(artifactPath), file), bytes);
  const shot = { name, file, bytes: bytes.length, regions: [] };
  if (Array.isArray(request.regions) && request.regions.length > 0) {
    const image = decodePng(bytes);
    shot.regions = request.regions.map((region) =>
      regionLuminance(image, region, request.viewportWidth)
    );
  }
  state.screenshots.push(shot);
  return shot;
}

async function serviceScreenshotRequest(call, sessionId, state, payload) {
  const request = JSON.parse(payload);
  let reply;
  try {
    const shot = await captureNamedScreenshot(call, sessionId, state, request);
    reply = { id: request.id, error: null, file: shot.file, regions: shot.regions };
  } catch (error) {
    reply = {
      id: request.id,
      error: String(error?.message || error).slice(0, 500),
      file: null,
    };
  }
  // The page is waiting on this reply, so a rejected reply also fails the run.
  await call(
    'Runtime.evaluate',
    {
      expression: `globalThis.__iyerisSmokeScreenshotSettle(${JSON.stringify(reply)})`,
      returnByValue: true,
    },
    sessionId
  );
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
  const { call, onEvent } = makeCdpClient(browser, state);
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
  // Runtime events carry bindingCalled notifications. Register the binding before navigating
  // so the smoke page can request screenshots from its first suite onward.
  await call('Runtime.enable', {}, sessionId);
  await call('Runtime.addBinding', { name: SCREENSHOT_BINDING }, sessionId);
  let screenshotQueue = Promise.resolve();
  onEvent((message) => {
    if (message.method !== 'Runtime.bindingCalled' || message.sessionId !== sessionId) return;
    if (message.params?.name !== SCREENSHOT_BINDING) return;
    // Requests run one at a time, in the order the page sent them.
    screenshotQueue = screenshotQueue
      .then(() => serviceScreenshotRequest(call, sessionId, state, message.params.payload))
      .catch((error) => {
        state.screenshotFailure = state.screenshotFailure || error;
      });
  });
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
      finish({
        error: 'Smoke page failed to load (a snap-confined browser cannot read pages under /tmp; use a folder in your home directory)',
        suites: globalThis.fileRenderSmokeResults || [],
      });
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
  if (state.screenshotFailure) throw state.screenshotFailure;
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
  const state = { browserProcess: null, diagnostics: '', suites: [], screenshots: [] };
  let temporary;
  let failure;

  try {
    // Replace any previous result before discovery/build so a failed run cannot
    // leave a stale passed artifact behind.
    removeStaleScreenshots();
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

    temporary = fs.mkdtempSync(path.join(getTempBase(), 'iyeris-browser-smoke-'));
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
    // Fail before any browser runs if the minifier dropped an unprefixed backdrop-filter.
    artifact.buildCss = auditBackdropFilterCss(
      fs.readFileSync(path.join(temporary, 'page/smoke.css'), 'utf8')
    );
    if (artifact.buildCss.prefixOnlyRules > 0) {
      throw new Error(
        `Built CSS has ${artifact.buildCss.prefixOnlyRules} rule(s) with -webkit-backdrop-filter but no unprefixed backdrop-filter: ${JSON.stringify(artifact.buildCss.prefixOnlySelectors)}`
      );
    }
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
  artifact.screenshots = state.screenshots;
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
      if (!written.buildCss || written.buildCss.prefixOnlyRules !== 0) {
        throw new Error(`Browser smoke built CSS audit is missing or failing: ${artifactPath}`);
      }
      // Every screenshot a suite names must exist on disk and be listed in the artifact.
      const suiteShots = written.suites.flatMap((suite) => suite.screenshots ?? []);
      const recordedShots = written.screenshots.map((shot) => shot.name);
      if (JSON.stringify(suiteShots) !== JSON.stringify(recordedShots)) {
        throw new Error(
          `Browser smoke screenshots mismatch: suites=${JSON.stringify(suiteShots)}, recorded=${JSON.stringify(recordedShots)}.`
        );
      }
      for (const shot of written.screenshots) {
        const shotPath = path.join(path.dirname(artifactPath), shot.file);
        if (!fs.existsSync(shotPath) || fs.statSync(shotPath).size !== shot.bytes) {
          throw new Error(`Browser smoke screenshot is missing or truncated: ${shotPath}`);
        }
      }
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
