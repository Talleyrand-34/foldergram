import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseCookieFile,
  validateCookie,
  writeCookieFile
} from '../../plugins/instagram-sync/src/cookie.js';
import {
  compareVersions,
  isVersionAtLeast,
  readInstalledVersion
} from '../../plugins/instagram-sync/src/galleryDl.js';
import { installExtractedPackage } from '../../plugins/instagram-sync/src/galleryDlUpdater.js';
import {
  buildArgs,
  classifyError,
  parseStdout,
  statusForSuccessfulRun,
  summariseFailures
} from '../../plugins/instagram-sync/src/fetcher.js';

const VALID_COOKIE = [
  '# Netscape HTTP Cookie File',
  '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc123',
  '.instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tdef456',
  ''
].join('\n');

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-sync-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('instagram-sync cookie parsing', () => {
  it('parses name/value pairs and ignores comments', () => {
    const cookies = parseCookieFile(VALID_COOKIE);
    expect(cookies.get('sessionid')).toBe('abc123');
    expect(cookies.get('csrftoken')).toBe('def456');
    expect(cookies.size).toBe(2);
  });

  it('accepts a cookie file with an instagram sessionid', () => {
    expect(validateCookie(VALID_COOKIE)).toEqual({ ok: true, reason: null });
  });

  it('rejects an empty file', () => {
    expect(validateCookie('').ok).toBe(false);
  });

  it('rejects a file without a sessionid', () => {
    const noSession = '.instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tdef456\n';
    const result = validateCookie(noSession);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sessionid');
  });

  it('rejects a sessionid scoped to another domain', () => {
    const wrongDomain = '.example.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc123\n';
    const result = validateCookie(wrongDomain);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('.instagram.com');
  });

  it('writes the cookie file with mode 0600', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'cookies.txt');

    await writeCookieFile(target, VALID_COOKIE);

    const stats = await fs.stat(target);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(target, 'utf8')).toBe(VALID_COOKIE);
  });
});

describe('instagram-sync gallery-dl version handling', () => {
  it('compares versions numerically, not lexically', () => {
    expect(compareVersions('1.32.19', '1.32.17')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.32', '1.32.0')).toBe(0);
  });

  it('enforces the minimum version floor', () => {
    expect(isVersionAtLeast('1.32.19', '1.32.17')).toBe(true);
    expect(isVersionAtLeast('1.32.17', '1.32.17')).toBe(true);
    expect(isVersionAtLeast('1.32.16', '1.32.17')).toBe(false);
    expect(isVersionAtLeast('1.31.10', '1.32.17')).toBe(false);
  });

  it('reads the version from the installed package', async () => {
    const dir = await makeTempDir();
    const versionDir = path.join(dir, 'versions', '1.32.19', 'gallery_dl');
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, 'version.py'),
      '# comment\n__version__ = "1.32.19"\n'
    );
    // The active install is the `current` symlink; that is what PYTHONPATH points at.
    await fs.symlink(path.join('versions', '1.32.19'), path.join(dir, 'current'));

    expect(await readInstalledVersion(dir)).toBe('1.32.19');
  });

  it('returns null when gallery-dl is not installed', async () => {
    const dir = await makeTempDir();
    expect(await readInstalledVersion(dir)).toBeNull();
  });

  it('keeps the package inside the version directory', async () => {
    // The version directory must CONTAIN gallery_dl/, because PYTHONPATH points
    // at the version directory and Python looks for <versionDir>/gallery_dl/.
    // Renaming the package onto the version directory itself puts it one level
    // too high and breaks the import.
    const dir = await makeTempDir();
    const scratchDir = path.join(dir, 'scratch');
    const versionDir = path.join(dir, 'versions', '1.32.19');
    await fs.mkdir(path.join(scratchDir, 'gallery_dl'), { recursive: true });
    await fs.writeFile(
      path.join(scratchDir, 'gallery_dl', '__init__.py'),
      'from .version import __version__\n'
    );
    await fs.writeFile(
      path.join(scratchDir, 'gallery_dl', 'version.py'),
      '__version__ = "1.32.19"\n'
    );

    await installExtractedPackage(scratchDir, versionDir);

    // The package lives at <versionDir>/gallery_dl/, not <versionDir>/.
    expect(
      await fs
        .access(path.join(versionDir, 'gallery_dl', '__init__.py'))
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
    expect(
      await fs
        .access(path.join(versionDir, '__init__.py'))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);

    // …and that is exactly where PYTHONPATH expects to find it.
    await fs.symlink(path.join('versions', '1.32.19'), path.join(dir, 'current'));
    expect(await readInstalledVersion(dir)).toBe('1.32.19');
  });

  it('refuses an extraction with no gallery_dl package', async () => {
    const dir = await makeTempDir();
    const scratchDir = path.join(dir, 'scratch');
    await fs.mkdir(scratchDir, { recursive: true });

    await expect(
      installExtractedPackage(scratchDir, path.join(dir, 'versions', '1.32.19'))
    ).rejects.toThrow(/no gallery_dl package/);
  });
});

describe('instagram-sync gallery-dl output parsing', () => {
  it('separates skipped files from downloaded files', () => {
    const stdout = [
      '/gallery/nukakitten/4019457935986192455_4019455834615801231.jpg',
      '# /gallery/nukakitten/3915804836698077238.mp4',
      '',
      '/gallery/nukakitten/4023240071975078454.mp4'
    ].join('\n');

    const { downloaded, skipped } = parseStdout(stdout);
    expect(skipped).toBe(1);
    expect(downloaded).toEqual([
      '/gallery/nukakitten/4019457935986192455_4019455834615801231.jpg',
      '/gallery/nukakitten/4023240071975078454.mp4'
    ]);
  });

  it('handles empty output', () => {
    expect(parseStdout('')).toEqual({ downloaded: [], skipped: 0 });
  });

  it('classifies upstream faults', () => {
    expect(classifyError('chat 401: invalid api key')).toBe('session-expired');
    expect(classifyError('login_required')).toBe('session-expired');
    expect(classifyError('401 Unauthorized')).toBe('session-expired');
    expect(
      classifyError(
        "HttpError: '404 Not Found' for 'https://www.instagram.com/web/search/topsearch/?query=x'"
      )
    ).toBe('gallery-dl-too-old');
    expect(classifyError('connection refused')).toBe('error');
  });

  it('reports a run where everything was already downloaded as a success', () => {
    // The steady state: gallery-dl exits 0, every file is skipped, nothing
    // is downloaded and stderr is empty. This must NOT be a failure.
    const stdout = [
      '# /gallery/nukakitten/3915804836698077238.mp4',
      '# /gallery/nukakitten/3923240071975078454.mp4'
    ].join('\n');

    const outcome = statusForSuccessfulRun(stdout, '');
    expect(outcome.status).toBe('ok');
    expect(outcome.downloaded).toEqual([]);
    expect(outcome.skipped).toBe(2);
    expect(outcome.error).toBeNull();
  });

  it('reports a run with per-file failures as a failure', () => {
    const stdout = '# /gallery/x.mp4';
    const stderr = '[download][error] Failed to download 4020414111166403703.mp4';

    const outcome = statusForSuccessfulRun(stdout, stderr);
    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('Failed to download');
  });

  it('summarises per-file failures so a partial run is not reported as success', () => {
    const stderr = [
      '[download][error] Failed to download 4020414111166403703.mp4',
      '[download][warning] PermissionError: [Errno 13] Permission denied: \'/gallery/x.mp4.part\'',
      '[download][error] Failed to download 4020921959343528519.mp4',
      '[download][info] Trying fallback URL #1'
    ].join('\n');

    const summary = summariseFailures(stderr);
    expect(summary).toContain('Failed to download');
    // The two "Failed to download" lines normalise to the same reason.
    expect(summary).toContain('×2');
    // A permission failure counts even though it is logged as a warning.
    expect(summary).toContain('PermissionError');
    // Non-failure lines are not counted.
    expect(summary).not.toContain('Trying fallback');
    expect(summariseFailures('')).toBeNull();
    expect(summariseFailures('[download][info] all good')).toBeNull();
    // gallery-dl's "cannot import yt-dlp" is a fallback notice, not a failure.
    expect(
      summariseFailures('[downloader.ytdl][error] Cannot import yt-dlp or youtube-dl')
    ).toBeNull();
  });

  it('builds a gallery-dl argv with no duplicated module flags', () => {
    // `python3 -m gallery_dl` is added by the spawn, so buildArgs must not
    // repeat it — gallery-dl rejects the duplicate with
    // "unrecognized arguments: -m ...".
    const args = buildArgs({
      config: {
        enabled: true,
        cron: '17 */6 * * *',
        sourceUrl: 'https://www.instagram.com/rodantes_6/saved/',
        abortAfterSkips: 300,
        timeoutMinutes: 45,
        minGalleryDlVersion: '1.32.17',
        workDir: '/tmp/work',
        cookieFile: '/tmp/work/cookies.txt',
        archiveFile: '/tmp/work/archive.sqlite',
        galleryDlDir: '/tmp/work/gallery-dl'
      },
      galleryRoot: '/gallery'
    });

    expect(args.filter((arg) => arg === '-m')).toHaveLength(0);
    expect(args).not.toContain('gallery_dl');
    expect(args[0]).toBe('--config-ignore');
    expect(args).toContain('-A');
    expect(args).toContain('300');
    expect(args[args.length - 1]).toBe('https://www.instagram.com/rodantes_6/saved/');
    // The directory template must be a single argv element.
    expect(args).toContain('extractor.instagram.directory=["{username}"]');
  });
});
