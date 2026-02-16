import log from 'electron-log';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const isDebugEnabled = process.argv.includes('--enable-logging') || process.env.DEBUG === 'true';
const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const sensitivePatterns: RegExp[] = [
  /[A-Za-z]:\\Users\\[^\\]+/gi,
  /\/home\/[^/]+/gi,
  /\/Users\/[^/]+/gi,
  /\\\\[^\\]+\\[^\\]+/gi,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  /password[=:]\s*["']?[^"'\s]+["']?/gi,
  /api[_-]?key[=:]\s*["']?[^"'\s]+["']?/gi,
  /token[=:]\s*["']?[^"'\s]+["']?/gi,
  /secret[=:]\s*["']?[^"'\s]+["']?/gi,
  /authorization[=:]\s*["']?[^"'\s]+["']?/gi,
];

function sanitize(input: unknown): unknown {
  if (typeof input === 'string') {
    let sanitized = input;
    sanitized = sanitized.replace(/[A-Za-z]:\\Users\\([^\\]+)/gi, 'C:\\Users\\<user>');
    sanitized = sanitized.replace(/\/home\/([^/]+)/gi, '/home/<user>');
    sanitized = sanitized.replace(/\/Users\/([^/]+)/gi, '/Users/<user>');
    sanitized = sanitized.replace(/\\\\([^\\]+)\\([^\\]+)/gi, '\\\\<server>\\<share>');
    sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '<email>');
    sensitivePatterns.slice(4).forEach((pattern) => {
      sanitized = sanitized.replace(pattern, '<redacted>');
    });
    return sanitized;
  }
  if (input instanceof Error) {
    const sanitizedError = new Error(sanitize(input.message) as string);
    if (input.stack) {
      sanitizedError.stack = sanitize(input.stack) as string;
    }
    return sanitizedError;
  }
  if (Array.isArray(input)) {
    return input.map(sanitize);
  }
  if (input && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = sanitize(value);
    }
    return result;
  }
  return input;
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map(sanitize);
}

function getCandidateLogDirectories(): string[] {
  const candidates: string[] = [];
  const customDir = process.env.IYERIS_LOG_DIR;
  if (customDir && customDir.trim().length > 0) {
    candidates.push(customDir);
  }

  if (!isTestEnv) {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'iyeris', 'logs'));
    } else if (process.platform === 'darwin') {
      candidates.push(path.join(os.homedir(), 'Library', 'Logs', 'iyeris'));
    } else {
      candidates.push(path.join(os.homedir(), '.config', 'iyeris', 'logs'));
    }
  }

  candidates.push(path.join(os.homedir(), '.iyeris', 'logs'));
  candidates.push(path.join(os.tmpdir(), 'iyeris', 'logs'));
  return candidates;
}

function findWritableLogPath(): string | null {
  for (const dirPath of getCandidateLogDirectories()) {
    const candidatePath = path.join(dirPath, 'main.log');
    try {
      fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
      fs.appendFileSync(candidatePath, '');
      return candidatePath;
    } catch {
      continue;
    }
  }
  return null;
}

const resolvedLogPath = findWritableLogPath();
if (resolvedLogPath) {
  log.transports.file.resolvePathFn = () => resolvedLogPath;
} else {
  log.transports.file.level = false;
}

log.transports.file.maxSize = 2 * 1024 * 1024;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.console.format = '[{level}] {text}';

log.transports.file.archiveLogFn = (oldLogFile) => {
  const info = path.parse(oldLogFile.path);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const newPath = path.join(info.dir, `${info.name}.${timestamp}${info.ext}`);
  try {
    oldLogFile.toString = () => newPath;
  } catch {
    return;
  }
};

function getTransportPath(): string | null {
  try {
    const fileTransport = log.transports.file as {
      getFile?: () => { path?: string };
    };
    const transportPath = fileTransport.getFile?.().path;
    if (typeof transportPath === 'string' && transportPath.length > 0) {
      return transportPath;
    }
  } catch {
    return null;
  }
  return null;
}

export const logger = {
  debug: (...args: unknown[]): void => {
    const sanitizedArgs = sanitizeArgs(args);
    if (isDebugEnabled) {
      log.debug(...sanitizedArgs);
    }
  },
  info: (...args: unknown[]): void => {
    log.info(...sanitizeArgs(args));
  },
  warn: (...args: unknown[]): void => {
    log.warn(...sanitizeArgs(args));
  },
  error: (...args: unknown[]): void => {
    log.error(...sanitizeArgs(args));
  },
  getLogPath: (): string => {
    return (
      getTransportPath() || resolvedLogPath || path.join(os.tmpdir(), 'iyeris', 'logs', 'main.log')
    );
  },
  getLogsDirectory: (): string => {
    return path.dirname(logger.getLogPath());
  },
};

export function initializeLogger(): void {
  (globalThis as Record<string, unknown>).__iyerisLogger = logger;
  log.info('='.repeat(60));
  log.info(`App started - ${new Date().toISOString()}`);
  log.info(`Platform: ${process.platform} ${os.release()}`);
  log.info(`Arch: ${process.arch}`);
  log.info(`Node: ${process.versions.node}`);
  log.info(`Electron: ${process.versions.electron}`);
  log.info('='.repeat(60));
}
