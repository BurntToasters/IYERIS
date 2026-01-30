const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'index.html');
const backupPath = path.join(__dirname, 'index.html.bak');

if (!fs.existsSync(backupPath)) {
  console.error('✗ No backup found at build/index.html.bak');
  process.exit(1);
}

fs.copyFileSync(backupPath, indexPath);
console.log('✓ Restored index.html from backup');

fs.unlinkSync(backupPath);
console.log('✓ Removed build/index.html.bak');
