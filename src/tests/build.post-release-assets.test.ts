import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

type PostReleaseAssetsModule = {
  cleanReleaseArtifacts: (releaseDir?: string) => void;
  run: (options?: { releaseDir?: string; env?: Record<string, string | undefined> }) => {
    mirrored: boolean;
    destination: string | null;
  };
};

const require = createRequire(__filename);
const postReleaseAssets = require('../../build/post-release-assets.js') as PostReleaseAssetsModule;

const tempRoots: string[] = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-post-release-assets-'));
  tempRoots.push(root);
  return root;
}

function writeFile(targetPath: string, content: string) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('build/post-release-assets.js', () => {
  it('removes configured build-only release artifacts', () => {
    const root = makeTempRoot();
    const releaseDir = path.join(root, 'release');

    fs.mkdirSync(path.join(releaseDir, 'win-unpacked'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'win-arm64-unpacked'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'linux-unpacked'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'linux-arm64-unpacked'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'mac-universal'), { recursive: true });
    writeFile(path.join(releaseDir, 'builder-debug.yml'), 'debug');
    writeFile(path.join(releaseDir, 'builder-effective-config.yaml'), 'effective');
    writeFile(path.join(releaseDir, 'IYERIS-Win-x64.exe'), 'installer');

    postReleaseAssets.cleanReleaseArtifacts(releaseDir);

    expect(fs.existsSync(path.join(releaseDir, 'win-unpacked'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'win-arm64-unpacked'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'linux-unpacked'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'linux-arm64-unpacked'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'mac-universal'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'builder-debug.yml'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'builder-effective-config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'IYERIS-Win-x64.exe'))).toBe(true);
  });

  it('succeeds when cleanup targets are absent', () => {
    const root = makeTempRoot();
    const releaseDir = path.join(root, 'release');
    fs.mkdirSync(releaseDir, { recursive: true });
    writeFile(path.join(releaseDir, 'IYERIS-MacOS-universal.dmg'), 'dmg');

    expect(() => postReleaseAssets.cleanReleaseArtifacts(releaseDir)).not.toThrow();
    expect(fs.existsSync(path.join(releaseDir, 'IYERIS-MacOS-universal.dmg'))).toBe(true);
  });

  it('skips mirroring when AFTER_PACK_LOC is unset', () => {
    const root = makeTempRoot();
    const releaseDir = path.join(root, 'release');
    fs.mkdirSync(releaseDir, { recursive: true });
    writeFile(path.join(releaseDir, 'IYERIS-Linux-x64.AppImage'), 'appimage');
    writeFile(path.join(releaseDir, 'builder-debug.yml'), 'debug');

    const result = postReleaseAssets.run({ releaseDir, env: {} });

    expect(result.mirrored).toBe(false);
    expect(result.destination).toBeNull();
    expect(fs.existsSync(path.join(releaseDir, 'builder-debug.yml'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'IYERIS-Linux-x64.AppImage'))).toBe(true);
  });

  it('mirrors cleaned release assets recursively when AFTER_PACK_LOC is set', () => {
    const root = makeTempRoot();
    const releaseDir = path.join(root, 'release');
    const destination = path.join(root, 'mirror');
    fs.mkdirSync(releaseDir, { recursive: true });

    writeFile(path.join(releaseDir, 'nested', 'linux', 'IYERIS-Linux-arm64.rpm'), 'rpm');
    writeFile(path.join(releaseDir, 'IYERIS-Win-x64.exe'), 'exe');

    const result = postReleaseAssets.run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
    });

    expect(result.mirrored).toBe(true);
    expect(result.destination).toBe(path.resolve(destination));
    expect(fs.existsSync(path.join(destination, 'nested', 'linux', 'IYERIS-Linux-arm64.rpm'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(destination, 'IYERIS-Win-x64.exe'))).toBe(true);
  });

  it('overwrites existing destination files without deleting unrelated files', () => {
    const root = makeTempRoot();
    const releaseDir = path.join(root, 'release');
    const destination = path.join(root, 'mirror');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });

    writeFile(path.join(releaseDir, 'IYERIS-Win-x64.exe'), 'new-binary');
    writeFile(path.join(destination, 'IYERIS-Win-x64.exe'), 'old-binary');
    writeFile(path.join(destination, 'keep-me.txt'), 'keep');

    postReleaseAssets.run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
    });

    expect(fs.readFileSync(path.join(destination, 'IYERIS-Win-x64.exe'), 'utf8')).toBe(
      'new-binary'
    );
    expect(fs.readFileSync(path.join(destination, 'keep-me.txt'), 'utf8')).toBe('keep');
  });
});
