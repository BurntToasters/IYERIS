#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PIN_FILE = 'rust-toolchain.toml';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/u;
const USAGE =
  'Usage: node scripts/rust-toolchain.mjs [--print | --install | --default | --target <triple> ...]';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stripTomlComment(line) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseStringValue(key, value) {
  const match = /^"([^"\\]*)"$/u.exec(value.trim());
  if (!match) {
    throw new Error(`rust-toolchain.toml [toolchain] ${key} must be a double-quoted string`);
  }
  return match[1];
}

function parseComponents(value) {
  const start = value.indexOf('[');
  const end = value.lastIndexOf(']');
  if (start === -1 || end < start) {
    throw new Error('rust-toolchain.toml [toolchain] components must be a single array');
  }
  if (value.slice(end + 1).trim()) {
    throw new Error('rust-toolchain.toml [toolchain] components has trailing content');
  }

  const entries = value
    .slice(start + 1, end)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const match = /^"([^"\\]*)"$/u.exec(entry);
    if (!match || !SAFE_TOKEN.test(match[1])) {
      throw new Error('rust-toolchain.toml [toolchain] components must be component names');
    }
    return match[1];
  });
}

export function readRustToolchainConfig(root) {
  const filePath = path.join(root, PIN_FILE);
  let contents;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Rust toolchain pin is missing: ${filePath}`, { cause: error });
    }
    throw error;
  }

  const config = { components: [], profile: undefined, channel: undefined };
  const seen = new Set();
  let section = null;
  let pendingArray = null;

  function record(key, value) {
    if (key === 'components') {
      if (seen.has(key)) throw new Error('rust-toolchain.toml [toolchain] repeats components');
      seen.add(key);
      config.components = [...new Set(parseComponents(value))];
      return;
    }
    if (key === 'channel' || key === 'profile') {
      if (seen.has(key)) {
        throw new Error(`rust-toolchain.toml [toolchain] repeats ${key}`);
      }
      seen.add(key);
      config[key] = parseStringValue(key, value);
    }
  }

  const lines = contents.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();

    if (pendingArray !== null) {
      pendingArray.value += `\n${line}`;
      if (line.includes(']')) {
        record(pendingArray.key, pendingArray.value);
        pendingArray = null;
      }
      continue;
    }

    if (!line) continue;

    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }

    if (section !== 'toolchain') continue;

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
    if (!assignment) {
      throw new Error(`rust-toolchain.toml [toolchain] has a malformed line: ${line}`);
    }
    const [, key, value] = assignment;
    if (value.startsWith('[') && !value.includes(']')) {
      pendingArray = { key, value };
      continue;
    }
    record(key, value);
  }

  if (pendingArray !== null) {
    throw new Error('rust-toolchain.toml [toolchain] has an unterminated array');
  }
  if (!config.channel || !EXACT_VERSION.test(config.channel)) {
    throw new Error(
      `rust-toolchain.toml must pin an exact Rust version; found ${config.channel || 'no channel'}`
    );
  }

  const profile = config.profile ?? 'minimal';
  if (!SAFE_TOKEN.test(profile)) {
    throw new Error(`rust-toolchain.toml [toolchain] has an invalid profile: ${profile}`);
  }

  return { channel: config.channel, profile, components: config.components };
}

export function readPinnedRustToolchain(root) {
  return readRustToolchainConfig(root).channel;
}

function runRustup(args) {
  const result = spawnSync('rustup', args, { stdio: 'inherit', shell: false });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('rustup was not found on PATH', { cause: result.error });
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.signal
      ? `was terminated by ${result.signal}`
      : `failed with exit code ${result.status}`;
    throw new Error(`rustup ${args.join(' ')} ${detail}`);
  }
}

function main({ root = repoRoot, argv = process.argv.slice(2) } = {}) {
  const [command, ...rest] = argv;
  const config = readRustToolchainConfig(root);

  if (!command || command === '--print') {
    if (rest.length > 0) throw new Error(USAGE);
    console.log(config.channel);
    return;
  }

  if (command === '--install') {
    if (rest.length > 0) throw new Error(USAGE);
    const args = ['toolchain', 'install', config.channel, '--profile', config.profile];
    if (config.components.length > 0) {
      args.push('--component', config.components.join(','));
    }
    runRustup(args);
    return;
  }

  if (command === '--default') {
    if (rest.length > 0) throw new Error(USAGE);
    runRustup(['default', config.channel]);
    return;
  }

  if (command === '--target') {
    if (
      rest.length === 0 ||
      rest.some((target) => target.startsWith('-') || !SAFE_TOKEN.test(target))
    ) {
      throw new Error(USAGE);
    }
    runRustup(['target', 'add', '--toolchain', config.channel, ...rest]);
    return;
  }

  throw new Error(`Unknown argument: ${command}\n${USAGE}`);
}

const isMainModule =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`rust-toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
