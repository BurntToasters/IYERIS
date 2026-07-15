import { spawnSync } from 'node:child_process';

const architecture = process.argv[2] === 'arm64' ? 'arm64' : 'x64';
const commandProcessor = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const vsDevCmd =
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\Tools\\VsDevCmd.bat';
const architectureArgs =
  architecture === 'arm64' ? ['-arch=arm64', '-host_arch=amd64'] : ['-arch=amd64'];

const result = spawnSync(commandProcessor, ['/K', vsDevCmd, '-no_logo', ...architectureArgs], {
  stdio: 'inherit',
  windowsHide: false,
});

if (result.error) {
  console.error(`Failed to open Visual Studio developer shell: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
