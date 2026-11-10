import { describe, expect, it, vi } from 'vitest';

// The plugin checks that a gallery-dl is installed before it spawns one.
// There is none in the test environment, so the check is stubbed out — the
// behaviour under test is the retry, not the installation probe.
vi.mock("../../plugins/instagram-sync/src/galleryDl.js", () => ({
  readInstalledVersion: vi.fn(async () => "1.32.19"),
  isVersionAtLeast: vi.fn(() => true),
  galleryDlPackageDir: vi.fn(() => "/tmp/work/gallery-dl/current")
}));

import {
  buildArgs,
  classifyError,
  interpretRun,
  isArchiveFault,
  isTimeoutFailure,
  runGalleryDl,
  type FetchOptions,
  type RawRun
} from '../../plugins/instagram-sync/src/fetcher.js';

/**
 * The download archive is a SQLite file on a volume shared with another host.
 * When that host holds the lock, gallery-dl's SQLite backend lets the
 * `OperationalError` escape and the whole extractor aborts.
 *
 * These tests pin the behaviour that keeps that from being fatal: the run is
 * repeated WITHOUT the archive, and the on-disk check still stops every
 * re-download.
 */

const ARCHIVE_LOCK_STDERR =
  "[error] An unexpected error occurred: OperationalError - database is locked. " +
  "Please run gallery-dl again with the --verbose flag, copy its output and report this issue  (×1)";

const CONFIG = {
  enabled: true,
  sourceUrl: "https://www.instagram.com/rodantes_6/saved/",
  abortAfterSkips: 30,
  abortAfterSkipsCollections: 10,
  abortAfterSkipsDeep: 3000,
  timeoutMinutes: 45,
  minGalleryDlVersion: "1.32.17",
  workDir: "/tmp/work",
  cookieFile: "/tmp/work/cookies.txt",
  archiveFile: "/tmp/work/archive.sqlite",
  galleryDlDir: "/tmp/work/gallery-dl"
};

function opts(overrides: Partial<FetchOptions> = {}): FetchOptions {
  return { config: CONFIG, galleryRoot: "/gallery", ...overrides };
}

describe('instagram-sync archive fault', () => {
  it('recognises the SQLite ledger faults', () => {
    expect(isArchiveFault(ARCHIVE_LOCK_STDERR)).toBe(true);
    expect(isArchiveFault("database table is locked")).toBe(true);
    expect(isArchiveFault("attempt to write a readonly database")).toBe(true);
    expect(isArchiveFault("Failed to open download archive at 'x.sqlite'")).toBe(true);
  });

  it('does not mistake an upstream fault for a ledger fault', () => {
    expect(isArchiveFault("login_required")).toBe(false);
    expect(isArchiveFault("401 Unauthorized")).toBe(false);
    expect(isArchiveFault("Connection refused")).toBe(false);
    expect(isArchiveFault("")).toBe(false);
  });

  it('gives the ledger fault its own status', () => {
    expect(classifyError(ARCHIVE_LOCK_STDERR)).toBe("archive-unavailable");
    // The pre-existing taxonomy is untouched.
    expect(classifyError("login_required")).toBe("session-expired");
    expect(classifyError("topsearch")).toBe("gallery-dl-too-old");
    expect(classifyError("something else")).toBe("error");
    expect(classifyError("")).toBe("error");
  });

  it('keeps the archive in the argv by default', () => {
    const args = buildArgs(opts());
    expect(args).toContain("--download-archive");
    expect(args[args.indexOf("--download-archive") + 1]).toBe(CONFIG.archiveFile);
  });

  it('drops the archive on request, but keeps every other flag', () => {
    const args = buildArgs(opts({ useArchive: false }));
    expect(args).not.toContain("--download-archive");
    expect(args).not.toContain(CONFIG.archiveFile);
    // The on-disk dedup and the abort budget are unaffected.
    expect(args[0]).toBe("--config-ignore");
    expect(args).toContain("--cookies");
    expect(args).toContain("-A");
    expect(args[args.length - 1]).toBe(CONFIG.sourceUrl);
  });

  it('reads a timeout from the killed child, not from a code that never comes', () => {
    // Node reports a timeout as code=null, killed=true, signal=SIGTERM.
    expect(isTimeoutFailure({ code: null, message: "x", killed: true, signal: "SIGTERM" })).toBe(true);
    expect(isTimeoutFailure({ code: "ETIMEDOUT", message: "x" })).toBe(true);
    expect(isTimeoutFailure({ code: 1, message: "x" })).toBe(false);
    expect(isTimeoutFailure(null)).toBe(false);
  });

  it('reports a timeout as a timeout', () => {
    const run: RawRun = {
      stdout: "",
      stderr: "",
      failure: { code: null, message: "Command failed", killed: true, signal: "SIGTERM" }
    };
    const result = interpretRun(run, 45, 1000);
    expect(result.status).toBe("error");
    expect(result.error).toContain("timed out after 45 minutes");
  });

  it('maps a locked ledger onto the archive status', () => {
    const run: RawRun = {
      stdout: "",
      stderr: ARCHIVE_LOCK_STDERR,
      failure: { code: 1, message: "Command failed" }
    };
    const result = interpretRun(run, 45, 1000);
    expect(result.status).toBe("archive-unavailable");
    expect(result.error).toContain("database is locked");
  });

  it('sees the locked ledger even when files were downloaded first', () => {
    // gallery-dl can download a few files before the archive locks. A partial
    // success must not mask the unusable ledger — otherwise the run is
    // reported as a plain failure and the retry never happens.
    const run: RawRun = {
      stdout: "/gallery/new/4023240071975078454.mp4\n# /gallery/old/4023240071975078455.mp4\n",
      stderr: ARCHIVE_LOCK_STDERR,
      failure: { code: 1, message: "Command failed" }
    };
    const result = interpretRun(run, 45, 1000);
    expect(result.status).toBe("archive-unavailable");
    expect(result.downloadedPaths).toEqual(["/gallery/new/4023240071975078454.mp4"]);
    expect(result.error).toContain("database is locked");
  });
});

describe('instagram-sync archive fallback', () => {
  it('retries without the archive and keeps what it downloaded', async () => {
    const calls: FetchOptions[] = [];
    const spawn = async (o: FetchOptions): Promise<RawRun> => {
      calls.push(o);
      if (o.useArchive === false) {
        // The second attempt works and produces the one new file.
        return {
          stdout: "/gallery/nukakitten/4023240071975078454.mp4\n# /gallery/older/4023240071975078455.mp4\n",
          stderr: "",
          failure: null
        };
      }
      return {
        stdout: "",
        stderr: ARCHIVE_LOCK_STDERR,
        failure: { code: 1, message: "Command failed" }
      };
    };

    const result = await runGalleryDl(opts({ spawn }));

    // Two attempts: the first with the archive, the second without it.
    expect(calls).toHaveLength(2);
    expect(calls[0].useArchive).toBeUndefined();
    expect(calls[1].useArchive).toBe(false);

    // The new file is still reported...
    expect(result.downloadedPaths).toEqual(["/gallery/nukakitten/4023240071975078454.mp4"]);
    // ...the old one is still skipped...
    expect(result.skippedCount).toBe(1);
    // ...and the run is degraded, not failed.
    expect(result.status).toBe("archive-unavailable");
    expect(result.error).toContain("database is locked");
  });

  it('does not retry a fault that is not the ledger', async () => {
    let calls = 0;
    const spawn = async (): Promise<RawRun> => {
      calls += 1;
      return {
        stdout: "",
        stderr: "login_required",
        failure: { code: 1, message: "Command failed" }
      };
    };

    const result = await runGalleryDl(opts({ spawn }));

    expect(calls).toBe(1);
    expect(result.status).toBe("session-expired");
  });

  it('reports the fault from the retry when the retry fails too', async () => {
    const spawn = async (o: FetchOptions): Promise<RawRun> => {
      if (o.useArchive === false) {
        return {
          stdout: "",
          stderr: "login_required",
          failure: { code: 1, message: "Command failed" }
        };
      }
      return {
        stdout: "",
        stderr: ARCHIVE_LOCK_STDERR,
        failure: { code: 1, message: "Command failed" }
      };
    };

    const result = await runGalleryDl(opts({ spawn }));

    expect(result.status).toBe("session-expired");
    expect(result.error).toContain("login_required");
  });

  it('keeps the files the first attempt downloaded', async () => {
    // The first attempt downloads a file and then hits the lock. The retry
    // skips it (it is on disk now), so without merging the two lists the file
    // would never reach the scanner and would stay invisible in the library.
    const spawn = async (o: FetchOptions): Promise<RawRun> => {
      if (o.useArchive === false) {
        return {
          stdout: "# /gallery/new/4023240071975078454.mp4\n",
          stderr: "",
          failure: null
        };
      }
      return {
        stdout: "/gallery/new/4023240071975078454.mp4\n",
        stderr: ARCHIVE_LOCK_STDERR,
        failure: { code: 1, message: "Command failed" }
      };
    };

    const result = await runGalleryDl(opts({ spawn }));

    expect(result.status).toBe("archive-unavailable");
    expect(result.downloadedPaths).toEqual(["/gallery/new/4023240071975078454.mp4"]);
  });
});
