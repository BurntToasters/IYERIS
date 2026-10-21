import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseChannelVariants } from './gpg-sign.js';

test('stable releases point both updater channels at stable artifacts', () => {
  assert.deepEqual(releaseChannelVariants(false, 'https://stable', 'https://tag'), [
    { targetSuffix: '', baseUrl: 'https://stable' },
    { targetSuffix: '-beta', baseUrl: 'https://stable' },
  ]);
});

test('prereleases keep beta artifacts on their version tag', () => {
  assert.deepEqual(releaseChannelVariants(true, 'https://release', 'https://tag'), [
    { targetSuffix: '', baseUrl: 'https://release' },
    { targetSuffix: '-beta', baseUrl: 'https://tag' },
  ]);
});
