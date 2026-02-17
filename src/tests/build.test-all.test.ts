import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

type SuiteResult = {
  status: 'pending' | 'passed' | 'failed';
  errors?: number | null;
  warnings?: number | null;
  passed?: number | null;
  failed?: number | null;
};

type TestAllResults = {
  lint: SuiteResult;
  format: SuiteResult;
  scripts: SuiteResult;
  test: SuiteResult;
  typecheck: SuiteResult;
};

type TestAllModule = {
  createInitialResults: () => TestAllResults;
  getNpmCommand: (platform?: string) => string;
  runCommand: (
    name: 'lint' | 'format' | 'scripts' | 'test' | 'typecheck',
    command: string,
    args: string[],
    parser: ((output: string, results: TestAllResults) => void) | undefined,
    results: TestAllResults,
    runner?: (
      command: string,
      args: string[],
      options: {
        encoding: 'utf8';
        stdio: 'pipe';
        shell: false;
        windowsHide: true;
      }
    ) => {
      stdout?: string;
      stderr?: string;
      status: number | null;
      error?: Error;
      signal?: string | null;
    }
  ) => boolean;
  parseLint: (output: string, results: TestAllResults) => void;
  parseTest: (output: string, results: TestAllResults) => void;
  stripAnsi: (value: string) => string;
  printSummary: (results: TestAllResults) => number;
};

const require = createRequire(__filename);
const testAll = require('../../build/test-all.js') as TestAllModule;

describe('build/test-all.js', () => {
  it('creates pending results', () => {
    const results = testAll.createInitialResults();
    expect(results.lint.status).toBe('pending');
    expect(results.format.status).toBe('pending');
    expect(results.scripts.status).toBe('pending');
    expect(results.test.status).toBe('pending');
    expect(results.typecheck.status).toBe('pending');
  });

  it('chooses platform-specific npm command', () => {
    expect(testAll.getNpmCommand('win32')).toBe('npm.cmd');
    expect(testAll.getNpmCommand('linux')).toBe('npm');
  });

  it('strips ANSI escape sequences', () => {
    const value = '\u001b[31merror\u001b[0m';
    expect(testAll.stripAnsi(value)).toBe('error');
  });

  it('parses lint summary output', () => {
    const results = testAll.createInitialResults();
    testAll.parseLint('✖ 9 problems (2 errors, 7 warnings)', results);
    expect(results.lint.errors).toBe(2);
    expect(results.lint.warnings).toBe(7);
  });

  it('parses lint fallback output', () => {
    const results = testAll.createInitialResults();
    testAll.parseLint('2 errors and 5 warnings', results);
    expect(results.lint.errors).toBe(2);
    expect(results.lint.warnings).toBe(5);
  });

  it('parses vitest summary output', () => {
    const results = testAll.createInitialResults();
    testAll.parseTest('Tests 12 passed | 3 failed', results);
    expect(results.test.passed).toBe(12);
    expect(results.test.failed).toBe(3);
  });

  it('marks successful command as passed', () => {
    const results = testAll.createInitialResults();
    const ok = testAll.runCommand(
      'format',
      'npm',
      ['run', 'format:check'],
      undefined,
      results,
      () => ({ stdout: '', stderr: '', status: 0, signal: null })
    );
    expect(ok).toBe(true);
    expect(results.format.status).toBe('passed');
  });

  it('marks failing command as failed', () => {
    const results = testAll.createInitialResults();
    const ok = testAll.runCommand(
      'format',
      'npm',
      ['run', 'format:check'],
      undefined,
      results,
      () => ({ stdout: '', stderr: '', status: 3, signal: null })
    );
    expect(ok).toBe(false);
    expect(results.format.status).toBe('failed');
  });

  it('invokes parser for lint command output', () => {
    const results = testAll.createInitialResults();
    const ok = testAll.runCommand(
      'lint',
      'npm',
      ['run', 'lint'],
      testAll.parseLint,
      results,
      () => ({
        stdout: '✖ 1 problems (0 errors, 1 warnings)\n',
        stderr: '',
        status: 0,
        signal: null,
      })
    );
    expect(ok).toBe(true);
    expect(results.lint.status).toBe('passed');
    expect(results.lint.errors).toBe(0);
    expect(results.lint.warnings).toBe(1);
  });

  it('returns non-zero summary code when any check failed', () => {
    const results = testAll.createInitialResults();
    results.lint.status = 'passed';
    results.format.status = 'failed';
    results.scripts.status = 'passed';
    results.test.status = 'passed';
    results.typecheck.status = 'passed';
    results.lint.errors = 0;
    results.lint.warnings = 0;
    results.test.passed = 10;
    results.test.failed = 0;

    expect(testAll.printSummary(results)).toBe(1);
  });
});
