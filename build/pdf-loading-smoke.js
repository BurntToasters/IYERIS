import fs from 'node:fs';
import path from 'node:path';

const names = [
  '__iyeris_pdf_loading_smoke__.html',
  '__iyeris_pdf_loading_smoke__.js',
  '__iyeris_pdf_loading_valid.pdf',
  '__iyeris_pdf_loading_invalid.pdf',
];

export function smokePaths(root) {
  return names.map((name, index) =>
    path.join(index < 2 ? root : path.join(root, '..', 'public'), name)
  );
}

function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 24 Tf 32 80 Td (PDF E2E OK) Tj ET';
  objects[3] = `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

const smokeSource = `
import { createPdfViewer, loadPdfJs } from './rendererPdfViewer.ts';

const result = { status: 'running', loaded: false, canvas: null, failure: null, workerSrc: null };
window.__iyerisPdfLoadingSmoke = result;

void (async () => {
  try {
    const lib = await loadPdfJs();
    if (!lib) throw new Error('pdf.js failed to load');
    result.workerSrc = lib.GlobalWorkerOptions.workerSrc;
    const viewer = await createPdfViewer('/__iyeris_pdf_loading_valid.pdf', {
      showPageControls: false,
      onError: (message) => { result.loadError = message; },
    });
    document.querySelector('#viewer').append(viewer.element);
    const canvas = viewer.element.querySelector('canvas');
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      throw new Error('PDF viewer did not render a nonempty canvas');
    }
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhitePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) nonWhitePixels += 1;
    }
    result.firstRender = { width: canvas.width, height: canvas.height, nonWhitePixels };
    if (nonWhitePixels === 0) throw new Error('PDF canvas rendered no visible content');
    viewer.destroy();
    result.destroyed = true;
    viewer.element.remove();

    const reopenedViewer = await createPdfViewer('/__iyeris_pdf_loading_valid.pdf', {
      showPageControls: false,
      onError: (message) => { result.reopenError = message; },
    });
    document.querySelector('#viewer').append(reopenedViewer.element);
    const reopenedCanvas = reopenedViewer.element.querySelector('canvas');
    if (!reopenedCanvas || reopenedCanvas.width === 0 || reopenedCanvas.height === 0) {
      throw new Error('Reopened PDF viewer did not render a nonempty canvas');
    }
    const reopenedPixels = reopenedCanvas
      .getContext('2d')
      .getImageData(0, 0, reopenedCanvas.width, reopenedCanvas.height).data;
    let reopenedNonWhitePixels = 0;
    for (let index = 0; index < reopenedPixels.length; index += 4) {
      if (
        reopenedPixels[index] < 245 ||
        reopenedPixels[index + 1] < 245 ||
        reopenedPixels[index + 2] < 245
      ) {
        reopenedNonWhitePixels += 1;
      }
    }
    result.canvas = {
      width: reopenedCanvas.width,
      height: reopenedCanvas.height,
      nonWhitePixels: reopenedNonWhitePixels,
    };
    if (reopenedNonWhitePixels === 0) {
      throw new Error('Reopened PDF canvas rendered no visible content');
    }
    result.pageCount = reopenedViewer.getPageCount();
    result.loaded = true;

    let callbackMessage = '';
    try {
      const invalidViewer = await createPdfViewer('/__iyeris_pdf_loading_invalid.pdf', {
        showPageControls: false,
        onError: (message) => { callbackMessage = message; },
      });
      invalidViewer.destroy();
      throw new Error('Invalid PDF unexpectedly loaded');
    } catch (error) {
      if (error.message === 'Invalid PDF unexpectedly loaded') throw error;
      result.failure = {
        message: error instanceof Error ? error.message : String(error),
        callbackMessage,
      };
      if (!callbackMessage) throw new Error('PDF load failure did not reach onError');
    }
    reopenedViewer.destroy();
    result.destroyedAfterReopen = true;
    document.querySelector('#results').textContent = 'complete';
    result.status = 'complete';
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.stack || error.message : String(error);
    document.querySelector('#results').textContent = result.error;
  }
})();
`;

export function createSmokeFiles(root) {
  const [htmlPath, sourcePath, validPdfPath, invalidPdfPath] = smokePaths(root);
  const filePaths = [htmlPath, sourcePath, validPdfPath, invalidPdfPath];
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath))
      throw new Error(`Refusing to overwrite smoke fixture: ${filePath}`);
  }
  const written = [];
  try {
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>PDF loading smoke</title><main id="viewer"></main><pre id="results">running</pre><script type="module" src="/__iyeris_pdf_loading_smoke__.js"></script>\n'
    );
    written.push(htmlPath);
    fs.writeFileSync(sourcePath, smokeSource);
    written.push(sourcePath);
    fs.writeFileSync(validPdfPath, makePdf());
    written.push(validPdfPath);
    fs.writeFileSync(invalidPdfPath, 'This file is deliberately not a PDF.\n');
    written.push(invalidPdfPath);
  } catch (error) {
    for (const filePath of written) fs.rmSync(filePath, { force: true });
    throw error;
  }
  return { htmlPath, sourcePath, validPdfPath, invalidPdfPath };
}
