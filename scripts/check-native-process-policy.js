import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// crates/ is the IYERIS 4 root Cargo workspace and may not exist yet.
const rustRoots = [join(root, 'src-tauri', 'src'), join(root, 'crates')];

function rustFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'target' ? [] : rustFiles(path);
    return extname(entry.name) === '.rs' ? [path] : [];
  });
}

const forbiddenRuntimeFragments = [
  'Command::new("powershell")',
  'Command::new("pwsh")',
  'Command::new("cmd")',
  'Command::new("reg")',
  'Command::new("attrib")',
  'Command::new("where")',
  'Command::new("defaults")',
  'Command::new("pbcopy")',
  'Command::new("pbpaste")',
  'Command::new("sysctl")',
  'Command::new("swift")',
  'ExecutionPolicy Bypass',
  'EncodedCommand',
  'Start-Process',
  '.args(["--", "sh", "-c"',
];

const violations = [];
for (const file of rustRoots.flatMap((rustRoot) => rustFiles(rustRoot))) {
  const source = readFileSync(file, 'utf8');
  for (const fragment of forbiddenRuntimeFragments) {
    if (source.includes(fragment)) {
      violations.push(`${relative(root, file)} contains ${JSON.stringify(fragment)}`);
    }
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allowedPowerShellScripts = new Set(['setup:win:artifact-signing']);
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  for (const fragment of ['powershell', 'ExecutionPolicy Bypass', 'EncodedCommand']) {
    if (
      command.toLowerCase().includes(fragment.toLowerCase()) &&
      !allowedPowerShellScripts.has(name)
    ) {
      violations.push(
        `package.json script ${JSON.stringify(name)} contains ${JSON.stringify(fragment)}`
      );
    }
  }
}

if (violations.length > 0) {
  console.error('Native process policy failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Native process policy passed.');
