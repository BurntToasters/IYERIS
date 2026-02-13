import { describe, it, expect } from 'vitest';
import {
  MAX_UNDO_STACK_SIZE,
  HIDDEN_FILE_CACHE_TTL,
  HIDDEN_FILE_CACHE_MAX,
  SETTINGS_CACHE_TTL_MS,
  ZOOM_MIN,
  ZOOM_MAX,
  MAX_TEXT_PREVIEW_BYTES,
  MAX_DATA_URL_BYTES,
} from '../appState';

describe('appState constants', () => {
  describe('MAX_UNDO_STACK_SIZE', () => {
    it('is a reasonable positive number', () => {
      expect(MAX_UNDO_STACK_SIZE).toBeGreaterThan(0);
      expect(MAX_UNDO_STACK_SIZE).toBeLessThanOrEqual(100);
    });

    it('is set to 50', () => {
      expect(MAX_UNDO_STACK_SIZE).toBe(50);
    });
  });

  describe('HIDDEN_FILE_CACHE_TTL', () => {
    it('is a reasonable cache duration', () => {
      expect(HIDDEN_FILE_CACHE_TTL).toBeGreaterThan(0);
      expect(HIDDEN_FILE_CACHE_TTL).toBe(300000);
    });

    it('is 5 minutes in milliseconds', () => {
      expect(HIDDEN_FILE_CACHE_TTL).toBe(5 * 60 * 1000);
    });
  });

  describe('HIDDEN_FILE_CACHE_MAX', () => {
    it('is a reasonable cache size', () => {
      expect(HIDDEN_FILE_CACHE_MAX).toBeGreaterThan(0);
      expect(HIDDEN_FILE_CACHE_MAX).toBe(5000);
    });
  });

  describe('SETTINGS_CACHE_TTL_MS', () => {
    it('is a reasonable cache duration', () => {
      expect(SETTINGS_CACHE_TTL_MS).toBeGreaterThan(0);
      expect(SETTINGS_CACHE_TTL_MS).toBe(30000);
    });

    it('is 30 seconds in milliseconds', () => {
      expect(SETTINGS_CACHE_TTL_MS).toBe(30 * 1000);
    });
  });

  describe('ZOOM_MIN and ZOOM_MAX', () => {
    it('ZOOM_MIN is less than ZOOM_MAX', () => {
      expect(ZOOM_MIN).toBeLessThan(ZOOM_MAX);
    });

    it('ZOOM_MIN is a valid zoom level', () => {
      expect(ZOOM_MIN).toBeGreaterThan(0);
      expect(ZOOM_MIN).toBeLessThanOrEqual(1);
    });

    it('ZOOM_MAX is a valid zoom level', () => {
      expect(ZOOM_MAX).toBeGreaterThanOrEqual(1);
      expect(ZOOM_MAX).toBeLessThanOrEqual(5);
    });

    it('has expected values', () => {
      expect(ZOOM_MIN).toBe(0.5);
      expect(ZOOM_MAX).toBe(2.0);
    });
  });

  describe('MAX_TEXT_PREVIEW_BYTES', () => {
    it('is 1MB', () => {
      expect(MAX_TEXT_PREVIEW_BYTES).toBe(1024 * 1024);
    });

    it('is a reasonable size for text preview', () => {
      expect(MAX_TEXT_PREVIEW_BYTES).toBeGreaterThan(0);
      expect(MAX_TEXT_PREVIEW_BYTES).toBeLessThanOrEqual(10 * 1024 * 1024);
    });
  });

  describe('MAX_DATA_URL_BYTES', () => {
    it('is 10MB', () => {
      expect(MAX_DATA_URL_BYTES).toBe(10 * 1024 * 1024);
    });

    it('is larger than MAX_TEXT_PREVIEW_BYTES', () => {
      expect(MAX_DATA_URL_BYTES).toBeGreaterThan(MAX_TEXT_PREVIEW_BYTES);
    });
  });
});
