import { describe, expect, it } from 'vitest';

import {
  buildShareFileName,
  canShareFiles,
  getFileExtension,
  guessMimeTypeFromFilename,
  isShareableFileName,
  probeShareSupport,
  resolveShareMimeType,
  SHARE_MAX_BYTES,
  SHARE_PERMITTED_EXTENSIONS,
  SHARE_PERMITTED_MIME_TYPES
} from './share-media';

describe('share media helpers', () => {
  describe('getFileExtension', () => {
    it('reads the lower case extension', () => {
      expect(getFileExtension('photo.JPG')).toBe('jpg');
      expect(getFileExtension('clip.mp4')).toBe('mp4');
      expect(getFileExtension('archive.tar.gz')).toBe('gz');
    });

    it('returns nothing for a name without extension', () => {
      expect(getFileExtension('README')).toBe('');
      expect(getFileExtension('trailing.')).toBe('');
      expect(getFileExtension('.hidden')).toBe('');
    });
  });

  describe('isShareableFileName', () => {
    it('accepts a plain name with an allowed extension', () => {
      expect(isShareableFileName('photo.jpg')).toBe(true);
      expect(isShareableFileName('clip.mp4')).toBe(true);
      expect(isShareableFileName('animation.webp')).toBe(true);
    });

    it('rejects a name with a path or a traversal', () => {
      expect(isShareableFileName('album/photo.jpg')).toBe(false);
      expect(isShareableFileName('album\\photo.jpg')).toBe(false);
      expect(isShareableFileName('../photo.jpg')).toBe(false);
      expect(isShareableFileName('..')).toBe(false);
      expect(isShareableFileName('.')).toBe(false);
    });

    it('rejects a name with surrounding whitespace or a trailing dot', () => {
      expect(isShareableFileName(' photo.jpg')).toBe(false);
      expect(isShareableFileName('photo.jpg ')).toBe(false);
      expect(isShareableFileName('photo.jpg.')).toBe(false);
    });

    it('rejects an extension Chromium does not accept', () => {
      expect(isShareableFileName('clip.mov')).toBe(false);
      expect(isShareableFileName('clip.mkv')).toBe(false);
      expect(isShareableFileName('notes')).toBe(false);
    });
  });

  describe('buildShareFileName', () => {
    it('keeps a bare basename', () => {
      expect(buildShareFileName('photo.jpg')).toBe('photo.jpg');
    });

    it('drops the path of a name that carries one', () => {
      expect(buildShareFileName('album/photo.jpg')).toBe('photo.jpg');
      expect(buildShareFileName('album\\photo.jpg')).toBe('photo.jpg');
    });

    it('trims the whitespace and the trailing dots', () => {
      expect(buildShareFileName(' photo.jpg ')).toBe('photo.jpg');
      expect(buildShareFileName('photo.jpg.')).toBe('photo.jpg');
    });

    it('returns nothing when there is no name left', () => {
      expect(buildShareFileName('')).toBe('');
      expect(buildShareFileName('  ')).toBe('');
      expect(buildShareFileName('..')).toBe('');
    });
  });

  describe('the MIME type', () => {
    it('guesses the type from the name', () => {
      expect(guessMimeTypeFromFilename('photo.jpg')).toBe('image/jpeg');
      expect(guessMimeTypeFromFilename('clip.mp4')).toBe('video/mp4');
      expect(guessMimeTypeFromFilename('clip.webm')).toBe('video/webm');
      expect(guessMimeTypeFromFilename('notes.txt')).toBe('text/plain');
    });

    it('has no guess for a type Chromium does not accept', () => {
      expect(guessMimeTypeFromFilename('clip.mov')).toBe('');
      expect(guessMimeTypeFromFilename('clip.mkv')).toBe('');
    });

    it('prefers the type of the bytes when Chromium accepts it', () => {
      expect(resolveShareMimeType('clip.m4v', 'video/mp4')).toBe('video/mp4');
      expect(resolveShareMimeType('clip.m4v', 'video/x-m4v')).toBe('video/mp4');
    });

    it('falls back to the name when the type of the bytes is not accepted', () => {
      expect(resolveShareMimeType('photo.jpg', 'application/octet-stream')).toBe('image/jpeg');
      expect(resolveShareMimeType('clip.mov', 'video/quicktime')).toBe('');
    });
  });

  describe('the limits', () => {
    it('mirrors the 50 MiB cap of the browser', () => {
      expect(SHARE_MAX_BYTES).toBe(52_428_800);
    });

    it('lists the extensions and types Chromium accepts', () => {
      expect(SHARE_PERMITTED_EXTENSIONS.has('mp4')).toBe(true);
      expect(SHARE_PERMITTED_EXTENSIONS.has('mov')).toBe(false);
      expect(SHARE_PERMITTED_MIME_TYPES.has('video/mp4')).toBe(true);
      expect(SHARE_PERMITTED_MIME_TYPES.has('video/quicktime')).toBe(false);
    });
  });

  describe('canShareFiles', () => {
    it('is false without a secure context', () => {
      // jsdom reports a secure context, so the API has to be missing instead.
      expect(typeof navigator.share).not.toBe('function');
      expect(canShareFiles()).toBe(false);
    });
  });

  describe('probeShareSupport', () => {
    it('is false for a name that cannot be shared', () => {
      expect(probeShareSupport('video/quicktime', 'clip.mov')).toBe(false);
    });
  });
});
