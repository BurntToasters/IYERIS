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
      archiveLogFn: null as unknown,
      getFile: () => ({ path: '/tmp/test.log' }),
    },
    console: {
      format: '',
    },
  },
}));

vi.mock('electron-log', () => ({ default: mockLog }));
vi.mock('../../shared', () => ({ ignoreError: () => {} }));

import { logger } from '../../main/logger';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sanitize via logger.info', () => {
    it('redacts Windows user paths', () => {
      logger.info('Path is C:\\Users\\john\\Documents\\file.txt');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('C:\\Users\\<user>');
      expect(arg).not.toContain('john');
    });

    it('redacts Unix home paths', () => {
      logger.info('Path is /home/john/documents/file.txt');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('/home/<user>');
      expect(arg).not.toContain('john');
    });

    it('redacts Mac user paths', () => {
      logger.info('Path is /Users/jane/Desktop/file.txt');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('/Users/<user>');
      expect(arg).not.toContain('jane');
    });

    it('redacts UNC paths', () => {
      logger.info('Accessing \\\\server1\\share');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('\\\\<server>\\<share>');
      expect(arg).not.toContain('server1');
    });

    it('redacts email addresses', () => {
      logger.info('Email: user@example.com');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('<email>');
      expect(arg).not.toContain('user@example.com');
    });

    it('redacts password patterns', () => {
      logger.info('password=my_secret_pass');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('<redacted>');
      expect(arg).not.toContain('my_secret_pass');
    });

    it('redacts api_key patterns', () => {
      logger.info('api_key=abc123xyz');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('<redacted>');
      expect(arg).not.toContain('abc123xyz');
    });

    it('redacts token patterns', () => {
      logger.info('token=eyJhbGciOiJ');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('<redacted>');
    });

    it('redacts secret patterns', () => {
      logger.info('secret=verysecretvalue');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('<redacted>');
      expect(arg).not.toContain('verysecretvalue');
    });

    it('redacts authorization patterns', () => {
      logger.info('authorization=Bearer xyz');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toContain('<redacted>');
    });

    it('passes through safe strings unchanged', () => {
      logger.info('Just a normal message');
      const arg = mockLog.info.mock.calls[0][0] as string;
      expect(arg).toBe('Just a normal message');
    });

    it('passes through numbers unchanged', () => {
      logger.info(42);
      const arg = mockLog.info.mock.calls[0][0];
      expect(arg).toBe(42);
    });

    it('passes through null and undefined', () => {
      logger.info(null);
      expect(mockLog.info.mock.calls[0][0]).toBeNull();
      logger.info(undefined);
      expect(mockLog.info.mock.calls[1][0]).toBeUndefined();
    });

    it('passes through booleans', () => {
      logger.info(true);
      expect(mockLog.info.mock.calls[0][0]).toBe(true);
    });
  });

  describe('sanitize complex types', () => {
    it('sanitizes Error message', () => {
      const err = new Error('Failed at /home/alice/project');
      logger.error(err);
      const arg = mockLog.error.mock.calls[0][0] as Error;
      expect(arg).toBeInstanceOf(Error);
      expect(arg.message).toContain('/home/<user>');
      expect(arg.message).not.toContain('alice');
    });

    it('sanitizes Error stack', () => {
      const err = new Error('fail');
      err.stack = 'Error: fail\n    at /home/bob/src/index.ts:10:5';
      logger.error(err);
      const arg = mockLog.error.mock.calls[0][0] as Error;
      expect(arg.stack).toContain('/home/<user>');
      expect(arg.stack).not.toContain('bob');
    });

    it('sanitizes arrays', () => {
      logger.info(['/home/bob/file.txt', 'safe', 42]);
      const arg = mockLog.info.mock.calls[0][0] as unknown[];
      expect(arg[0]).toContain('/home/<user>');
      expect(arg[1]).toBe('safe');
      expect(arg[2]).toBe(42);
    });

    it('sanitizes nested objects', () => {
      logger.info({ path: '/home/carol/docs', count: 5 });
      const arg = mockLog.info.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.path).toContain('/home/<user>');
      expect(arg.count).toBe(5);
    });

    it('sanitizes multiple arguments', () => {
      logger.info('Message', '/Users/dave/file', 123);
      expect(mockLog.info.mock.calls[0][0]).toBe('Message');
      expect(mockLog.info.mock.calls[0][1]).toContain('/Users/<user>');
      expect(mockLog.info.mock.calls[0][2]).toBe(123);
    });
  });

  describe('logger.warn', () => {
    it('sanitizes warning messages', () => {
      logger.warn('Warning at /home/user1/path');
      const arg = mockLog.warn.mock.calls[0][0] as string;
      expect(arg).toContain('/home/<user>');
      expect(arg).not.toContain('user1');
    });
  });

  describe('logger.error', () => {
    it('sanitizes error messages', () => {
      logger.error('Error at C:\\Users\\admin\\logs');
      const arg = mockLog.error.mock.calls[0][0] as string;
      expect(arg).toContain('C:\\Users\\<user>');
      expect(arg).not.toContain('admin');
    });
  });

  describe('getLogPath', () => {
    it('returns a string path', () => {
      expect(logger.getLogPath()).toBe('/tmp/test.log');
    });
  });

  describe('getLogsDirectory', () => {
    it('returns the directory of the log file', () => {
      const dir = logger.getLogsDirectory();
      expect(dir).toBe('/tmp');
    });
  });
});
