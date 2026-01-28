
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'index.html');
const backupPath = path.join(__dirname, 'index.html.bak');

fs.copyFileSync(indexPath, backupPath);
console.log('✓ Backed up index.html to build/index.html.bak');

let content = fs.readFileSync(indexPath, 'utf8');

content = content.replace(
  /<img src="assets\/folder\.png" alt="IYERIS" \/>/,
  '<img src="assets/folder-beta.png" alt="IYERIS" />'
);

content = content.replace(
  /<p>Build @ \[v([^\]]+)\]<\/p>/,
  '<p>Beta Build @ [v$1]</p>'
);

fs.writeFileSync(indexPath, content, 'utf8');

console.log('✓ Patched index.html for beta build');
