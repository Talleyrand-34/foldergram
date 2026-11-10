import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A locked download archive must not turn a poll into a failure.
 *
 * The library half degrades — it runs without the ledger — and the poll keeps
 * its "ok" status, because the sync itself worked. Only the warning is kept.
 */

const { writeLastRun, writePollRun, readPollRun } = vi.hoisted(() => ({
  writeLastRun: vi.fn(async () => {}),
  writePollRun: vi.fn(async () => {}),
  readPollRun: vi.fn(async () => ({
    at: null,
    status: "skipped",
    library: false,
    collections: false,
    mirrored: 0,
    mirroredTotal: null,
    currentCollection: null,
    error: null,
    durationMs: null
  }))
}));

vi.mock("../../plugins/instagram-sync/src/fetcher.js", () => ({
  runGalleryDl: vi.fn(async () => ({
    status: "archive-unavailable",
    downloadedPaths: ["/gallery/new/4023240071975078454.mp4"],
    skippedCount: 300,
    error: "database is locked",
    durationMs: 100
  }))
}));

vi.mock("../../plugins/instagram-sync/src/collectionMirror.js", () => ({
  runMirrorJob: vi.fn(async () => {}),
  isMirrorRunning: vi.fn(() => false),
  getMirrorJob: vi.fn(() => ({
    running: false,
    results: Array.from({ length: 42 }, (_, index) => ({
      name: `c${index}`,
      missingCount: 0
    })),
    error: null
  }))
}));

vi.mock("../../plugins/instagram-sync/src/cookie.js", () => ({
  readCookieFile: vi.fn(async () => "# Netscape HTTP Cookie File\n"),
  validateCookie: vi.fn(() => ({ ok: true }))
}));

vi.mock("../../plugins/instagram-sync/src/state.js", () => ({
  writeLastRun,
  writePollRun,
  readLastRun: vi.fn(async () => ({
    at: null,
    status: "skipped",
    downloaded: 0,
    skipped: 0,
    stoppedEarly: false,
    error: null,
    durationMs: null
  })),
  readPollRun,
  readDeepScanState: vi.fn(async () => ({
    library: false,
    collections: false,
    reason: null,
    requestedAt: null,
    libraryFaulted: false,
    collectionsFaulted: false
  })),
  writeDeepScanState: vi.fn(async () => {}),
  requestDeepScan: vi.fn(async (state: unknown) => state),
  clearDeepScan: vi.fn(async (state: unknown) => state),
  settleDeepScan: vi.fn(async (state: unknown) => state)
}));

vi.mock("../../plugins/instagram-sync/src/pollStore.js", () => ({
  readPollConfig: vi.fn(async () => ({
    enabled: true,
    intervalMinutes: 240,
    library: true,
    collections: true,
    collectionMode: "all",
    collectionIds: [],
    collectionNames: []
  }))
}));

// The scanner pulls in the whole database layer; the poll never needs it.
// The path has to resolve to the same file the plugin imports
// (`<repo>/server/dist/services/scanner-service.js`), otherwise the mock is
// registered for a path that does not exist and the real scanner - with its
// real scan - is used.
vi.mock("../dist/services/scanner-service.js", () => ({
  scannerService: { getProgress: () => ({ isScanning: false }) }
}));

const CONFIG = {
  enabled: false,
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

describe('instagram-sync poll with a locked archive', () => {
  beforeEach(() => {
    writeLastRun.mockClear();
    writePollRun.mockClear();
  });

  it('reports the poll as ok and keeps the warning', async () => {
    const { runPollNow, startScheduler } = await import(
      "../../plugins/instagram-sync/src/scheduler.js"
    );

    // `enabled: false` sets the module's config and returns before arming a
    // timer, so the test cannot leak a tick.
    startScheduler(
      { log: () => {} } as never,
      CONFIG,
      "/gallery"
    );

    const state = await runPollNow("/gallery");

    // The poll worked: the library was refreshed and all 42 collections were
    // mirrored.
    expect(state.status).toBe("ok");
    expect(state.library).toBe(true);
    expect(state.collections).toBe(true);
    expect(state.mirrored).toBe(42);

    // The warning is kept, so the operator still sees what happened.
    expect(state.error).toContain("database is locked");
  });

  it('records the library run as degraded, not failed', async () => {
    const { runPollNow, startScheduler } = await import(
      "../../plugins/instagram-sync/src/scheduler.js"
    );
    startScheduler({ log: () => {} } as never, CONFIG, "/gallery");

    await runPollNow("/gallery");

    expect(writeLastRun).toHaveBeenCalledTimes(1);
    const lastRun = writeLastRun.mock.calls[0][0] as {
      status: string;
      downloaded: number;
      skipped: number;
    };
    expect(lastRun.status).toBe("archive-unavailable");
    expect(lastRun.downloaded).toBe(1);
    expect(lastRun.skipped).toBe(300);
  });

  it('records the poll itself as ok', async () => {
    const { runPollNow, startScheduler } = await import(
      "../../plugins/instagram-sync/src/scheduler.js"
    );
    startScheduler({ log: () => {} } as never, CONFIG, "/gallery");

    await runPollNow("/gallery");

    // The state is written when the poll starts, while it works, and when it
    // finishes. The LAST write is the outcome.
    expect(writePollRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    const pollRun = writePollRun.mock.calls[writePollRun.mock.calls.length - 1][0] as {
      status: string;
      mirrored: number;
      library: boolean;
      collections: boolean;
    };
    expect(pollRun.status).toBe("ok");
    expect(pollRun.mirrored).toBe(42);
    expect(pollRun.library).toBe(true);
    expect(pollRun.collections).toBe(true);
  });

  it('marks the poll as running while it works', async () => {
    const { runPollNow, startScheduler } = await import(
      "../../plugins/instagram-sync/src/scheduler.js"
    );
    startScheduler({ log: () => {} } as never, CONFIG, "/gallery");

    await runPollNow("/gallery");

    // The FIRST write says the poll is happening now, so the UI is never
    // left showing a stale record.
    const first = writePollRun.mock.calls[0][0] as { status: string; at: string | null };
    expect(first.status).toBe("running");
    expect(first.at).not.toBeNull();
  });

  it('clears a poll that a restart interrupted', async () => {
    // The state says "running", but nothing is running: the process that
    // owned it was killed. Leaving it would show "polling now" forever.
    readPollRun.mockResolvedValueOnce({
      at: "2026-11-08T19:07:24.816Z",
      status: "running",
      library: true,
      collections: false,
      mirrored: 3,
      mirroredTotal: 42,
      currentCollection: "book",
      error: null,
      durationMs: null
    });

    const { startScheduler } = await import(
      "../../plugins/instagram-sync/src/scheduler.js"
    );
    startScheduler({ log: () => {} } as never, CONFIG, "/gallery");

    // The scheduler starts the poll asynchronously; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const written = writePollRun.mock.calls
      .map((call) => call[0] as { status: string; error: string | null })
      .filter((entry) => entry.status === "failed");
    expect(written.length).toBeGreaterThan(0);
    expect(written[0].error).toContain("restart");
  });
});
