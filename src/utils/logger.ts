/**
 * Debug logger utility
 * Logs are only shown when --enable-logging flag is passed to electron
 * or when DEBUG environment variable is set
 */

const isDebugEnabled = process.argv.includes('--enable-logging') || process.env.DEBUG === 'true';

export const logger = {
  debug: (...args: unknown[]): void => {
    if (isDebugEnabled) {
      console.log(...args);
    }
  },
  info: (...args: unknown[]): void => {
    console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
