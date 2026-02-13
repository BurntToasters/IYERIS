const fs = require('fs');
const path = require('path');

function cleanBuildArtifacts() {
  for (const dir of ['release', 'dist']) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors to keep behavior identical to previous script.
    }
  }
}

function copyFileEnsuringDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRuntimeAssets() {
  copyFileEnsuringDir(
    path.join('src', 'css', 'twemoji.css'),
    path.join('dist', 'css', 'twemoji.css')
  );

  const highlightBase = path.dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
  copyFileEnsuringDir(
    path.join(highlightBase, 'highlight.min.js'),
    path.join('dist', 'vendor', 'highlight.js')
  );
  copyFileEnsuringDir(
    path.join(highlightBase, 'styles', 'atom-one-dark.min.css'),
    path.join('dist', 'vendor', 'highlight.css')
  );

  const pdfBase = path.dirname(require.resolve('pdfjs-dist/package.json'));
  copyFileEnsuringDir(
    path.join(pdfBase, 'build', 'pdf.min.mjs'),
    path.join('dist', 'vendor', 'pdfjs', 'pdf.min.mjs')
  );
  copyFileEnsuringDir(
    path.join(pdfBase, 'build', 'pdf.worker.min.mjs'),
    path.join('dist', 'vendor', 'pdfjs', 'pdf.worker.min.mjs')
  );
}

const mode = process.argv[2];

if (mode === 'clean') {
  cleanBuildArtifacts();
  process.exit(0);
}

if (mode === 'copy') {
  copyRuntimeAssets();
  process.exit(0);
}

console.error('Usage: node build/dist-tools.js <clean|copy>');
process.exit(1);
