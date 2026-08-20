import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import {
  CARGO_SAFE_UPDATE_POLICY_VERSION,
  CARGO_SAFE_UPDATE_VERSION,
  MIN_PUBLISH_AGE_MS,
  crateIndexPath,
  findWorkspaceRoot,
  installValidatedLock,
  isPublishAgeAllowed,
  parseArguments,
  parsePublishTime,
  prepareCandidate,
  restoreRealLock,
  validateCandidate,
} from './cargo-safe-update.mjs';

const now = Date.parse('2026-08-20T12:00:00Z');
const olderThan72h = '2026-08-17T11:59:59Z';
const youngerThan72h = '2026-08-19T12:00:00Z';

function withMockFetch(records, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    for (const [pattern, handler] of Object.entries(records)) {
      if (urlStr.includes(pattern)) {
        if (typeof handler === 'function') return handler(urlStr);
        if (handler.error) throw new Error(handler.error);
        if (handler.status && handler.status !== 200) {
          return new globalThis.Response('Not Found', { status: handler.status });
        }
        const text = Array.isArray(handler)
          ? handler.map((r) => JSON.stringify(r)).join('\n')
          : typeof handler === 'string'
            ? handler
            : JSON.stringify(handler);
        return new globalThis.Response(text, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new globalThis.Response('Not found', { status: 404 });
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test('1. allows publish age older than 72 hours', async () => {
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '1.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    { '3/f/foo': [{ name: 'foo', vers: '1.0.0', pubtime: olderThan72h }] },
    async () => {
      const result = await validateCandidate(
        baseline,
        candidate,
        { allowYoung: new Set(), allowGit: new Set() },
        now
      );
      assert.equal(result.newlySelected.length, 1);
      assert.equal(result.approved.length, 1);
    }
  );
});

test('2. allows publish age exactly at 72 hours and blocks below 72 hours', () => {
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS, now), true);
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS + 1, now), false);
  assert.equal(crateIndexPath('a'), '1/a');
  assert.equal(crateIndexPath('ab'), '2/ab');
  assert.equal(crateIndexPath('foo'), '3/f/foo');
  assert.equal(crateIndexPath('serde'), 'se/rd/serde');
});

test('3. blocks too-young direct dependency', async () => {
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '2.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    { '3/f/foo': [{ name: 'foo', vers: '2.0.0', pubtime: youngerThan72h }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now
          ),
        /BLOCKED: dependency update violates 72-hour publish-age policy/
      );
    }
  );
});

test('4. blocks too-young transitive dependency', async () => {
  const baseline = [
    { name: 'app', version: '0.1.0', source: null },
    {
      name: 'foo',
      version: '1.1.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  const candidate = [
    { name: 'app', version: '0.1.0', source: null },
    {
      name: 'foo',
      version: '1.1.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
    {
      name: 'transitive-dep',
      version: '0.1.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    {
      '3/f/foo': [{ name: 'foo', vers: '1.1.0', pubtime: olderThan72h }],
      'tr/an/transitive-dep': [{ name: 'transitive-dep', vers: '0.1.0', pubtime: youngerThan72h }],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now
          ),
        /transitive-dep 0\.1\.0/
      );
    }
  );
});

test('5. allows existing young version already locked in baseline', async () => {
  const baseline = [
    {
      name: 'foo',
      version: '1.2.3',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  const candidate = [
    {
      name: 'foo',
      version: '1.2.3',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  const result = await validateCandidate(
    baseline,
    candidate,
    { allowYoung: new Set(), allowGit: new Set() },
    now
  );
  assert.equal(result.newlySelected.length, 0);
});

test('6. blocks version upgrade from old to young', async () => {
  const baseline = [
    {
      name: 'foo',
      version: '1.2.2',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  const candidate = [
    {
      name: 'foo',
      version: '1.2.3',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    { '3/f/foo': [{ name: 'foo', vers: '1.2.3', pubtime: youngerThan72h }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now
          ),
        /foo 1\.2\.3/
      );
    }
  );
});

test('7. fails closed for new package with missing pubtime', async () => {
  assert.equal(parsePublishTime(undefined), null);
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '1.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch({ '3/f/foo': [{ name: 'foo', vers: '1.0.0' }] }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(baseline, candidate, { allowYoung: new Set(), allowGit: new Set() }, now),
      /missing or invalid pubtime/
    );
  });
});

test('8. fails closed for malformed pubtime', async () => {
  assert.equal(parsePublishTime('not-a-timestamp'), null);
  assert.equal(isPublishAgeAllowed(null, now), false);
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '1.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    { '3/f/foo': [{ name: 'foo', vers: '1.0.0', pubtime: 'invalid-date' }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now
          ),
        /missing or invalid pubtime/
      );
    }
  );
});

test('9. fails closed on crates.io lookup failure (HTTP 500 / 404 / network error)', async () => {
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '1.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch({ '3/f/foo': { status: 500 } }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(baseline, candidate, { allowYoung: new Set(), allowGit: new Set() }, now),
      /cannot prove publish age/
    );
  });
  await withMockFetch({ '3/f/foo': { status: 404 } }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(baseline, candidate, { allowYoung: new Set(), allowGit: new Set() }, now),
      /cannot prove publish age/
    );
  });
  await withMockFetch({ '3/f/foo': { error: 'Network timeout' } }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(baseline, candidate, { allowYoung: new Set(), allowGit: new Set() }, now),
      /cannot prove publish age/
    );
  });
});

test('10. applies exact emergency override and continues blocking other young packages', async () => {
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '1.2.3',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
    {
      name: 'bar',
      version: '1.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    {
      '3/b/bar': [{ name: 'bar', vers: '1.0.0', pubtime: youngerThan72h }],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(['foo@1.2.3']), allowGit: new Set() },
            now
          ),
        /bar 1\.0\.0/
      );
    }
  );
});

test('11. rejects emergency override when reason is missing', () => {
  assert.throws(
    () => parseArguments(['--allow-young', 'foo@1.2.3']),
    /--reason is required with every emergency override/
  );
  assert.throws(
    () => parseArguments(['--allow-git', 'repo@abc']),
    /--reason is required with every emergency override/
  );
});

test('12. continues blocking un-overridden transitive package during emergency override', async () => {
  const baseline = [];
  const candidate = [
    {
      name: 'foo',
      version: '1.2.3',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
    {
      name: 'transitive',
      version: '0.4.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    },
  ];
  await withMockFetch(
    {
      'tr/an/transitive': [{ name: 'transitive', vers: '0.4.0', pubtime: youngerThan72h }],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(['foo@1.2.3']), allowGit: new Set() },
            now
          ),
        /transitive 0\.4\.0/
      );
    }
  );
});

test('13. blocks git dependency revision change without override', async () => {
  const baseline = [
    { name: 'my-git-dep', version: '0.1.0', source: 'git+https://github.com/example/repo#OLDREV' },
  ];
  const candidate = [
    { name: 'my-git-dep', version: '0.1.0', source: 'git+https://github.com/example/repo#NEWREV' },
  ];
  await assert.rejects(
    () =>
      validateCandidate(baseline, candidate, { allowYoung: new Set(), allowGit: new Set() }, now),
    /Blocked Git dependency update:\nmy-git-dep/
  );
});

test('14. applies exact git override and continues blocking other git revision changes', async () => {
  const baseline = [
    { name: 'my-git-dep', version: '0.1.0', source: 'git+https://github.com/example/repo#OLDREV' },
    {
      name: 'other-git-dep',
      version: '0.1.0',
      source: 'git+https://github.com/example/other#OLDREV',
    },
  ];
  const candidate = [
    { name: 'my-git-dep', version: '0.1.0', source: 'git+https://github.com/example/repo#NEWREV' },
    {
      name: 'other-git-dep',
      version: '0.1.0',
      source: 'git+https://github.com/example/other#NEWREV',
    },
  ];
  await assert.rejects(
    () =>
      validateCandidate(
        baseline,
        candidate,
        { allowYoung: new Set(), allowGit: new Set(['my-git-dep@NEWREV']) },
        now
      ),
    /other-git-dep/
  );
});

test('15. ignores path and workspace dependencies for publish-age validation', async () => {
  const baseline = [];
  const candidate = [
    { name: 'local-crate', version: '0.1.0', source: null },
    { name: 'path-crate', version: '0.2.0', source: 'path+file:///crates/path-crate' },
  ];
  const result = await validateCandidate(
    baseline,
    candidate,
    { allowYoung: new Set(), allowGit: new Set() },
    now
  );
  assert.equal(result.newlySelected.length, 2);
  assert.equal(result.approved.length, 0);
});

test('16. blocks unsupported or private registry without provable pubtime', async () => {
  const baseline = [];
  const candidate = [
    { name: 'private-pkg', version: '1.0.0', source: 'registry+https://private.example/index' },
  ];
  await withMockFetch(
    { 'pr/iv/private-pkg': [{ name: 'private-pkg', vers: '1.0.0' }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now
          ),
        /missing or invalid pubtime/
      );
    }
  );
});

test('17. allows alternate registry with valid pubtime older than 72 hours', async () => {
  const baseline = [];
  const candidate = [
    { name: 'private-pkg', version: '1.0.0', source: 'registry+https://private.example/index' },
  ];
  await withMockFetch(
    { 'pr/iv/private-pkg': [{ name: 'private-pkg', vers: '1.0.0', pubtime: olderThan72h }] },
    async () => {
      const result = await validateCandidate(
        baseline,
        candidate,
        { allowYoung: new Set(), allowGit: new Set() },
        now
      );
      assert.equal(result.approved.length, 1);
    }
  );
});

test('18. restoreRealLock preserves lockfile byte-for-byte on failure or drift', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cargo-test-restore-'));
  try {
    const lockPath = path.join(tempDir, 'Cargo.lock');
    const originalBytes = Buffer.from('# EXACT_ORIGINAL_LOCKFILE_BYTES\nversion = 4\n');
    writeFileSync(lockPath, originalBytes);

    writeFileSync(lockPath, Buffer.from('# TAMPERED_LOCKFILE_BYTES\nversion = 4\n'));
    restoreRealLock(lockPath, { path: lockPath, existed: true, bytes: originalBytes });
    assert.deepEqual(readFileSync(lockPath), originalBytes);

    rmSync(lockPath, { force: true });
    restoreRealLock(lockPath, { path: lockPath, existed: true, bytes: originalBytes });
    assert.deepEqual(readFileSync(lockPath), originalBytes);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('19. installValidatedLock installs exact validated candidate lockfile on success', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cargo-test-install-'));
  try {
    const manifestPath = path.join(tempDir, 'Cargo.toml');
    const realLock = path.join(tempDir, 'Cargo.lock');
    const candidateLock = path.join(tempDir, 'Candidate.lock');
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    writeFileSync(path.join(tempDir, 'src', 'lib.rs'), '');

    writeFileSync(
      manifestPath,
      '[package]\nname = "test-pkg"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n'
    );
    const candidateContent = Buffer.from(
      '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "test-pkg"\nversion = "0.1.0"\n'
    );
    writeFileSync(realLock, Buffer.from('# ORIGINAL\nversion = 4\n'));
    writeFileSync(candidateLock, candidateContent);

    installValidatedLock(
      candidateLock,
      { path: realLock, existed: true, bytes: Buffer.from('# ORIGINAL\nversion = 4\n') },
      ['--manifest-path', manifestPath],
      tempDir
    );
    assert.deepEqual(readFileSync(realLock), candidateContent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('20. installValidatedLock rolls back to original lockfile when final verification fails', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cargo-test-rollback-'));
  try {
    const realLock = path.join(tempDir, 'Cargo.lock');
    const candidateLock = path.join(tempDir, 'Candidate.lock');
    const originalContent = Buffer.from('# ORIGINAL_BYTES\nversion = 4\n');
    writeFileSync(realLock, originalContent);
    writeFileSync(candidateLock, Buffer.from('# INVALID_CANDIDATE\nversion = 4\n'));

    assert.throws(
      () =>
        installValidatedLock(
          candidateLock,
          { path: realLock, existed: true, bytes: originalContent },
          ['--manifest-path', path.join(tempDir, 'nonexistent-Cargo.toml')],
          tempDir
        ),
      /Final Cargo\.lock verification failed; original lock restored\./
    );

    assert.deepEqual(readFileSync(realLock), originalContent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('21. detects and restores real lockfile modification drift during resolution', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cargo-test-drift-'));
  try {
    const realLock = path.join(tempDir, 'Cargo.lock');
    const originalBytes = Buffer.from('original lock bytes');
    writeFileSync(realLock, originalBytes);

    writeFileSync(realLock, Buffer.from('unexpectedly mutated lock bytes'));
    restoreRealLock(realLock, { path: realLock, existed: true, bytes: originalBytes });
    assert.deepEqual(readFileSync(realLock), originalBytes);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('22. candidate stage implementation never invokes cargo build/check/test/run/bench', () => {
  const source = readFileSync(new URL('./cargo-safe-update.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /run\(\s*['"]cargo['"]\s*,\s*\[\s*['"](build|check|test|run|bench|install)['"]/
  );
  assert.doesNotMatch(source, /\btauri\s+build\b/);
});

test('23. preserves and forwards standard Cargo update arguments', () => {
  const parsed = parseArguments([
    '-p',
    'serde',
    '--precise',
    '1.0.200',
    '--recursive',
    '--workspace',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '-v',
  ]);
  assert.deepEqual(parsed.cargoArgs, [
    '-p',
    'serde',
    '--precise',
    '1.0.200',
    '--recursive',
    '--workspace',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '-v',
  ]);
});

test('24. prepares candidate in temporary lockfile using CARGO_RESOLVER_LOCKFILE_PATH and leaves it nonexistent if no baseline', () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'cargo-test-ws-'));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cargo-test-temp-'));
  try {
    // When no baseline lockfile exists:
    const result = prepareCandidate({
      cargoArgs: ['--manifest-path', path.join(workspaceDir, 'Cargo.toml')],
      cwd: workspaceDir,
      realLock: null,
      baselineMetadata: null,
      tempRoot,
    });
    if (!result.copiedWorkspace) {
      assert.ok(result.env.CARGO_RESOLVER_LOCKFILE_PATH);
      assert.equal(path.basename(result.env.CARGO_RESOLVER_LOCKFILE_PATH), 'Cargo.lock');
      // Invariant: candidateLock MUST NOT exist before Cargo creates it!
      assert.equal(existsSync(result.candidateLock), false);
    }
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('25. dependency update entry points use guarded Cargo resolution', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['u', 'u2', 'deps:rust:update']) {
    const command = packageJson.scripts?.[name];
    if (!command) continue;
    assert.doesNotMatch(command, /\bcargo update\b/);
    assert.match(command, /cargo-safe-update/);
  }
});

test('26. integration test: no-lock workspace generates candidate in temp, leaves real lock untouched, installs on approval', () => {
  const tempWs = mkdtempSync(path.join(os.tmpdir(), 'cargo-int-nolock-'));
  const tempGuard = mkdtempSync(path.join(os.tmpdir(), 'cargo-int-guard-'));
  try {
    const manifestPath = path.join(tempWs, 'Cargo.toml');
    const realLock = path.join(tempWs, 'Cargo.lock');
    mkdirSync(path.join(tempWs, 'src'), { recursive: true });
    writeFileSync(path.join(tempWs, 'src', 'lib.rs'), '// simple lib\n');
    writeFileSync(
      manifestPath,
      '[package]\nname = "no-lock-fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n'
    );

    assert.equal(existsSync(realLock), false, 'real Cargo.lock must not exist initially');

    const prep = prepareCandidate({
      cargoArgs: ['--manifest-path', manifestPath],
      cwd: tempWs,
      realLock: null,
      baselineMetadata: null,
      tempRoot: tempGuard,
    });

    if (!prep.copiedWorkspace) {
      assert.equal(
        existsSync(prep.candidateLock),
        false,
        'candidateLock must not exist prior to resolution'
      );
    }

    // Simulate approval and transactional install
    const candidateContent = Buffer.from(
      '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "no-lock-fixture"\nversion = "0.1.0"\n'
    );
    writeFileSync(prep.candidateLock, candidateContent);

    assert.equal(existsSync(realLock), false, 'real lock still does not exist before install');

    installValidatedLock(
      prep.candidateLock,
      { path: realLock, existed: false, bytes: null },
      ['--manifest-path', manifestPath],
      tempWs
    );

    assert.equal(existsSync(realLock), true, 'real lock installed on approval');
    assert.deepEqual(readFileSync(realLock), candidateContent);
  } finally {
    rmSync(tempWs, { recursive: true, force: true });
    rmSync(tempGuard, { recursive: true, force: true });
  }
});

test('27. integration test: no-lock workspace restores absence on policy rejection or resolution failure', () => {
  const tempWs = mkdtempSync(path.join(os.tmpdir(), 'cargo-int-reject-'));
  try {
    const realLock = path.join(tempWs, 'Cargo.lock');
    assert.equal(existsSync(realLock), false);

    // If realLock was unexpectedly created during dirty resolution:
    writeFileSync(realLock, Buffer.from('dirty resolution bytes'));
    restoreRealLock(realLock, { path: realLock, existed: false, bytes: null });

    assert.equal(
      existsSync(realLock),
      false,
      'real lockfile must be deleted on rollback to absence'
    );
  } finally {
    rmSync(tempWs, { recursive: true, force: true });
  }
});

test('28. integration test: no-lock workspace restores absence if final verification fails', () => {
  const tempWs = mkdtempSync(path.join(os.tmpdir(), 'cargo-int-verifail-'));
  const tempGuard = mkdtempSync(path.join(os.tmpdir(), 'cargo-int-vguard-'));
  try {
    const realLock = path.join(tempWs, 'Cargo.lock');
    const candidateLock = path.join(tempGuard, 'Cargo.lock');
    writeFileSync(candidateLock, Buffer.from('# INVALID_CANDIDATE\nversion = 4\n'));

    assert.throws(
      () =>
        installValidatedLock(
          candidateLock,
          { path: realLock, existed: false, bytes: null },
          ['--manifest-path', path.join(tempWs, 'nonexistent-Cargo.toml')],
          tempWs
        ),
      /Final Cargo\.lock verification failed; original lock restored\./
    );

    assert.equal(
      existsSync(realLock),
      false,
      'new real Cargo.lock must be removed if workspace originally had no lockfile'
    );
  } finally {
    rmSync(tempWs, { recursive: true, force: true });
    rmSync(tempGuard, { recursive: true, force: true });
  }
});

test('29. findWorkspaceRoot correctly locates roots for standalone, member, and virtual workspaces', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cargo-ws-roots-'));
  try {
    // 1. Nested standalone (src-tauri without root workspace)
    const standaloneDir = path.join(tempRoot, 'standalone');
    const tauriDir = path.join(standaloneDir, 'src-tauri');
    mkdirSync(tauriDir, { recursive: true });
    writeFileSync(
      path.join(tauriDir, 'Cargo.toml'),
      '[package]\nname = "standalone"\nversion = "0.1.0"\n'
    );
    assert.equal(findWorkspaceRoot(path.join(tauriDir, 'Cargo.toml')), tauriDir);

    // 2. Member of workspace (repo with root Cargo.toml [workspace] and crates/app)
    const wsDir = path.join(tempRoot, 'ws-with-members');
    const appDir = path.join(wsDir, 'crates', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(wsDir, 'Cargo.toml'), '[workspace]\nmembers = ["crates/app"]\n');
    writeFileSync(path.join(appDir, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
    assert.equal(findWorkspaceRoot(path.join(appDir, 'Cargo.toml')), wsDir);

    // 3. Virtual workspace root
    assert.equal(findWorkspaceRoot(path.join(wsDir, 'Cargo.toml')), wsDir);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('30. version markers are exported', () => {
  assert.equal(CARGO_SAFE_UPDATE_POLICY_VERSION, 2);
  assert.equal(CARGO_SAFE_UPDATE_VERSION, 2);
});
