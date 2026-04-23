// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type AssetScope = string[] | { allow?: string[]; deny?: string[] };

describe('tauri asset protocol scope', () => {
  it('uses explicit allow and deny rules', () => {
    const configPath = resolve(process.cwd(), 'src-tauri', 'tauri.conf.json');
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      app?: {
        security?: {
          assetProtocol?: {
            enable?: boolean;
            scope?: AssetScope;
          };
        };
      };
    };

    const assetProtocol = parsed.app?.security?.assetProtocol;
    expect(assetProtocol?.enable).toBe(true);

    const scope = assetProtocol?.scope;
    expect(scope).toBeDefined();
    expect(Array.isArray(scope)).toBe(false);

    const scoped = scope as { allow?: string[]; deny?: string[] };
    expect(scoped.allow).toContain('**');
    expect(scoped.deny).toEqual(
      expect.arrayContaining([
        '$APPDATA/**',
        '$APPLOCALDATA/**',
        '$APPCACHE/**',
        '$APPLOG/**',
        '$RESOURCE/**',
        '$HOME/.ssh/**',
        '$HOME/.gnupg/**',
        '$HOME/.aws/**',
        '$HOME/.docker/**',
        '$HOME/.kube/**',
      ])
    );
  });
});
