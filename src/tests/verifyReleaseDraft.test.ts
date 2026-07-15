import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const verifier = require('../../scripts/verify-release-draft.cjs') as {
  expectedStableAssets: () => Set<string>;
  validateStableDraft: (
    release: { draft: boolean; prerelease: boolean; tag_name: string },
    assets: Array<{ name: string; size: number }>
  ) => string[];
  tag: string;
};

describe('stable release draft verification', () => {
  const release = { draft: true, prerelease: false, tag_name: verifier.tag };

  it('accepts a complete non-empty asset set', () => {
    const assets = Array.from(verifier.expectedStableAssets(), (name) => ({ name, size: 1 }));
    expect(verifier.validateStableDraft(release, assets)).toEqual([]);
  });

  it('reports missing and empty assets', () => {
    const names = Array.from(verifier.expectedStableAssets());
    const missing = names[0];
    const empty = names[1];
    const assets = names
      .filter((name) => name !== missing)
      .map((name) => ({ name, size: name === empty ? 0 : 1 }));

    const errors = verifier.validateStableDraft(release, assets);
    expect(errors).toContain(`missing asset: ${missing}`);
    expect(errors).toContain(`empty asset: ${empty}`);
  });

  it('rejects published or prerelease drafts', () => {
    const assets = Array.from(verifier.expectedStableAssets(), (name) => ({ name, size: 1 }));
    const errors = verifier.validateStableDraft(
      { draft: false, prerelease: true, tag_name: release.tag_name },
      assets
    );
    expect(errors).toContain(`${release.tag_name} is not a draft release`);
    expect(errors).toContain(`${release.tag_name} is marked as a prerelease`);
  });
});
