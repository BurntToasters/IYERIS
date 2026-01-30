import { describe, it, expect } from 'vitest';
import {
  HOME_VIEW_PATH,
  HOME_VIEW_LABEL,
  HOME_QUICK_ACCESS_ITEMS,
  isHomeViewPath,
  getPathDisplayValue,
} from './home';

describe('HOME_VIEW_PATH', () => {
  it('is a valid protocol path', () => {
    expect(HOME_VIEW_PATH).toBe('iyeris://home');
    expect(HOME_VIEW_PATH).toMatch(/^[a-z]+:\/\//);
  });
});

describe('HOME_VIEW_LABEL', () => {
  it('is Home', () => {
    expect(HOME_VIEW_LABEL).toBe('Home');
  });
});

describe('HOME_QUICK_ACCESS_ITEMS', () => {
  it('is an array', () => {
    expect(Array.isArray(HOME_QUICK_ACCESS_ITEMS)).toBe(true);
  });

  it('has required quick access items', () => {
    const actions = HOME_QUICK_ACCESS_ITEMS.map((item) => item.action);
    expect(actions).toContain('home');
    expect(actions).toContain('userhome');
    expect(actions).toContain('desktop');
    expect(actions).toContain('documents');
    expect(actions).toContain('downloads');
    expect(actions).toContain('music');
    expect(actions).toContain('videos');
    expect(actions).toContain('browse');
    expect(actions).toContain('trash');
  });

  it('has unique actions', () => {
    const actions = HOME_QUICK_ACCESS_ITEMS.map((item) => item.action);
    const uniqueActions = new Set(actions);
    expect(uniqueActions.size).toBe(actions.length);
  });

  it('has valid structure for each item', () => {
    HOME_QUICK_ACCESS_ITEMS.forEach((item) => {
      expect(typeof item.action).toBe('string');
      expect(item.action.length).toBeGreaterThan(0);
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.icon).toBe('number');
      expect(item.icon).toBeGreaterThan(0);
    });
  });

  it('has valid emoji codepoints', () => {
    HOME_QUICK_ACCESS_ITEMS.forEach((item) => {
      expect(item.icon).toBeGreaterThanOrEqual(0x1f000);
      expect(item.icon).toBeLessThanOrEqual(0x1ffff);
    });
  });
});

describe('isHomeViewPath', () => {
  it('returns true for HOME_VIEW_PATH', () => {
    expect(isHomeViewPath(HOME_VIEW_PATH)).toBe(true);
  });

  it('returns true for iyeris://home', () => {
    expect(isHomeViewPath('iyeris://home')).toBe(true);
  });

  it('returns false for regular paths', () => {
    expect(isHomeViewPath('/home/user')).toBe(false);
    expect(isHomeViewPath('C:\\Users')).toBe(false);
    expect(isHomeViewPath('/Users/test')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isHomeViewPath('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isHomeViewPath(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isHomeViewPath(undefined)).toBe(false);
  });

  it('returns false for similar but different paths', () => {
    expect(isHomeViewPath('iyeris://Home')).toBe(false);
    expect(isHomeViewPath('iyeris://home/')).toBe(false);
    expect(isHomeViewPath('IYERIS://home')).toBe(false);
  });
});

describe('getPathDisplayValue', () => {
  it('returns HOME_VIEW_LABEL for HOME_VIEW_PATH', () => {
    expect(getPathDisplayValue(HOME_VIEW_PATH)).toBe(HOME_VIEW_LABEL);
  });

  it('returns "Home" for iyeris://home', () => {
    expect(getPathDisplayValue('iyeris://home')).toBe('Home');
  });

  it('returns path unchanged for regular paths', () => {
    expect(getPathDisplayValue('/home/user')).toBe('/home/user');
    expect(getPathDisplayValue('C:\\Users\\Test')).toBe('C:\\Users\\Test');
    expect(getPathDisplayValue('/Users/test/Documents')).toBe('/Users/test/Documents');
  });

  it('returns empty string for empty input', () => {
    expect(getPathDisplayValue('')).toBe('');
  });

  it('preserves path separators', () => {
    expect(getPathDisplayValue('C:\\Users\\Test\\Docs')).toBe('C:\\Users\\Test\\Docs');
    expect(getPathDisplayValue('/var/log/app.log')).toBe('/var/log/app.log');
  });

  it('preserves special characters in paths', () => {
    expect(getPathDisplayValue('/path/with spaces/file.txt')).toBe('/path/with spaces/file.txt');
    expect(getPathDisplayValue('/path/with-dashes/file.txt')).toBe('/path/with-dashes/file.txt');
  });
});
