const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const SCRIPT_VERSION = '1.0.0';
const DEFAULT_FILE_COUNT = 15000;
const DEFAULT_DIR_BUCKETS = 60;
const DEFAULT_EMPTY_FOLDER_COUNT = 300;
const DEFAULT_HIDDEN_EVERY = 41;
const WRITE_BATCH_SIZE = 300;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'ts', 'js', 'csv', 'log']);
const EXTENSIONS = [
  'txt',
  'md',
  'json',
  'ts',
  'js',
  'png',
  'jpg',
  'webp',
  'gif',
  'pdf',
  'mp4',
  'mp3',
  'zip',
  'csv',
  'log',
];

function parsePositiveInt(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    output: '',
    files: DEFAULT_FILE_COUNT,
    buckets: DEFAULT_DIR_BUCKETS,
    folders: DEFAULT_EMPTY_FOLDER_COUNT,
    hiddenEvery: DEFAULT_HIDDEN_EVERY,
    clean: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--output' && next) {
      result.output = next;
      i++;
      continue;
    }
    if (arg === '--files' && next) {
      result.files = parsePositiveInt(next, result.files);
      i++;
      continue;
    }
    if (arg === '--buckets' && next) {
      result.buckets = parsePositiveInt(next, result.buckets);
      i++;
      continue;
    }
    if (arg === '--folders' && next) {
      result.folders = parsePositiveInt(next, result.folders);
      i++;
      continue;
    }
    if (arg === '--hidden-every' && next) {
      result.hiddenEvery = parsePositiveInt(next, result.hiddenEvery);
      i++;
      continue;
    }
    if (arg === '--clean') {
      result.clean = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
  }

  if (!result.output) {
    result.output = path.join(os.tmpdir(), `iyeris-large-dir-fixture-${Date.now()}`);
  }
  result.output = path.resolve(result.output);
  return result;
}

function printHelp() {
  console.log(`IYERIS Large Directory Fixture Generator

Usage:
  npm run smoke:perf:fixture -- [options]

Options:
  --output <path>        Target directory. Default: temp directory.
  --files <count>        Number of files to create. Default: ${DEFAULT_FILE_COUNT}
  --buckets <count>      Number of top-level buckets. Default: ${DEFAULT_DIR_BUCKETS}
  --folders <count>      Number of empty folders. Default: ${DEFAULT_EMPTY_FOLDER_COUNT}
  --hidden-every <n>     Every nth file is hidden. Default: ${DEFAULT_HIDDEN_EVERY}
  --clean                Remove target directory before generation.
  --help                 Show this message.
`);
}

function buildFileContent(index, extension) {
  if (!TEXT_EXTENSIONS.has(extension)) return '';
  return `fixture-index:${index}\nfixture-ext:${extension}\n`;
}

async function ensureWritableTarget(outputDir, clean) {
  if (clean) {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir, { recursive: true });
}

async function createBucketDirs(outputDir, bucketCount) {
  const dirs = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucket = path.join(outputDir, `bucket-${String(i).padStart(3, '0')}`);
    dirs.push(bucket);
  }
  await Promise.all(dirs.map((dirPath) => fs.mkdir(dirPath, { recursive: true })));
  return dirs;
}

function buildFilePlan(bucketDirs, fileCount, hiddenEvery) {
  const plan = [];
  for (let i = 0; i < fileCount; i++) {
    const extension = EXTENSIONS[i % EXTENSIONS.length];
    const bucket = bucketDirs[i % bucketDirs.length];
    const isHidden = hiddenEvery > 0 && i % hiddenEvery === 0;
    const stem = isHidden
      ? `.hidden-${String(i).padStart(6, '0')}`
      : `item-${String(i).padStart(6, '0')}`;
    const filePath = path.join(bucket, `${stem}.${extension}`);
    plan.push({
      index: i,
      extension,
      filePath,
    });
  }
  return plan;
}

async function writeFilesInBatches(plan) {
  for (let i = 0; i < plan.length; i += WRITE_BATCH_SIZE) {
    const batch = plan.slice(i, i + WRITE_BATCH_SIZE);
    await Promise.all(
      batch.map((entry) =>
        fs.writeFile(entry.filePath, buildFileContent(entry.index, entry.extension))
      )
    );
  }
}

async function createEmptyFolders(outputDir, folderCount) {
  const root = path.join(outputDir, 'folders');
  await fs.mkdir(root, { recursive: true });
  const tasks = [];
  for (let i = 0; i < folderCount; i++) {
    const level1 = path.join(root, `group-${String(i % 25).padStart(2, '0')}`);
    const folderPath = path.join(level1, `folder-${String(i).padStart(4, '0')}`);
    tasks.push(fs.mkdir(folderPath, { recursive: true }));
  }
  await Promise.all(tasks);
}

async function generateFixture(options) {
  await ensureWritableTarget(options.output, options.clean);
  const bucketDirs = await createBucketDirs(options.output, options.buckets);
  const filePlan = buildFilePlan(bucketDirs, options.files, options.hiddenEvery);
  await writeFilesInBatches(filePlan);
  await createEmptyFolders(options.output, options.folders);

  return {
    output: options.output,
    files: options.files,
    bucketDirs: options.buckets,
    emptyFolders: options.folders,
    hiddenEvery: options.hiddenEvery,
  };
}

function printSummary(summary) {
  console.log('IYERIS Large Directory Fixture Generator');
  console.log(`Script Version: ${SCRIPT_VERSION}`);
  console.log(`Output: ${summary.output}`);
  console.log(`Files: ${summary.files.toLocaleString()}`);
  console.log(`Bucket Dirs: ${summary.bucketDirs}`);
  console.log(`Empty Folders: ${summary.emptyFolders}`);
  console.log(`Hidden Every: ${summary.hiddenEvery}`);
  console.log('');
  console.log('Suggested smoke test steps:');
  console.log(`1. Open IYERIS and navigate to "${summary.output}"`);
  console.log('2. Toggle list/grid/column view and verify responsiveness stays acceptable');
  console.log('3. Confirm performance mode behaviors still apply (reduced animation/effects)');
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const summary = await generateFixture(options);
  printSummary(summary);
  return 0;
}

module.exports = {
  parseArgs,
  generateFixture,
  buildFilePlan,
  main,
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        `Failed to generate fixture: ${error && error.message ? error.message : error}`
      );
      process.exit(1);
    });
}
