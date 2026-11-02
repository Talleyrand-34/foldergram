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
import { classifyError, parseStdout } from '../../plugins/instagram-sync/src/fetcher.js';

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
    expect(
      classifyError(
        "HttpError: '404 Not Found' for 'https://www.instagram.com/web/search/topsearch/?query=x'"
      )
    ).toBe('gallery-dl-too-old');
    expect(classifyError('connection refused')).toBe('error');
  });
});
