import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const isPrerelease = /-(?:beta|alpha|rc)(?:[.-]?\d+)?/i.test(pkg.version);

const rawArgs = process.argv.slice(2);
const args = [];
const requireMacSigning = rawArgs.includes('--require-macos-signing');
const requireMacNotarization = rawArgs.includes('--require-macos-notarization');

for (const arg of rawArgs) {
  if (arg === '--require-macos-signing' || arg === '--require-macos-notarization') continue;
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

stripMsiBundleForPrereleaseWindows();

const tauriBuildArgs = args.join(' ').trim();
const tauriBuildCommand = tauriBuildArgs ? `npx tauri build ${tauriBuildArgs}` : 'npx tauri build';
execSync(tauriBuildCommand, { stdio: 'inherit' });
