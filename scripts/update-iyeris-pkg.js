const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const s = pkg.scripts;

s['u'] =
  'npm update && cd ./src-tauri && cargo update && cd .. && npm run workspace:bootstrap && npm run format && npm run test:all';

s['build:win:x64:prepared'] =
  'dotenv -e .env -- node scripts/tauri-build.js --require-tauri-signing --require-windows-signing --target x86_64-pc-windows-msvc --bundles nsis,msi';
s['build:win:arm64:prepared'] =
  'dotenv -e .env -- node scripts/tauri-build.js --require-tauri-signing --require-windows-signing --target aarch64-pc-windows-msvc --bundles nsis,msi';
s['build:win:prepared'] = 'npm run build:win:x64:prepared && npm run build:win:arm64:prepared';
s['build:win:x64'] =
  'npm run rust:target:win:x64 && npm run sync-version && npm run licenses && npm run build:win:x64:prepared';
s['build:win:arm64'] =
  'npm run rust:target:win:arm64 && npm run sync-version && npm run licenses && npm run build:win:arm64:prepared';
s['build:win'] = 'npm run build:win:x64 && npm run build:win:arm64';

s['build:mac:universal:prepared'] =
  'dotenv -e .env -- node scripts/tauri-build.js --require-tauri-signing --require-macos-signing --require-macos-notarization --target universal-apple-darwin --bundles dmg,app';
s['build:mac:universal'] =
  'npm run rust:target:mac && npm run sync-version && npm run licenses && npm run icons:normalize && npm run build:mac:universal:prepared';

s['build:linux:x64:prepared'] =
  'dotenv -e .env -- node scripts/tauri-build.js --require-tauri-signing --target x86_64-unknown-linux-gnu --bundles appimage,deb,rpm';
s['build:linux:arm64:prepared'] =
  'dotenv -e .env -- node scripts/tauri-build.js --require-tauri-signing --target aarch64-unknown-linux-gnu --bundles appimage,deb,rpm';
s['build:linux:prepared'] =
  'npm run build:linux:x64:prepared && npm run build:linux:arm64:prepared';
s['build:linux:x64'] =
  'npm run sync-version && npm run licenses && npm run build:linux:x64:prepared';
s['build:linux:arm64'] =
  'npm run sync-version && npm run licenses && npm run build:linux:arm64:prepared';
s['build:linux'] = 'npm run build:linux:x64 && npm run build:linux:arm64';

s['workspace:bootstrap'] =
  'npm run rust:update && npm ci && npm run sync-version && node scripts/update-metainfo.js';
s['workspace:prepare'] = 'npm run workspace:bootstrap && npm run test:all';

s['release:prepare'] = 'npm run workspace:prepare && npm run dist:clean-release-artifacts';
s['release:session:verify'] = 'node scripts/release-session.js';

s['release:win:continue'] =
  'npm run release:session:verify && npm run release:draft && npm run rust:target:win && npm run build:win:prepared && npm run release:sign:gpg && npm run release:finalize';
s['release:win:resume'] = 'npm run prerelease:prepare && npm run release:win:continue';
s['release:win'] =
  'npm run prerelease:prepare && npm run release:prepare && npm run release:win:continue';
s['release:windows'] = 'npm run release:win';

s['release:mac:continue'] =
  'npm run release:session:verify && npm run release:wait-draft && npm run rust:target:mac && npm run build:mac:universal:prepared && npm run build:mac:zip && npm run release:sign:gpg && npm run release:finalize';
s['release:mac:resume'] = 'npm run prerelease:prepare && npm run release:mac:continue';
s['release:mac'] =
  'npm run prerelease:prepare && npm run release:prepare && npm run release:mac:continue';
s['release:mac:ssh:resume'] = 'npm run mac:ssh:keychain && npm run release:mac:resume';

s['release:linux:resume'] = 'npm run release:linux:x64:resume';
s['release:linux:x64:continue'] =
  'npm run release:session:verify && npm run release:wait-draft && npm run rust:target:linux:x64 && npm run build:linux:x64:prepared && npm run flatpak:clean && npm run flatpak:bundle && npm run release:sign:gpg && npm run release:finalize';
s['release:linux:x64:resume'] = 'npm run prerelease:prepare && npm run release:linux:x64:continue';
s['release:linux:x64'] =
  'npm run prerelease:prepare && npm run release:prepare && npm run release:linux:x64:continue';

s['release:linux:arm64:continue'] =
  'npm run release:session:verify && npm run release:wait-draft && npm run rust:target:linux:arm64 && npm run build:linux:arm64:prepared && npm run release:sign:gpg && npm run release:finalize';
s['release:linux:arm64:resume'] =
  'npm run prerelease:prepare && npm run release:linux:arm64:continue';
s['release:linux:arm64'] =
  'npm run prerelease:prepare && npm run release:prepare && npm run release:linux:arm64:continue';

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n', 'utf8');
