import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY_RAW_LIMIT_BYTES = 800_000;
export const ENTRY_GZIP_LIMIT_BYTES = 215_000;
export const CSS_RAW_LIMIT_BYTES = 300_000;
export const CSS_GZIP_LIMIT_BYTES = 50_000;
export const INITIAL_RAW_LIMIT_BYTES = 1_200_000;
export const INITIAL_GZIP_LIMIT_BYTES = 260_000;

export function checkBundleBudget({
  rawBytes,
  gzipBytes,
  cssRawBytes,
  cssGzipBytes,
  initialRawBytes,
  initialGzipBytes,
}) {
  const failures = [];
  if (rawBytes > ENTRY_RAW_LIMIT_BYTES) {
    failures.push(`raw ${rawBytes} B exceeds ${ENTRY_RAW_LIMIT_BYTES} B`);
  }
  if (gzipBytes > ENTRY_GZIP_LIMIT_BYTES) {
    failures.push(`gzip ${gzipBytes} B exceeds ${ENTRY_GZIP_LIMIT_BYTES} B`);
  }
  if (cssRawBytes > CSS_RAW_LIMIT_BYTES) {
    failures.push(`CSS raw ${cssRawBytes} B exceeds ${CSS_RAW_LIMIT_BYTES} B`);
  }
  if (cssGzipBytes > CSS_GZIP_LIMIT_BYTES) {
    failures.push(`CSS gzip ${cssGzipBytes} B exceeds ${CSS_GZIP_LIMIT_BYTES} B`);
  }
  if (initialRawBytes > INITIAL_RAW_LIMIT_BYTES) {
    failures.push(`initial raw ${initialRawBytes} B exceeds ${INITIAL_RAW_LIMIT_BYTES} B`);
  }
  if (initialGzipBytes > INITIAL_GZIP_LIMIT_BYTES) {
    failures.push(`initial gzip ${initialGzipBytes} B exceeds ${INITIAL_GZIP_LIMIT_BYTES} B`);
  }
  return failures;
}

export function measureEntryChunk(distDir) {
  const assetsDir = resolve(distDir, 'assets');
  const candidates = readdirSync(assetsDir).filter((name) => /^main-[^.]+\.js$/.test(name));
  if (candidates.length !== 1) {
    throw new Error(`Expected one main entry chunk, found ${candidates.length}`);
  }
  const fileName = candidates[0];
  const content = readFileSync(resolve(assetsDir, fileName));
  const cssCandidates = readdirSync(assetsDir).filter((name) => /^main-[^.]+\.css$/.test(name));
  if (cssCandidates.length !== 1) {
    throw new Error(`Expected one main CSS asset, found ${cssCandidates.length}`);
  }
  const cssFileName = cssCandidates[0];
  const cssContent = readFileSync(resolve(assetsDir, cssFileName));
  const indexContent = readFileSync(resolve(distDir, 'index.html'));
  const indexHtml = indexContent.toString('utf8');
  const initialAssetNames = Array.from(
    new Set(
      Array.from(
        indexHtml.matchAll(/(?:src|href)="\/?assets\/([^"?#]+\.(?:js|css))(?:[?#][^"]*)?"/gu)
      ).map((match) => match[1])
    )
  );
  const initialContents = [indexContent];
  for (const assetName of initialAssetNames) {
    initialContents.push(readFileSync(resolve(assetsDir, assetName)));
  }
  return {
    fileName,
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content).byteLength,
    cssFileName,
    cssRawBytes: cssContent.byteLength,
    cssGzipBytes: gzipSync(cssContent).byteLength,
    initialAssetNames,
    initialRawBytes: initialContents.reduce((total, asset) => total + asset.byteLength, 0),
    initialGzipBytes: initialContents.reduce(
      (total, asset) => total + gzipSync(asset).byteLength,
      0
    ),
  };
}

export function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const measurement = measureEntryChunk(resolve(scriptDir, '..', 'dist'));
  const failures = checkBundleBudget(measurement);
  console.log(
    `${measurement.fileName}: ${measurement.rawBytes} B raw, ${measurement.gzipBytes} B gzip`
  );
  console.log(
    `${measurement.cssFileName}: ${measurement.cssRawBytes} B raw, ${measurement.cssGzipBytes} B gzip`
  );
  console.log(
    `Initial load (${measurement.initialAssetNames.length + 1} files): ${measurement.initialRawBytes} B raw, ${measurement.initialGzipBytes} B gzip`
  );
  if (failures.length > 0) {
    throw new Error(`Bundle budget failed: ${failures.join('; ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
