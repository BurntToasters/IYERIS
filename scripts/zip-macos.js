import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

if (process.platform !== 'darwin') {
  console.log('zip-macos can only run on macOS.');
  process.exit(0);
}

const root = process.cwd();
const targetRoot = path.join(root, 'src-tauri', 'target');

function findApps(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) results.push(full);
      else results.push(...findApps(full));
    }
  }
  return results;
}

if (!fs.existsSync(targetRoot)) {
  console.error('No build output found in src-tauri/target.');
  process.exit(1);
}

const apps = findApps(targetRoot).filter((appPath) =>
  appPath.includes(`${path.sep}bundle${path.sep}macos`)
);

if (apps.length === 0) {
  console.error('No .app bundles found. Build macOS bundles first.');
  process.exit(1);
}

for (const appPath of apps) {
  const baseName = path.basename(appPath, '.app');
  const zipPath = path.join(path.dirname(appPath), `${baseName}.zip`);
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], {
    stdio: 'inherit',
  });
}

console.log('Created macOS zip archives.');
