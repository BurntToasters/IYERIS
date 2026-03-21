import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const isPrerelease = /-(?:beta|alpha|rc)\./i.test(pkg.version);

const args = process.argv.slice(2);
if (isPrerelease) {
  const idx = args.indexOf('--bundles');
  if (idx !== -1 && idx + 1 < args.length) {
    const filtered = args[idx + 1]
      .split(',')
      .filter((b) => b !== 'msi')
      .join(',');
    args[idx + 1] = filtered;
    console.log(`[tauri-build] Pre-release detected (${pkg.version}), bundles: ${filtered}`);
  }
}

execSync(`npx tauri build ${args.join(' ')}`, { stdio: 'inherit' });
