const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

const results = {
  lint: { status: 'pending', errors: 0, warnings: 0 },
  format: { status: 'pending' },
  test: { status: 'pending', passed: 0, failed: 0 },
  typecheck: { status: 'pending' },
};

function runCommand(name, command, parser) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    results[name].status = 'passed';
    if (parser) parser(output);
    console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    return true;
  } catch (error) {
    const output = error.stdout || error.stderr || '';
    if (parser) parser(output);

    // Check if it's just warnings (no errors)
    if (name === 'lint' && results.lint.errors === 0) {
      results[name].status = 'passed';
      console.log(`${colors.green}✓ ${name} passed (${results.lint.warnings} warnings)${colors.reset}\n`);
      return true;
    }

    results[name].status = 'failed';
    console.log(`${colors.red}✗ ${name} failed${colors.reset}\n`);
    return false;
  }
}

function parseLint(output) {
  const errorMatch = output.match(/(\d+) errors?/);
  const warningMatch = output.match(/(\d+) warnings?/);
  results.lint.errors = errorMatch ? parseInt(errorMatch[1]) : 0;
  results.lint.warnings = warningMatch ? parseInt(warningMatch[1]) : 0;
}

function parseTest(output) {
  const passedMatch = output.match(/(\d+) passed/);
  const failedMatch = output.match(/(\d+) failed/);
  results.test.passed = passedMatch ? parseInt(passedMatch[1]) : 0;
  results.test.failed = failedMatch ? parseInt(failedMatch[1]) : 0;
}

console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║   IYERIS Quality Check Suite        ║
╚══════════════════════════════════════╝
${colors.reset}`);

// Run all checks
runCommand('lint', 'npm run lint', parseLint);
runCommand('format', 'npm run format:check');
runCommand('test', 'npm test', parseTest);
runCommand('typecheck', 'npx tsc --noEmit && npx tsc --noEmit --project tsconfig.renderer.json');

// Print summary
console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║           SUMMARY                    ║
╚══════════════════════════════════════╝
${colors.reset}`);

const allPassed = Object.values(results).every((r) => r.status === 'passed');

console.log(`${colors.bold}Lint:${colors.reset}       ${
  results.lint.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
}${colors.reset} (${results.lint.errors} errors, ${results.lint.warnings} warnings)`);

console.log(`${colors.bold}Format:${colors.reset}     ${
  results.format.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
}${colors.reset}`);

console.log(`${colors.bold}Tests:${colors.reset}      ${
  results.test.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
}${colors.reset} (${results.test.passed} passed${
  results.test.failed > 0 ? `, ${results.test.failed} failed` : ''
})`);

console.log(`${colors.bold}TypeCheck:${colors.reset}  ${
  results.typecheck.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
}${colors.reset}`);

console.log('');

if (allPassed) {
  console.log(`${colors.green}${colors.bold}✓ All checks passed! Ready to commit.${colors.reset}`);
  process.exit(0);
} else {
  console.log(`${colors.red}${colors.bold}✗ Some checks failed. Please fix before committing.${colors.reset}`);
  process.exit(1);
}
