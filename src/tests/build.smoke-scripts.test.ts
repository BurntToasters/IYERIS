import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

type SmokeValidationResult = {
  checkedScripts: number;
  errors: string[];
  warnings: string[];
};

type SmokeScriptsModule = {
  extractScriptRefs: (command: string) => string[];
  extractNodeFileRefs: (command: string) => string[];
  extractBuilderConfigRefs: (command: string) => string[];
  extractDotenvFileRefs: (command: string) => string[];
  validateScripts: (
    scripts: Record<string, string>,
    options?: {
      rootDir?: string;
      pathExists?: (target: string) => boolean;
    }
  ) => SmokeValidationResult;
};

const require = createRequire(__filename);
const smokeScripts = require('../../build/smoke-scripts.js') as SmokeScriptsModule;

describe('build/smoke-scripts.js', () => {
  it('extracts npm run references', () => {
    const refs = smokeScripts.extractScriptRefs('npm run build && npm run test:all');
    expect(refs).toEqual(['build', 'test:all']);
  });

  it('extracts node and config references', () => {
    expect(
      smokeScripts.extractNodeFileRefs('node build/dist-tools.js clean && node build/watch.js')
    ).toEqual(['build/dist-tools.js', 'build/watch.js']);
    expect(
      smokeScripts.extractBuilderConfigRefs(
        'electron-builder --config electron-builder.msstore.yml'
      )
    ).toEqual(['electron-builder.msstore.yml']);
  });

  it('extracts dotenv -e file references', () => {
    const refs = smokeScripts.extractDotenvFileRefs('dotenv -e .env -- electron-builder --mac');
    expect(refs).toEqual(['.env']);
  });

  it('flags missing npm run script references', () => {
    const result = smokeScripts.validateScripts(
      {
        check: 'npm run missing:script',
      },
      {
        pathExists: () => true,
      }
    );

    expect(result.errors).toContain('[check] references missing npm script "missing:script"');
  });

  it('flags missing node file references', () => {
    const result = smokeScripts.validateScripts(
      {
        build: 'node build/does-not-exist.js',
      },
      {
        rootDir: '/repo',
        pathExists: () => false,
      }
    );

    expect(result.errors).toContain(
      '[build] references missing Node script "build/does-not-exist.js"'
    );
  });

  it('flags beta scripts missing restore-release', () => {
    const result = smokeScripts.validateScripts(
      {
        'build:beta:mac': 'npm run patch:beta && npm run build',
        build: 'echo build',
      },
      {
        pathExists: () => true,
      }
    );

    expect(result.errors).toContain(
      '[build:beta:mac] runs patch:beta but does not run restore:release in the same script'
    );
  });

  it('flags test:all when deps preflight is missing', () => {
    const result = smokeScripts.validateScripts(
      {
        'test:all': 'npm run build && node build/test-all.js',
      },
      {
        pathExists: () => true,
      }
    );

    expect(result.errors).toContain('[test:all] must run deps:preflight before build/test checks');
  });

  it('passes a valid script graph', () => {
    const result = smokeScripts.validateScripts(
      {
        build: 'node build/dist-tools.js clean',
        'patch:beta': 'node build/patch-beta.js',
        'restore:release': 'node build/restore-release.js',
        'smoke:scripts': 'node build/smoke-scripts.js',
        'release:beta:mac':
          'npm run patch:beta && npm run build && npm run restore:release && dotenv -e .env -- electron-builder --mac',
        'release:all': 'npm run build && npm run smoke:scripts',
      },
      {
        pathExists: () => true,
      }
    );

    expect(result.errors).toEqual([]);
  });
});
