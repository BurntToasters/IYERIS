const { spawn } = require('child_process');

const tscBin = require.resolve('typescript/bin/tsc');
const targets = [
  ['--project', 'tsconfig.main.json', '--watch', '--preserveWatchOutput'],
  ['--project', 'tsconfig.renderer.json', '--watch', '--preserveWatchOutput'],
];
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

for (const args of targets) {
  const child = spawn(process.execPath, [tscBin, ...args], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      shutdown(0);
      return;
    }
    shutdown(code ?? 0);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
