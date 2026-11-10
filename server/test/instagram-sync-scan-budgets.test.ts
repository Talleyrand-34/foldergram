import { describe, expect, it } from 'vitest';

import {
  buildArgs,
  interpretRun,
  parseStdout,
  stoppedEarly,
  type FetchOptions
} from '../../plugins/instagram-sync/src/fetcher.js';
import type { InstagramSyncConfig } from '../../plugins/instagram-sync/src/config.js';

const CONFIG: InstagramSyncConfig = {
  enabled: true,
  sourceUrl: 'https://www.instagram.com/rodantes_6/saved/',
  abortAfterSkips: 30,
  abortAfterSkipsCollections: 10,
  abortAfterSkipsDeep: 3000,
  timeoutMinutes: 45,
  minGalleryDlVersion: '1.32.17',
  workDir: '/tmp/work',
  cookieFile: '/tmp/work/cookies.txt',
  archiveFile: '/tmp/work/archive.sqlite',
  galleryDlDir: '/tmp/work/gallery-dl'
};

function options(overrides: Partial<FetchOptions> = {}): FetchOptions {
  return {
    config: CONFIG,
    galleryRoot: '/gallery',
    ...overrides
  };
}

describe('instagram-sync the early-exit budget', () => {
  it('gives the feed the small budget', () => {
    const args = buildArgs(options());
    expect(args).toContain('-A');
    expect(args[args.indexOf('-A') + 1]).toBe('30');
  });

  it('takes an override', () => {
    const args = buildArgs(options({ abortAfterSkips: 3000 }));
    expect(args[args.indexOf('-A') + 1]).toBe('3000');
  });

  it('leaves the early-exit out when the budget is zero', () => {
    // Zero means "no budget": the extractor walks the whole source.
    const args = buildArgs(options({ abortAfterSkips: 0 }));
    expect(args).not.toContain('-A');
    // The source is still the last argument.
    expect(args[args.length - 1]).toBe(CONFIG.sourceUrl);
  });

  it('keeps the ledger optional', () => {
    expect(buildArgs(options())).toContain('--download-archive');
    expect(buildArgs(options({ useArchive: false }))).not.toContain('--download-archive');
  });
});

describe('instagram-sync the false finished', () => {
  it('knows when the extractor stopped early', () => {
    // gallery-dl swallows the abort and exits 0, so the output is the only
    // evidence: the run of skips in a row reached the budget.
    const stdout = [
      '# /gallery/a/1.jpg',
      '# /gallery/a/2.jpg',
      '# /gallery/a/3.jpg',
      '# /gallery/a/4.jpg'
    ].join('\n');

    const result = interpretRun({ stdout, stderr: '', failure: null }, 45, 100, 4);
    expect(result.status).toBe('ok');
    expect(result.stoppedEarly).toBe(true);
  });

  it('does not claim an early exit when the run was short', () => {
    const stdout = [
      '# /gallery/a/1.jpg',
      '# /gallery/a/2.jpg',
      '/gallery/a/3.jpg',
      '# /gallery/a/4.jpg'
    ].join('\n');

    const result = interpretRun({ stdout, stderr: '', failure: null }, 45, 100, 4);
    expect(result.stoppedEarly).toBe(false);
  });

  it('counts a run of skips only while it is unbroken', () => {
    const stdout = [
      '# /gallery/a/1.jpg',
      '# /gallery/a/2.jpg',
      '/gallery/a/3.jpg',
      '# /gallery/a/4.jpg'
    ].join('\n');

    expect(parseStdout(stdout).longestSkipRun).toBe(2);
  });

  it('never claims an early exit without a budget', () => {
    // No budget means no early exit, whatever the output looks like.
    expect(stoppedEarly(500, 0)).toBe(false);
  });
});
