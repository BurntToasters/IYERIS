#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const version = process.env.CARGO_AUDIT_VERSION || '0.22.2';

function cargoAuditAvailable() {
  const result = spawnSync('cargo', ['audit', '--version'], { stdio: 'ignore' });
  return result.status === 0;
}

if (!cargoAuditAvailable()) {
  const result = spawnSync('cargo', ['install', 'cargo-audit', '--version', version, '--locked'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
