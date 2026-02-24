const { spawnSync } = require('child_process');

const testVersion = require('../package.json').version;
const scriptVersion = '1.2.0';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

function createInitialResults() {
  return {
    lint: { status: 'pending', errors: null, warnings: null },
    format: { status: 'pending' },
    scripts: { status: 'pending' },
    test: { status: 'pending', passed: null, failed: null },
    typecheck: { status: 'pending' },
  };
}

function getNpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(name, command, args, parser, results, runner = spawnSync) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  const run = runner(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (parser) parser(output, results);

  if (!run.error && run.status === 0) {
    results[name].status = 'passed';

    if (name === 'lint') {
      const warningCount = results.lint.warnings === null ? 'n/a' : results.lint.warnings;
      console.log(`${colors.green}✓ ${name} passed (${warningCount} warnings)${colors.reset}\n`);
    } else {
      console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    }

    return true;
  }

  results[name].status = 'failed';
  const reason = run.error
    ? run.error.message
    : run.status === null
      ? `signal ${run.signal || 'unknown'}`
      : `exit code ${run.status}`;
  console.log(`${colors.red}✗ ${name} failed (${reason})${colors.reset}`);
  printTail(output);
  console.log('');
  return false;
}

function parseLint(output, results) {
  const cleanOutput = stripAnsi(output);
  const summaryMatch = cleanOutput.match(
    /✖\s+\d+\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/
  );

  if (summaryMatch) {
    results.lint.errors = parseInt(summaryMatch[1], 10);
    results.lint.warnings = parseInt(summaryMatch[2], 10);
    return;
  }

  const errorMatch = cleanOutput.match(/(\d+)\s+errors?/);
  const warningMatch = cleanOutput.match(/(\d+)\s+warnings?/);
  results.lint.errors = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  results.lint.warnings = warningMatch ? parseInt(warningMatch[1], 10) : 0;
}

function parseTest(output, results) {
  const cleanOutput = stripAnsi(output);
  const summaryPassedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+passed/);
  const summaryFailedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+failed/);
  const fallbackPassedMatch = cleanOutput.match(/(\d+)\s+passed/);
  const fallbackFailedMatch = cleanOutput.match(/(\d+)\s+failed/);

  results.test.passed = summaryPassedMatch
    ? parseInt(summaryPassedMatch[1], 10)
    : fallbackPassedMatch
      ? parseInt(fallbackPassedMatch[1], 10)
      : null;
  results.test.failed = summaryFailedMatch
    ? parseInt(summaryFailedMatch[1], 10)
    : fallbackFailedMatch
      ? parseInt(fallbackFailedMatch[1], 10)
      : null;
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function printTail(output) {
  const cleanOutput = stripAnsi(output).trim();
  if (!cleanOutput) return;

  const lines = cleanOutput.split('\n');
  const tail = lines.slice(-20).join('\n');
  console.log(`${colors.red}${tail}${colors.reset}`);
}

function printBanner() {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║   IYERIS Quality Check Suite         ║
╚══════════════════════════════════════╝
IYERIS Version: ${testVersion}
Script Version: ${scriptVersion} 
${colors.reset}`);
}

function printSummary(results) {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║           SUMMARY                    ║
╚══════════════════════════════════════╝
${colors.reset}`);

  const allPassed = Object.values(results).every((r) => r.status === 'passed');

  console.log(
    `${colors.bold}Lint:${colors.reset}       ${
      results.lint.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
    }${colors.reset} (${results.lint.errors ?? 'n/a'} errors, ${results.lint.warnings ?? 'n/a'} warnings)`
  );

  console.log(
    `${colors.bold}Format:${colors.reset}     ${
      results.format.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
    }${colors.reset}`
  );

  console.log(
    `${colors.bold}Scripts:${colors.reset}    ${
      results.scripts.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
    }${colors.reset}`
  );

  console.log(
    `${colors.bold}Tests:${colors.reset}      ${
      results.test.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
    }${colors.reset} (${results.test.passed ?? 'n/a'} passed${
      results.test.failed && results.test.failed > 0 ? `, ${results.test.failed} failed` : ''
    })`
  );

  console.log(
    `${colors.bold}TypeCheck:${colors.reset}  ${
      results.typecheck.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
    }${colors.reset}`
  );

  console.log('');

  if (allPassed) {
    console.log(
      `${colors.green}${colors.bold}✓ All checks passed! Ready to commit.${colors.reset}`
    );
    return 0;
  }

  console.log(
    `${colors.red}${colors.bold}✗ Some checks failed. Please fix before committing.${colors.reset}`
  );
  return 1;
}

function main() {
  const results = createInitialResults();
  const npmCommand = getNpmCommand();
  printBanner();
  runCommand('lint', npmCommand, ['run', 'lint'], parseLint, results);
  runCommand('format', npmCommand, ['run', 'format:check'], undefined, results);
  runCommand('scripts', npmCommand, ['run', 'smoke:scripts'], undefined, results);
  runCommand('test', npmCommand, ['test'], parseTest, results);
  runCommand('typecheck', npmCommand, ['run', 'typecheck'], undefined, results);
  return printSummary(results);
}

module.exports = {
  createInitialResults,
  getNpmCommand,
  runCommand,
  parseLint,
  parseTest,
  stripAnsi,
  printTail,
  printSummary,
  main,
};

if (require.main === module) {
  process.exit(main());
}
