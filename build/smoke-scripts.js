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

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function extractScriptRefs(command) {
  const refs = [];
  const regex = /\bnpm run ([A-Za-z0-9:_-]+)/g;
  let match = regex.exec(command);
  while (match) {
    refs.push(match[1]);
    match = regex.exec(command);
  }
  return refs;
}

function extractNodeFileRefs(command) {
  const refs = [];
  const regex = /\bnode\s+([^\s]+)/g;
  let match = regex.exec(command);
  while (match) {
    refs.push(match[1]);
    match = regex.exec(command);
  }
  return refs;
}

function extractBuilderConfigRefs(command) {
  const refs = [];
  const regex = /(?:--config|-c)\s+([^\s]+)/g;
  let match = regex.exec(command);
  while (match) {
    refs.push(match[1]);
    match = regex.exec(command);
  }
  return refs;
}

function extractDotenvFileRefs(command) {
  const refs = [];
  const regex = /\bdotenv\b(?:\s+-e\s+([^\s]+))?/g;
  let match = regex.exec(command);
  while (match) {
    if (match[1]) refs.push(match[1]);
    match = regex.exec(command);
  }
  return refs;
}

function shouldValidatePath(ref) {
  return Boolean(ref) && (ref.includes('/') || ref.includes('\\') || ref.endsWith('.js'));
}

function createPathValidator(pathExists, rootDir) {
  return (targetPath) => {
    const resolved = path.resolve(rootDir, targetPath);
    return pathExists(resolved);
  };
}

function validateScripts(scripts, { rootDir = process.cwd(), pathExists = fs.existsSync } = {}) {
  const scriptNames = Object.keys(scripts || {});
  const scriptNameSet = new Set(scriptNames);
  const hasPath = createPathValidator(pathExists, rootDir);
  const errors = [];
  const warnings = [];

  for (const scriptName of scriptNames) {
    const command = scripts[scriptName];
    if (typeof command !== 'string' || !command.trim()) {
      errors.push(`[${scriptName}] script command is empty`);
      continue;
    }

    for (const ref of extractScriptRefs(command)) {
      if (!scriptNameSet.has(ref)) {
        errors.push(`[${scriptName}] references missing npm script "${ref}"`);
      }
    }

    for (const nodeRef of extractNodeFileRefs(command)) {
      if (!shouldValidatePath(nodeRef)) continue;
      if (!hasPath(nodeRef)) {
        errors.push(`[${scriptName}] references missing Node script "${nodeRef}"`);
      }
    }

    for (const configRef of extractBuilderConfigRefs(command)) {
      if (!shouldValidatePath(configRef)) continue;
      if (!hasPath(configRef)) {
        errors.push(`[${scriptName}] references missing electron-builder config "${configRef}"`);
      }
    }

    for (const dotenvRef of extractDotenvFileRefs(command)) {
      if (!shouldValidatePath(dotenvRef)) continue;
      if (!hasPath(dotenvRef)) {
        errors.push(`[${scriptName}] references missing dotenv file "${dotenvRef}"`);
      }
    }

    if (
      scriptName.includes(':beta:') &&
      command.includes('npm run patch:beta') &&
      !command.includes('npm run restore:release')
    ) {
      errors.push(
        `[${scriptName}] runs patch:beta but does not run restore:release in the same script`
      );
    }

    if (command.includes('flatpak') && !command.includes('node build/flatpak.js')) {
      warnings.push(
        `[${scriptName}] uses flatpak commands directly; verify platform tooling is installed`
      );
    }
  }

  return {
    checkedScripts: scriptNames.length,
    errors,
    warnings,
  };
}

function printHeader(version) {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║      Build Script Smoke Check        ║
╚══════════════════════════════════════╝
Package Version: ${version}
Script Version: ${SCRIPT_VERSION}
${colors.reset}`);
}

function printResults(results) {
  if (results.errors.length === 0 && results.warnings.length === 0) {
    console.log(
      `${colors.green}✓ Checked ${results.checkedScripts} scripts with no issues.${colors.reset}`
    );
    return 0;
  }

  if (results.warnings.length > 0) {
    console.log(`${colors.yellow}Warnings (${results.warnings.length}):${colors.reset}`);
    for (const warning of results.warnings) {
      console.log(`${colors.yellow}- ${warning}${colors.reset}`);
    }
    console.log('');
  }

  if (results.errors.length > 0) {
    console.log(`${colors.red}Errors (${results.errors.length}):${colors.reset}`);
    for (const error of results.errors) {
      console.log(`${colors.red}- ${error}${colors.reset}`);
    }
    console.log('');
    console.log(`${colors.red}${colors.bold}✗ Script smoke checks failed.${colors.reset}`);
    return 1;
  }

  console.log(
    `${colors.green}✓ Checked ${results.checkedScripts} scripts with warnings only.${colors.reset}`
  );
  return 0;
}

function loadPackageJson(rootDir = process.cwd()) {
  const packagePath = path.resolve(rootDir, 'package.json');
  const raw = fs.readFileSync(packagePath, 'utf8');
  return JSON.parse(raw);
}

function main() {
  try {
    const pkg = loadPackageJson();
    printHeader(pkg.version || 'unknown');
    const results = validateScripts(pkg.scripts || {});
    return printResults(results);
  } catch (error) {
    console.error(
      `${colors.red}${colors.bold}✗ Failed to run script smoke checks:${colors.reset} ${stripAnsi(
        error && error.message ? error.message : String(error)
      )}`
    );
    return 1;
  }
}

module.exports = {
  stripAnsi,
  extractScriptRefs,
  extractNodeFileRefs,
  extractBuilderConfigRefs,
  extractDotenvFileRefs,
  shouldValidatePath,
  validateScripts,
  loadPackageJson,
  main,
};

if (require.main === module) {
  process.exit(main());
}
