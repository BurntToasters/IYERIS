const fs = require('fs');
const path = require('path');

const SCRIPT_VERSION = '1.0.0';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

const CRITICAL_DEV_DEPENDENCIES = ['typescript', 'eslint', 'prettier', 'vitest'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function lockRootDependencies(lock) {
  const root = lock?.packages?.[''] || {};
  return {
    ...(root.dependencies || {}),
    ...(root.devDependencies || {}),
  };
}

function resolveInstalledPackage(packageName, rootDir) {
  const targets = [`${packageName}/package.json`, packageName];
  for (const target of targets) {
    try {
      require.resolve(target, { paths: [rootDir] });
      return true;
    } catch {}
  }
  return false;
}

function checkDependencySet(
  packageNames,
  declaredMap,
  lockDeclaredMap,
  rootDir,
  typeLabel,
  errors
) {
  for (const packageName of packageNames) {
    if (!declaredMap[packageName]) {
      errors.push(`[${typeLabel}] "${packageName}" is not declared in package.json`);
      continue;
    }
    if (!lockDeclaredMap[packageName]) {
      errors.push(`[${typeLabel}] "${packageName}" is missing from package-lock.json root deps`);
      continue;
    }
    if (!resolveInstalledPackage(packageName, rootDir)) {
      errors.push(`[${typeLabel}] "${packageName}" is not installed in node_modules`);
    }
  }
}

function validateDependencies(pkg, lock, rootDir = process.cwd()) {
  const errors = [];
  const runtimeDependencies = Object.keys(pkg.dependencies || {});
  const devDependencies = pkg.devDependencies || {};
  const lockDeps = lockRootDependencies(lock);

  checkDependencySet(
    runtimeDependencies,
    pkg.dependencies || {},
    lockDeps,
    rootDir,
    'runtime',
    errors
  );
  checkDependencySet(
    CRITICAL_DEV_DEPENDENCIES,
    devDependencies,
    lockDeps,
    rootDir,
    'dev-critical',
    errors
  );

  return { errors };
}

function printHeader(version) {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║   Dependency Preflight Check         ║
╚══════════════════════════════════════╝
Package Version: ${version}
Script Version: ${SCRIPT_VERSION}
${colors.reset}`);
}

function printErrors(errors) {
  if (errors.length === 0) {
    console.log(`${colors.green}✓ Dependency preflight passed.${colors.reset}`);
    return 0;
  }

  console.log(
    `${colors.red}${colors.bold}✗ Dependency preflight failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):${colors.reset}`
  );
  for (const error of errors) {
    console.log(`${colors.red}- ${error}${colors.reset}`);
  }
  console.log('');
  console.log(
    `${colors.yellow}Run "npm ci" to restore a clean dependency state before build/test.${colors.reset}`
  );
  return 1;
}

function main(rootDir = process.cwd()) {
  try {
    const packagePath = path.join(rootDir, 'package.json');
    const lockPath = path.join(rootDir, 'package-lock.json');
    const pkg = readJson(packagePath);
    const lock = readJson(lockPath);
    printHeader(pkg.version || 'unknown');
    const { errors } = validateDependencies(pkg, lock, rootDir);
    return printErrors(errors);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `${colors.red}${colors.bold}✗ Dependency preflight crashed:${colors.reset} ${message}`
    );
    return 1;
  }
}

module.exports = {
  readJson,
  lockRootDependencies,
  resolveInstalledPackage,
  validateDependencies,
  main,
};

if (require.main === module) {
  process.exit(main());
}
