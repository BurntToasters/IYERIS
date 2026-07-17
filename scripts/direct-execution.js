import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function comparablePath(value, platform = process.platform) {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Tests and diagnostics may compare synthetic paths that do not exist.
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(left, right, platform = process.platform) {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

export function isDirectExecution(importMetaUrl, argv = process.argv, platform = process.platform) {
  return Boolean(argv[1] && pathsEqual(argv[1], fileURLToPath(importMetaUrl), platform));
}
