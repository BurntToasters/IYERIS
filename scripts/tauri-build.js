import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const isPrerelease = /-(?:beta|alpha|rc)(?:[.-]?\d+)?/i.test(pkg.version);

const rawArgs = process.argv.slice(2);
const args = [];
const requireMacSigning = rawArgs.includes('--require-macos-signing');
const requireMacNotarization = rawArgs.includes('--require-macos-notarization');
const requireTauriSigning = rawArgs.includes('--require-tauri-signing');
const requireWindowsSigning = rawArgs.includes('--require-windows-signing');
const skipWindowsCodeSigning = process.env.SKIP_WIN_CODESIGN?.trim() === '1';

for (const arg of rawArgs) {
  if (
    arg === '--require-macos-signing' ||
    arg === '--require-macos-notarization' ||
    arg === '--require-tauri-signing' ||
    arg === '--require-windows-signing'
  ) {
    continue;
  }
  args.push(arg);
}

const hasEnvValue = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
};

function getArgValue(flagName) {
  const idx = args.indexOf(flagName);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flagName}=`;
  const entry = args.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

function isMacBuildTarget() {
  const target = getArgValue('--target');
  if (target) return /apple-darwin/i.test(target);
  return process.platform === 'darwin';
}

function isWindowsBuildTarget() {
  const target = getArgValue('--target');
  if (target) return /windows/i.test(target);
  return process.platform === 'win32';
}

function getBundlesArgMeta() {
  const idx = args.indexOf('--bundles');
  if (idx !== -1) {
    return {
      index: idx,
      inline: false,
      value: idx + 1 < args.length ? args[idx + 1] : '',
    };
  }

  const inlineIdx = args.findIndex((arg) => arg.startsWith('--bundles='));
  if (inlineIdx !== -1) {
    return {
      index: inlineIdx,
      inline: true,
      value: args[inlineIdx].slice('--bundles='.length),
    };
  }

  return null;
}

function hasNoBundleFlag() {
  return args.includes('--no-bundle');
}

function assertTauriSigningConfigured() {
  if (!requireTauriSigning || hasNoBundleFlag()) return;

  if (!hasEnvValue('TAURI_SIGNING_PRIVATE_KEY')) {
    console.error(
      '[tauri-build] Missing required env var for signed builds: TAURI_SIGNING_PRIVATE_KEY'
    );
    process.exit(1);
  }
}

function assertWindowsSigningConfigured() {
  if (!requireWindowsSigning) return;
  if (!isWindowsBuildTarget()) {
    console.error('[tauri-build] --require-windows-signing requires a Windows build target.');
    process.exit(1);
  }
  if (hasNoBundleFlag()) {
    console.error('[tauri-build] --require-windows-signing cannot be combined with --no-bundle.');
    process.exit(1);
  }
  if (process.platform !== 'win32') {
    console.error('[tauri-build] Authenticode release builds must run on Windows.');
    process.exit(1);
  }
  if (skipWindowsCodeSigning) {
    console.warn('[tauri-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.');
    return;
  }

  const requiredVars = [
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT',
    'AZURE_ARTIFACT_SIGNING_ACCOUNT',
    'AZURE_ARTIFACT_SIGNING_PROFILE',
    'AZURE_ARTIFACT_SIGNING_PUBLISHER',
  ];
  const missingVars = requiredVars.filter((name) => !hasEnvValue(name));
  if (missingVars.length > 0) {
    console.error(
      `[tauri-build] Missing required Azure Artifact Signing env vars: ${missingVars.join(', ')}`
    );
    process.exit(1);
  }
}

function getWindowsTargetReleaseDir() {
  const target = getArgValue('--target');
  const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  return target
    ? path.join(root, 'src-tauri', 'target', target, 'release')
    : path.join(root, 'src-tauri', 'target', 'release');
}

function signFinalWindowsRuntimeArtifacts() {
  if (!requireWindowsSigning || skipWindowsCodeSigning) return;

  const targetReleaseDir = getWindowsTargetReleaseDir();
  const signScript = fileURLToPath(new URL('./windows-artifact-sign.ps1', import.meta.url));
  const runtimeExecutables = readdirSync(targetReleaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => path.join(targetReleaseDir, entry.name));

  if (runtimeExecutables.length === 0) {
    throw new Error(`No final Windows runtime executables found under ${targetReleaseDir}`);
  }

  for (const executable of runtimeExecutables) {
    console.log(`[tauri-build] Finalizing Authenticode signature: ${executable}`);
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        signScript,
        '-FilePath',
        executable,
      ],
      { stdio: 'inherit', env: process.env }
    );
  }
}

function verifyWindowsArtifacts() {
  if (!requireWindowsSigning || skipWindowsCodeSigning) return;

  const targetReleaseDir = getWindowsTargetReleaseDir();
  const verifyScript = fileURLToPath(new URL('./verify-windows-authenticode.ps1', import.meta.url));

  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      verifyScript,
      '-TargetReleaseDir',
      targetReleaseDir,
    ],
    { stdio: 'inherit', env: process.env }
  );
}

function setBundlesArg(value) {
  const existing = getBundlesArgMeta();
  if (!existing) {
    args.push('--bundles', value);
    return;
  }
  if (existing.inline) {
    args[existing.index] = `--bundles=${value}`;
    return;
  }
  if (existing.index + 1 < args.length) {
    args[existing.index + 1] = value;
  } else {
    args.push(value);
  }
}

function stripMsiBundleForPrereleaseWindows() {
  if (!isPrerelease || !isWindowsBuildTarget()) {
    return;
  }

  if (hasNoBundleFlag()) {
    console.log(`[tauri-build] Pre-release detected (${pkg.version}); --no-bundle requested.`);
    return;
  }

  const bundlesMeta = getBundlesArgMeta();
  if (!bundlesMeta) {
    setBundlesArg('nsis');
    console.log(
      `[tauri-build] Pre-release detected (${pkg.version}); forcing bundles to nsis (MSI disabled).`
    );
    return;
  }

  const requestedBundles = bundlesMeta.value
    .split(',')
    .map((bundle) => bundle.trim())
    .filter(Boolean);
  const filteredBundles = requestedBundles.filter((bundle) => bundle.toLowerCase() !== 'msi');

  if (filteredBundles.length === requestedBundles.length) {
    console.log(`[tauri-build] Pre-release detected (${pkg.version}); MSI already excluded.`);
    return;
  }

  const nextBundles = filteredBundles.length > 0 ? filteredBundles : ['nsis'];
  setBundlesArg(nextBundles.join(','));
  console.log(
    `[tauri-build] Pre-release detected (${pkg.version}); removed MSI bundle (${requestedBundles.join(',')} -> ${nextBundles.join(',')}).`
  );
}

function applyMacEnvCompatibility() {
  const legacyAppSpecificPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  if (!hasEnvValue('APPLE_PASSWORD') && typeof legacyAppSpecificPassword === 'string') {
    const trimmed = legacyAppSpecificPassword.trim();
    if (trimmed.length > 0) {
      process.env.APPLE_PASSWORD = trimmed;
      console.log(
        '[tauri-build] Using APPLE_APP_SPECIFIC_PASSWORD as APPLE_PASSWORD (legacy compatibility).'
      );
    }
  }
}

function assertSigningIdentityAvailable() {
  if (process.platform !== 'darwin' || !hasEnvValue('APPLE_SIGNING_IDENTITY')) return;
  const identity = process.env.APPLE_SIGNING_IDENTITY.trim();
  let identitiesOutput = '';

  try {
    identitiesOutput = execSync('security find-identity -v -p codesigning', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    throw new Error(
      stderr
        ? `Unable to inspect keychain code-signing identities: ${stderr}`
        : 'Unable to inspect keychain code-signing identities.'
    );
  }

  if (/0 valid identities found/i.test(identitiesOutput)) {
    throw new Error(
      'No valid code-signing identities found in keychain. If this is an SSH session, run `npm run mac:ssh:keychain` first.'
    );
  }

  if (!identitiesOutput.includes(identity)) {
    throw new Error(`APPLE_SIGNING_IDENTITY "${identity}" was not found in keychain identities.`);
  }
}

if (isMacBuildTarget()) {
  applyMacEnvCompatibility();

  const missingVars = [];
  if (requireMacSigning && !hasEnvValue('APPLE_SIGNING_IDENTITY')) {
    missingVars.push('APPLE_SIGNING_IDENTITY');
  }
  if (requireMacNotarization) {
    for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
      if (!hasEnvValue(key)) missingVars.push(key);
    }
  }

  if (missingVars.length > 0) {
    console.error(
      `[tauri-build] Missing required macOS signing/notarization env vars: ${missingVars.join(', ')}`
    );
    process.exit(1);
  }

  if (requireMacSigning) {
    try {
      assertSigningIdentityAvailable();
    } catch (error) {
      console.error(`[tauri-build] ${error?.message || error}`);
      process.exit(1);
    }
  }
}

assertTauriSigningConfigured();
assertWindowsSigningConfigured();
stripMsiBundleForPrereleaseWindows();

const tauriBuildArgs = args.join(' ').trim();
const tauriBuildCommand = tauriBuildArgs ? `npx tauri build ${tauriBuildArgs}` : 'npx tauri build';
execSync(tauriBuildCommand, { stdio: 'inherit' });
signFinalWindowsRuntimeArtifacts();
verifyWindowsArtifacts();
