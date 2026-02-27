import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

type DependencyPreflightModule = {
  lockRootDependencies: (lock: Record<string, unknown>) => Record<string, string>;
  validateDependencies: (
    pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    },
    lock: Record<string, unknown>,
    rootDir?: string
  ) => { errors: string[] };
};

const require = createRequire(__filename);
const dependencyPreflight =
  require('../../build/dependency-preflight.js') as DependencyPreflightModule;

describe('build/dependency-preflight.js', () => {
  it('extracts root dependencies from package-lock format', () => {
    const lock = {
      packages: {
        '': {
          dependencies: {
            marked: '^17.0.3',
          },
        },
      },
    };

    expect(dependencyPreflight.lockRootDependencies(lock)).toEqual({
      marked: '^17.0.3',
    });
  });

  it('reports missing runtime dependency in lock root', () => {
    const result = dependencyPreflight.validateDependencies(
      {
        dependencies: {
          marked: '^17.0.3',
        },
        devDependencies: {
          eslint: '^10.0.0',
          prettier: '^3.0.0',
          typescript: '^5.0.0',
          vitest: '^4.0.0',
        },
      },
      {
        packages: {
          '': {
            dependencies: {},
          },
        },
      }
    );

    expect(result.errors.some((e) => e.includes('[runtime] "marked" is missing'))).toBe(true);
  });

  it('passes for a minimal valid dependency set', () => {
    const result = dependencyPreflight.validateDependencies(
      {
        dependencies: {},
        devDependencies: {
          eslint: '^10.0.0',
          prettier: '^3.0.0',
          typescript: '^5.0.0',
          vitest: '^4.0.0',
        },
      },
      {
        packages: {
          '': {
            dependencies: {
              eslint: '^10.0.0',
              prettier: '^3.0.0',
              typescript: '^5.0.0',
              vitest: '^4.0.0',
            },
          },
        },
      }
    );

    expect(result.errors).toEqual([]);
  });
});
