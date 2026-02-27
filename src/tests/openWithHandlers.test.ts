import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const hoisted = vi.hoisted(() => {
  return {
    handlers: new Map<string, Handler>(),
    trusted: { value: true },
    safePath: { value: true },
    execFileMock: vi.fn(),
    shellMock: { openPath: vi.fn(async () => '') },
    fsPromisesMock: {
      access: vi.fn(),
      readFile: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      hoisted.handlers.set(channel, handler);
    }),
  },
  shell: hoisted.shellMock,
}));

vi.mock('child_process', () => ({
  execFile: hoisted.execFileMock,
}));

vi.mock('fs', () => ({
  promises: hoisted.fsPromisesMock,
}));

vi.mock('../main/security', () => ({
  isPathSafe: vi.fn(() => hoisted.safePath.value),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

vi.mock('../main/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../main/ipcUtils', () => ({
  withTrustedApiHandler: vi.fn(
    (
      _channel: string,
      handler: (...args: unknown[]) => unknown,
      untrustedResponse?: { success: boolean; error?: string }
    ) =>
      async (...args: unknown[]) =>
        hoisted.trusted.value
          ? await handler(...args)
          : (untrustedResponse ?? { success: false, error: 'Untrusted IPC sender' })
  ),
}));

import {
  setupOpenWithHandlers,
  tokenizeExecCommand,
  buildLinuxExecInvocation,
} from '../main/openWithHandlers';

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.trusted.value = true;
  hoisted.safePath.value = true;
});

function invoke(channel: string, ...args: unknown[]) {
  const handler = hoisted.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({} as unknown, ...args);
}

describe('setupOpenWithHandlers', () => {
  it('registers get-open-with-apps and open-file-with-app handlers', () => {
    setupOpenWithHandlers();
    expect(hoisted.handlers.has('get-open-with-apps')).toBe(true);
    expect(hoisted.handlers.has('open-file-with-app')).toBe(true);
  });
});

describe('desktop Exec parsing helpers', () => {
  it('tokenizes quoted command strings', () => {
    const tokens = tokenizeExecCommand('"my app" --open "%f" --name test');
    expect(tokens).toEqual(['my app', '--open', '%f', '--name', 'test']);
  });

  it('builds invocation and appends file path when no placeholder is present', () => {
    const invocation = buildLinuxExecInvocation('my-app --flag', '/tmp/example.txt');
    expect(invocation).toEqual({
      command: 'my-app',
      args: ['--flag', '/tmp/example.txt'],
    });
  });

  it('replaces placeholders in invocation args', () => {
    const invocation = buildLinuxExecInvocation('my-app --open=%f %U', '/tmp/with space.txt');
    expect(invocation).toEqual({
      command: 'my-app',
      args: ['--open=/tmp/with space.txt', '/tmp/with space.txt'],
    });
  });
});

describe('get-open-with-apps', () => {
  beforeEach(() => {
    setupOpenWithHandlers();
  });

  it('returns error for unsafe path', async () => {
    hoisted.safePath.value = false;
    const result = (await invoke('get-open-with-apps', '/some/file.txt')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid path');
  });

  it('returns apps on Linux with xdg-mime available', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    hoisted.execFileMock.mockImplementation(
      (
        cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string) => void
      ) => {
        if (cmd === 'xdg-mime' && args[0] === 'query' && args[1] === 'filetype') {
          cb(null, 'text/plain\n');
        } else if (cmd === 'xdg-mime' && args[0] === 'query' && args[1] === 'default') {
          cb(null, 'org.gnome.TextEditor.desktop\n');
        } else {
          cb(new Error('not found'));
        }
      }
    );

    hoisted.fsPromisesMock.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('org.gnome.TextEditor.desktop')) {
        return '[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor %U\nType=Application';
      }
      throw new Error('ENOENT');
    });

    const result = (await invoke('get-open-with-apps', '/home/user/file.txt')) as {
      success: boolean;
      apps?: Array<{ id: string; name: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.apps).toBeDefined();
    expect(result.apps!.some((a) => a.name === 'Text Editor')).toBe(true);

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  it('returns fallback apps on Linux when xdg-mime fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    hoisted.execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string) => void
      ) => {
        cb(new Error('command not found'));
      }
    );

    hoisted.fsPromisesMock.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('org.gnome.TextEditor.desktop')) {
        return '[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor\nType=Application';
      }
      throw new Error('ENOENT');
    });

    const result = (await invoke('get-open-with-apps', '/home/user/file.txt')) as {
      success: boolean;
      apps?: Array<{ id: string; name: string }>;
    };
    expect(result.success).toBe(true);
  });

  it('returns error when untrusted', async () => {
    hoisted.trusted.value = false;
    const result = (await invoke('get-open-with-apps', '/some/file.txt')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Untrusted IPC sender');
  });
});

describe('open-file-with-app', () => {
  beforeEach(() => {
    setupOpenWithHandlers();
  });

  it('returns error for unsafe path', async () => {
    hoisted.safePath.value = false;
    const result = (await invoke('open-file-with-app', '/some/file.txt', 'notepad.exe')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid path');
  });

  it('opens file on Linux using desktop file Exec', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    hoisted.fsPromisesMock.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('org.gnome.TextEditor.desktop')) {
        return '[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor %U\nType=Application';
      }
      throw new Error('ENOENT');
    });

    hoisted.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(null);
      }
    );

    const result = (await invoke(
      'open-file-with-app',
      '/home/user/file.txt',
      'org.gnome.TextEditor.desktop'
    )) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('opens file on Linux with quoted Exec command paths', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    hoisted.fsPromisesMock.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('app.desktop')) {
        return '[Desktop Entry]\nName=App\nExec="/usr/bin/my app" --open "%f"\nType=Application';
      }
      throw new Error('ENOENT');
    });

    hoisted.execFileMock.mockImplementation(
      (cmd: string, args: string[], cb: (err: Error | null) => void) => {
        expect(cmd).toBe('/usr/bin/my app');
        expect(args).toEqual(['--open', '/home/user/file.txt']);
        cb(null);
      }
    );

    const result = (await invoke('open-file-with-app', '/home/user/file.txt', 'app.desktop')) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });

  it('falls back to shell.openPath when no desktop file found on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    hoisted.fsPromisesMock.readFile.mockRejectedValue(new Error('ENOENT'));
    hoisted.shellMock.openPath.mockResolvedValue('');

    const result = (await invoke(
      'open-file-with-app',
      '/home/user/file.txt',
      'nonexistent.desktop'
    )) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('returns error when shell.openPath fails on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    hoisted.fsPromisesMock.readFile.mockRejectedValue(new Error('ENOENT'));
    hoisted.shellMock.openPath.mockResolvedValue('Failed to open');

    const result = (await invoke(
      'open-file-with-app',
      '/home/user/file.txt',
      'nonexistent.desktop'
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to open');
  });

  it('returns error when untrusted', async () => {
    hoisted.trusted.value = false;
    const result = (await invoke('open-file-with-app', '/some/file.txt', 'app')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Untrusted IPC sender');
  });
});
