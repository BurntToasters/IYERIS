import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const architecture = process.argv[2] === 'arm64' ? 'arm64' : 'x64';
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const launchVsDevShell =
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\Tools\\Launch-VsDevShell.ps1';
const architectureArgs = architecture === 'arm64' ? ['-Arch', 'arm64', '-HostArch', 'amd64'] : [];

if (process.platform !== 'win32') {
  console.error('The Visual Studio developer PowerShell is only available on Windows.');
  process.exit(1);
}
if (!existsSync(launchVsDevShell)) {
  console.error(`Visual Studio developer shell was not found: ${launchVsDevShell}`);
  process.exit(1);
}

const result = spawnSync(
  powershell,
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-NoExit',
    '-File',
    launchVsDevShell,
    '-SkipAutomaticLocation',
    ...architectureArgs,
  ],
  {
    stdio: 'inherit',
    windowsHide: false,
  }
);

if (result.error) {
  console.error(`Failed to open Visual Studio developer shell: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
