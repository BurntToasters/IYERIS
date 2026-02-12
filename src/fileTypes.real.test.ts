import { describe, it, expect } from 'vitest';
import {
  FILE_ICON_MAP,
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  ANIMATED_IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_SUFFIXES,
  TEXT_EXTENSIONS,
  WORD_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SOURCE_CODE_EXTENSIONS,
  WEB_EXTENSIONS,
  VIDEO_MIME_TYPES,
  AUDIO_MIME_TYPES,
} from './fileTypes';

describe('FILE_ICON_MAP', () => {
  it('is a non-empty object', () => {
    expect(Object.keys(FILE_ICON_MAP).length).toBeGreaterThan(0);
  });

  it('maps common image extensions', () => {
    expect(FILE_ICON_MAP['jpg']).toBeDefined();
    expect(FILE_ICON_MAP['png']).toBeDefined();
    expect(FILE_ICON_MAP['gif']).toBeDefined();
  });

  it('maps common video extensions', () => {
    expect(FILE_ICON_MAP['mp4']).toBeDefined();
    expect(FILE_ICON_MAP['mov']).toBeDefined();
  });

  it('maps common audio extensions', () => {
    expect(FILE_ICON_MAP['mp3']).toBeDefined();
    expect(FILE_ICON_MAP['wav']).toBeDefined();
  });

  it('maps common archive extensions', () => {
    expect(FILE_ICON_MAP['zip']).toBeDefined();
    expect(FILE_ICON_MAP['rar']).toBeDefined();
  });

  it('maps common code extensions', () => {
    expect(FILE_ICON_MAP['js']).toBeDefined();
    expect(FILE_ICON_MAP['ts']).toBeDefined();
    expect(FILE_ICON_MAP['py']).toBeDefined();
  });

  it('all values are non-empty strings (emoji codepoints)', () => {
    for (const [, codepoint] of Object.entries(FILE_ICON_MAP)) {
      expect(typeof codepoint).toBe('string');
      expect(codepoint.length).toBeGreaterThan(0);
    }
  });
});

describe('extension sets', () => {
  describe('IMAGE_EXTENSIONS', () => {
    it('contains common image formats', () => {
      for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) {
        expect(IMAGE_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('does not contain video formats', () => {
      expect(IMAGE_EXTENSIONS.has('mp4')).toBe(false);
      expect(IMAGE_EXTENSIONS.has('avi')).toBe(false);
    });
  });

  describe('RAW_EXTENSIONS', () => {
    it('contains common RAW camera formats', () => {
      for (const ext of ['cr2', 'cr3', 'nef', 'arw', 'dng']) {
        expect(RAW_EXTENSIONS.has(ext)).toBe(true);
      }
    });
  });

  describe('ANIMATED_IMAGE_EXTENSIONS', () => {
    it('contains gif and webp', () => {
      expect(ANIMATED_IMAGE_EXTENSIONS.has('gif')).toBe(true);
      expect(ANIMATED_IMAGE_EXTENSIONS.has('webp')).toBe(true);
    });

    it('is a subset of IMAGE_EXTENSIONS except apng/avif', () => {
      for (const ext of ANIMATED_IMAGE_EXTENSIONS) {
        expect(IMAGE_EXTENSIONS.has(ext) || ext === 'avif').toBe(true);
      }
    });
  });

  describe('VIDEO_EXTENSIONS', () => {
    it('contains common video formats', () => {
      for (const ext of ['mp4', 'mov', 'mkv', 'avi', 'webm']) {
        expect(VIDEO_EXTENSIONS.has(ext)).toBe(true);
      }
    });
  });

  describe('AUDIO_EXTENSIONS', () => {
    it('contains common audio formats', () => {
      for (const ext of ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a']) {
        expect(AUDIO_EXTENSIONS.has(ext)).toBe(true);
      }
    });
  });

  describe('PDF_EXTENSIONS', () => {
    it('contains pdf', () => {
      expect(PDF_EXTENSIONS.has('pdf')).toBe(true);
    });

    it('has exactly one entry', () => {
      expect(PDF_EXTENSIONS.size).toBe(1);
    });
  });

  describe('ARCHIVE_EXTENSIONS', () => {
    it('contains common archive formats', () => {
      for (const ext of ['zip', '7z', 'rar', 'tar', 'gz']) {
        expect(ARCHIVE_EXTENSIONS.has(ext)).toBe(true);
      }
    });
  });

  describe('ARCHIVE_SUFFIXES', () => {
    it('all start with a dot', () => {
      for (const suffix of ARCHIVE_SUFFIXES) {
        expect(suffix.startsWith('.')).toBe(true);
      }
    });

    it('includes compound suffix .tar.gz', () => {
      expect(ARCHIVE_SUFFIXES).toContain('.tar.gz');
    });
  });

  describe('TEXT_EXTENSIONS', () => {
    it('contains common text/code formats', () => {
      for (const ext of ['txt', 'md', 'html', 'css', 'js', 'ts', 'json', 'py']) {
        expect(TEXT_EXTENSIONS.has(ext)).toBe(true);
      }
    });
  });

  describe('SOURCE_CODE_EXTENSIONS', () => {
    it('is a subset of TEXT_EXTENSIONS', () => {
      for (const ext of SOURCE_CODE_EXTENSIONS) {
        expect(TEXT_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('does not contain non-code text files', () => {
      expect(SOURCE_CODE_EXTENSIONS.has('txt')).toBe(false);
      expect(SOURCE_CODE_EXTENSIONS.has('md')).toBe(false);
    });
  });

  describe('WEB_EXTENSIONS', () => {
    it('contains html and css', () => {
      expect(WEB_EXTENSIONS.has('html')).toBe(true);
      expect(WEB_EXTENSIONS.has('css')).toBe(true);
    });
  });

  describe('WORD_EXTENSIONS', () => {
    it('contains doc and docx', () => {
      expect(WORD_EXTENSIONS.has('doc')).toBe(true);
      expect(WORD_EXTENSIONS.has('docx')).toBe(true);
    });
  });

  describe('SPREADSHEET_EXTENSIONS', () => {
    it('contains xls and xlsx', () => {
      expect(SPREADSHEET_EXTENSIONS.has('xls')).toBe(true);
      expect(SPREADSHEET_EXTENSIONS.has('xlsx')).toBe(true);
    });
  });

  describe('PRESENTATION_EXTENSIONS', () => {
    it('contains ppt and pptx', () => {
      expect(PRESENTATION_EXTENSIONS.has('ppt')).toBe(true);
      expect(PRESENTATION_EXTENSIONS.has('pptx')).toBe(true);
    });
  });

  describe('no overlap between primary media categories', () => {
    it('IMAGE and VIDEO do not overlap', () => {
      for (const ext of IMAGE_EXTENSIONS) {
        expect(VIDEO_EXTENSIONS.has(ext)).toBe(false);
      }
    });

    it('IMAGE and AUDIO do not overlap', () => {
      for (const ext of IMAGE_EXTENSIONS) {
        expect(AUDIO_EXTENSIONS.has(ext)).toBe(false);
      }
    });

    it('VIDEO and AUDIO do not overlap', () => {
      for (const ext of VIDEO_EXTENSIONS) {
        expect(AUDIO_EXTENSIONS.has(ext)).toBe(false);
      }
    });

    it('ARCHIVE and TEXT do not overlap', () => {
      for (const ext of ARCHIVE_EXTENSIONS) {
        expect(TEXT_EXTENSIONS.has(ext)).toBe(false);
      }
    });
  });
});

describe('MIME type maps', () => {
  describe('VIDEO_MIME_TYPES', () => {
    it('maps all VIDEO_EXTENSIONS entries', () => {
      for (const ext of VIDEO_EXTENSIONS) {
        expect(VIDEO_MIME_TYPES[ext]).toBeDefined();
      }
    });

    it('values start with video/', () => {
      for (const mime of Object.values(VIDEO_MIME_TYPES)) {
        expect(mime.startsWith('video/')).toBe(true);
      }
    });
  });

  describe('AUDIO_MIME_TYPES', () => {
    it('maps all AUDIO_EXTENSIONS entries', () => {
      for (const ext of AUDIO_EXTENSIONS) {
        expect(AUDIO_MIME_TYPES[ext]).toBeDefined();
      }
    });

    it('values start with audio/', () => {
      for (const mime of Object.values(AUDIO_MIME_TYPES)) {
        expect(mime.startsWith('audio/')).toBe(true);
      }
    });
  });
});
