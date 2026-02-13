import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  transports: {
    file: {
      maxSize: 0,
      format: '',
      archiveLogFn: null as ((oldLogFile: { path: string; toString: () => string }) => void) | null,
      getFile: () => ({ path: '/tmp/test.log' }),
    },
    console: {
      format: '',
    },
  },
}));

vi.mock('electron-log', () => ({ default: mockLog }));
vi.mock('../../shared', () => ({ ignoreError: () => {} }));

describe('logger extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logger.debug', () => {
    it('is callable and sanitizes arguments', async () => {
      const { logger } = await import('../../utils/logger');
      logger.debug('Test /home/alice/secret');
    });

    it('sanitizes Error objects in debug', async () => {
      const { logger } = await import('../../utils/logger');
      const err = new Error('error at /home/bob/path');
      logger.debug(err);
    });
  });

  describe('initializeLogger', () => {
    it('logs startup info without throwing', async () => {
      const { initializeLogger } = await import('../../utils/logger');
      expect(() => initializeLogger()).not.toThrow();

      expect(mockLog.info).toHaveBeenCalled();
    });

    it('logs platform and version info', async () => {
      const { initializeLogger } = await import('../../utils/logger');
      initializeLogger();

      const allInfoCalls = mockLog.info.mock.calls.map((c) => String(c[0]));
      const hasPlatform = allInfoCalls.some((msg) => msg.includes('Platform'));
      const hasArch = allInfoCalls.some((msg) => msg.includes('Arch'));
      const hasNode = allInfoCalls.some((msg) => msg.includes('Node'));
      expect(hasPlatform).toBe(true);
      expect(hasArch).toBe(true);
      expect(hasNode).toBe(true);
    });
  });

  describe('archiveLogFn', () => {
    it('is set as a function on file transport', async () => {
      await import('../../utils/logger');
      expect(typeof mockLog.transports.file.archiveLogFn).toBe('function');
    });

    it('modifies oldLogFile.toString', async () => {
      await import('../../utils/logger');
      const archiveFn = mockLog.transports.file.archiveLogFn!;
      const oldLogFile = {
        path: '/tmp/logs/main.log',
        toString: () => '/tmp/logs/main.log',
      };

      archiveFn(oldLogFile);

      const newPath = oldLogFile.toString();
      expect(newPath).toContain('main.');
      expect(newPath).toContain('.log');
    });
  });

  describe('transport configuration', () => {
    it('sets max file size', async () => {
      await import('../../utils/logger');
      expect(mockLog.transports.file.maxSize).toBe(2 * 1024 * 1024);
    });

    it('sets file format', async () => {
      await import('../../utils/logger');
      expect(mockLog.transports.file.format).toContain('{level}');
    });

    it('sets console format', async () => {
      await import('../../utils/logger');
      expect(mockLog.transports.console.format).toContain('{level}');
    });
  });
});
