/**
 * The poll scheduler.
 *
 * The plugin owns its own timer (the server has no cron library) and refreshes
 * on a fixed interval the user configures in the UI — see `pollConfig.ts`.
 *
 * A poll covers:
 *
 *   - the **general library**: gallery-dl pulls the saved-posts feed and the
 *     scanner indexes what came down (`performLibrarySync`);
 *   - the **saved collections**: Instagram's named sub-collections are
 *     mirrored into library collections of the same name.
 *
 * Guard rails:
 *  - no overlap: a poll in progress blocks the next tick, and a manual run
 *    does not start while a poll is running;
 *  - a tick is skipped while the scanner is busy, so a poll does not queue
 *    behind a large library scan;
 *  - the first tick is offset by a random amount so a fleet of servers does
 *    not stampede Instagram at the same minute.
 */

import type { PluginContext } from "../../../server/dist/plugins/types.js";
import { scannerService } from "../../../server/dist/services/scanner-service.js";

import type { InstagramSyncConfig } from "./config.js";
import { readCookieFile, validateCookie } from "./cookie.js";
import type { MirrorSelection } from "./collectionSelection.js";
import { getMirrorJob, isMirrorRunning, runMirrorJob } from "./collectionMirror.js";
import { runGalleryDl } from "./fetcher.js";
import { indexDownloaded, toRelativePaths } from "./indexer.js";
import { listCollectionMedia, listInstagramCollections } from "./instagramCollections.js";
import { pollCollectionSelection, type PollConfig } from "./pollConfig.js";
import { readPollConfig } from "./pollStore.js";
import {
  readDeepScanState,
  readLastRun,
  readPollRun,
  requestDeepScan,
  settleDeepScan,
  writeLastRun,
  writePollRun,
  type DeepScanState,
  type PollRunState,
  type SyncRunState
} from "./state.js";

const TICK_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let syncRunning = false;
let pollRunning = false;
let config: InstagramSyncConfig | null = null;
let log: PluginContext["log"] = (message) => console.log(`[instagram-sync] ${message}`);
let lastTickMinute: string | null = null;
let nextPollAt: Date | null = null;

/** Is anything running right now — a library sync or a whole poll? */
export function isRunning(): boolean {
  return syncRunning || pollRunning;
}

/** Is a library sync running right now? */
export function isSyncRunning(): boolean {
  return syncRunning;
}

/** The next time a poll is due, or null when the polling is off. */
export function nextScheduledRun(): Date | null {
  return nextPollAt;
}

/**
 * Did the run go wrong badly enough to want an intensive scan?
 *
 * A run that never reached Instagram (no cookie, an expired session) did
 * not: the problem there is the session, and walking further would not help.
 */
function isFault(status: string): boolean {
  return status !== "ok" && status !== "skipped" && status !== "session-expired";
}

/**
 * Run one library sync: validate the session, run gallery-dl, index whatever
 * came down, persist the outcome.
 *
 * Every exit writes the run state — a sync that throws is a failed sync, not
 * a missing record.
 */
async function performLibrarySync(galleryRoot: string): Promise<SyncRunState> {
  if (!config) {
    throw new Error("instagram-sync is not configured");
  }

  const startedAt = Date.now();

  try {
    const state = await runLibrarySync(config, galleryRoot, startedAt);
    await settleDeepScan(
      "library",
      isFault(state.status),
      `the last sync was "${state.status}"`
    );
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`sync error: ${message}`);
    const state: SyncRunState = {
      at: new Date().toISOString(),
      status: "error",
      downloaded: 0,
      skipped: 0,
      stoppedEarly: false,
      error: message.slice(0, 500),
      durationMs: Date.now() - startedAt
    };
    await writeLastRun(state);
    await settleDeepScan("library", true, "the last sync failed");
    return state;
  }
}

/** The body of a library sync — it throws, the caller records the failure. */
async function runLibrarySync(
  config: InstagramSyncConfig,
  galleryRoot: string,
  startedAt: number
): Promise<SyncRunState> {
  const cookieText = await readCookieFile(config.cookieFile);
  if (cookieText === null) {
    const error = "no cookie file — upload a fresh Instagram session cookie";
    log(`skipped: ${error}`);
    const state: SyncRunState = {
      at: new Date().toISOString(),
      status: "failed",
      downloaded: 0,
      skipped: 0,
      stoppedEarly: false,
      error,
      durationMs: Date.now() - startedAt
    };
    await writeLastRun(state);
    return state;
  }

  const validation = validateCookie(cookieText);
  if (!validation.ok) {
    const error = `cookie is not usable: ${validation.reason}`;
    log(`skipped: ${error}`);
    const state: SyncRunState = {
      at: new Date().toISOString(),
      status: "session-expired",
      downloaded: 0,
      skipped: 0,
      stoppedEarly: false,
      error,
      durationMs: Date.now() - startedAt
    };
    await writeLastRun(state);
    return state;
  }

  // An intensive scan walks much further down the list before it decides
  // that the queue is caught up. It is asked for when the last run did not
  // go well.
  const deepState = await readDeepScanState();
  const intensive = deepState.library;

  log(intensive ? "starting an intensive sync" : "starting sync");
  const result = await runGalleryDl({
    config,
    galleryRoot,
    abortAfterSkips: intensive ? config.abortAfterSkipsDeep : undefined,
    // An intensive scan goes **without** the ledger: the on-disk check is
    // then the only dedup, so a media the ledger claims but that is gone
    // from the library is fetched again. That is the case an ordinary run
    // cannot see.
    useArchive: intensive ? false : undefined
  });

  if (result.status === "archive-unavailable") {
    // The download archive could not be used — it is locked, or unreadable —
    // but the sync itself worked: gallery-dl's on-disk check still skipped
    // everything that was already in the gallery, so nothing was downloaded
    // twice. This is a degraded run, not a failure.
    log(`sync done without the download archive: ${result.error}`);
    const state: SyncRunState = {
      at: new Date().toISOString(),
      status: "archive-unavailable",
      downloaded: result.downloadedPaths.length,
      skipped: result.skippedCount,
      stoppedEarly: result.stoppedEarly,
      error: result.error,
      durationMs: result.durationMs
    };
    await writeLastRun(state);
    return state;
  }

  if (result.status !== "ok") {
    log(`sync failed: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
    const state: SyncRunState = {
      at: new Date().toISOString(),
      status: result.status === "session-expired" ? "session-expired" : "failed",
      downloaded: 0,
      skipped: result.skippedCount,
      stoppedEarly: result.stoppedEarly,
      error: result.error,
      durationMs: result.durationMs
    };
    await writeLastRun(state);
    return state;
  }

  const indexed = await indexDownloaded(galleryRoot, result.downloadedPaths);
  log(
    `sync done: downloaded=${result.downloadedPaths.length} indexed=${indexed.length} skipped=${result.skippedCount} in ${result.durationMs}ms`
  );

  const state: SyncRunState = {
    at: new Date().toISOString(),
    status: "ok",
    downloaded: result.downloadedPaths.length,
    downloadedPaths: result.downloadedPaths,
    skipped: result.skippedCount,
    stoppedEarly: result.stoppedEarly,
    error: null,
    durationMs: result.durationMs
  };
  await writeLastRun(state);
  return state;
}

/**
 * Refresh the general library on its own.
 *
 * This is what the "Run sync now" button does. A poll calls
 * `performLibrarySync` directly, because it already holds the poll lock.
 */
export async function runSyncNow(galleryRoot: string): Promise<SyncRunState> {
  if (!config) {
    throw new Error("instagram-sync is not configured");
  }
  if (syncRunning) {
    throw new Error("a sync is already running");
  }
  if (pollRunning) {
    throw new Error("a poll is already running");
  }

  syncRunning = true;
  try {
    return await performLibrarySync(galleryRoot);
  } finally {
    syncRunning = false;
  }
}

/**
 * Mirror the saved collections the poll covers.
 *
 * The mirror runs in the background and reports through `getMirrorJob()`; it
 * catches its own errors, so the failure comes back as the job's error.
 *
 * A manual mirror that is already running is left alone: the job keeps one
 * state, and two mirrors writing to it would report nonsense.
 */
async function performCollectionMirror(
  pollConfig: PollConfig,
  galleryRoot: string,
  /**
   * The media the general sync just downloaded.
   *
   * They are in the library and not yet in the collections, and the mirror
   * has to reach them: a collection is ordered by the date of the post, so
   * one that was posted long ago and saved yesterday sits deep in the list,
   * where the early-exit would never look.
   */
  downloadedPaths: string[] = [],
  onProgress?: (progress: {
    mirrored: number;
    total: number | null;
    current: string | null;
  }) => void
): Promise<{ ran: boolean; mirrored: number; missing: number; error: string | null }> {
  const pluginConfig = config;
  if (!pluginConfig) {
    throw new Error("instagram-sync is not configured");
  }

  if (isMirrorRunning()) {
    log("poll skipped the collections: a mirror is already running");
    return { ran: false, mirrored: 0, missing: 0, error: null };
  }

  const selection: MirrorSelection | null = pollCollectionSelection(pollConfig);

  // An intensive scan enumerates the whole collection instead of stopping as
  // soon as it has seen enough already-downloaded media. It is asked for when
  // the last mirror did not go well.
  const deepState = await readDeepScanState();
  const intensive = deepState.collections;

  // The mirror takes minutes. Reporting its progress keeps the poll's state
  // alive instead of leaving the UI on a stale record.
  const progressTimer = setInterval(() => {
    const job = getMirrorJob();
    onProgress?.({
      mirrored: job.results.length,
      total: job.totalCount,
      current: job.currentCollection
    });
  }, 10_000);

  try {
    // The media the general sync downloaded, relative to the gallery root —
    // the same shape the listing prints.
    const pendingPaths = new Set(
      toRelativePaths(galleryRoot, downloadedPaths)
    );

    await runMirrorJob(
      () => listInstagramCollections(pluginConfig),
      (collection, onProgress, knownPaths, collectionPending, listOptions) =>
        listCollectionMedia(pluginConfig, collection, onProgress, {
          // The enumeration stops when the collection is caught up — and
          // every media that had to be reached has been seen. An intensive
          // scan enumerates it whole.
          knownPaths,
          pendingPaths: collectionPending ?? pendingPaths,
          stopAfter:
            intensive || listOptions?.deep ? 0 : pluginConfig.abortAfterSkipsCollections,
          // The deep pass fetches what the library lacks.
          download: listOptions?.deep === true,
          galleryRoot
        }),
      galleryRoot,
      selection,
      pendingPaths,
      (result) =>
        log(
          `mirrored collection "${result.name}": ${result.addedCount}/${result.mediaCount} media, ${result.missingCount} missing` +
            (result.stoppedEarly ? " (stopped early)" : "")
        )
    );
  } finally {
    clearInterval(progressTimer);
  }

  const job = getMirrorJob();

  // A collection whose listing failed is a fault of the collections: the
  // next scan enumerates the whole thing.
  await settleDeepScan(
    "collections",
    job.error !== null,
    job.error ? `the mirror failed: ${job.error.slice(0, 120)}` : "the mirror failed"
  );

  return {
    ran: true,
    mirrored: job.results.length,
    missing: job.results.reduce((total, result) => total + result.missingCount, 0),
    error: job.error
  };
}

/**
 * Run one poll: refresh the general library and/or the saved collections,
 * whichever the configuration covers.
 */
export async function runPollNow(galleryRoot: string): Promise<PollRunState> {
  if (!config) {
    throw new Error("instagram-sync is not configured");
  }
  if (pollRunning) {
    throw new Error("a poll is already running");
  }

  const pollConfig = await readPollConfig();
  pollRunning = true;
  const startedAt = Date.now();

  let library = false;
  let collections = false;
  // What the library half downloaded in this poll.
  let downloadedPaths: string[] = [];
  let mirrored = 0;
  let error: string | null = null;
  let status: PollRunState["status"] = "ok";
  // Whether the library run stopped early — it walks only a part of the
  // list, so the library can be behind without anything being wrong.
  let libraryStoppedEarly = false;

  // The state is written UP FRONT. A poll takes minutes — the collections half
  // alone walks 42 collections — and a UI that only learns about it at the end
  // looks frozen for the whole time.
  await writePollRun({
    at: new Date().toISOString(),
    status: "running",
    library: false,
    collections: false,
    mirrored: 0,
    mirroredTotal: null,
    currentCollection: null,
    error: null,
    durationMs: null
  });

  try {
    if (pollConfig.library) {
      const result = await performLibrarySync(galleryRoot);
      library = true;
      libraryStoppedEarly = result.stoppedEarly === true;
      downloadedPaths = result.downloadedPaths ?? [];
      downloadedPaths = result.downloadedPaths ?? [];
      if (result.status === "archive-unavailable") {
        // Degraded, not failed: the library was refreshed and only the
        // optional ledger is missing. The poll keeps its "ok" status.
        error = error ?? result.error;
      } else if (result.status !== "ok") {
        error = result.error;
        status = result.status === "skipped" ? "skipped" : "failed";
      }

      // The library half is done; the collections half may take a while.
      await writePollRun({
        at: new Date().toISOString(),
        status: "running",
        library,
        collections: false,
        mirrored: 0,
        mirroredTotal: null,
        currentCollection: null,
        error,
        durationMs: null
      });
    }

    if (pollConfig.collections) {
      const selection = pollCollectionSelection(pollConfig);
      // "Only these collections" with nothing ticked mirrors nothing — that
      // is a configuration mistake, not a failure.
      if (selection && selection.ids.length === 0 && selection.names.length === 0) {
        log("poll skipped the collections: the selection is empty");
      } else {
        const mirror = await performCollectionMirror(pollConfig, galleryRoot, downloadedPaths, (progress) => {
          // Keep the state alive while the mirror works through the list.
          void writePollRun({
            at: new Date().toISOString(),
            status: "running",
            library,
            collections: false,
            mirrored: progress.mirrored,
            mirroredTotal: progress.total,
            currentCollection: progress.current,
            error,
            durationMs: null
          });
        });
        collections = mirror.ran;
        mirrored = mirror.mirrored;
        if (mirror.error) {
          error = error ?? mirror.error;
          status = "failed";
        }

        // Media that a collection holds but the library does not.
        //
        // While the library run stopped early this is normal: the library
        // walks only the newest part of the feed, so the collections can be
        // ahead of it. It only means something when the library says it is
        // caught up — then the ledger may be claiming media that are not
        // really in the library, and the next library scan looks further
        // (and without the ledger).
        if (mirror.missing > 0 && !libraryStoppedEarly) {
          await requestDeepScan(
            await readDeepScanState(),
            "library",
            `${mirror.missing} media are in a collection but not in the library`
          );
          log(
            `${mirror.missing} media are in a collection but not in the library — ` +
              `the next library scan will look further`
          );
        }
      }
    }

    if (!library && !collections) {
      status = "skipped";
    }
  } catch (pollError) {
    const message = pollError instanceof Error ? pollError.message : String(pollError);
    log(`poll error: ${message}`);
    error = error ?? message;
    status = "error";
  } finally {
    pollRunning = false;
  }

  const state: PollRunState = {
    at: new Date().toISOString(),
    status,
    library,
    collections,
    mirrored,
    mirroredTotal: null,
    currentCollection: null,
    error: error ? error.slice(0, 500) : null,
    durationMs: Date.now() - startedAt
  };
  await writePollRun(state);

  log(
    `poll done: status=${state.status} library=${state.library} collections=${state.collections} mirrored=${state.mirrored} in ${state.durationMs}ms`
  );

  return state;
}

/**
 * When the next poll is due.
 *
 * The schedule is anchored on the last poll, not on the boot time: a server
 * that restarts often must still poll. A poll that came due while the server
 * was down runs at the next tick.
 */
async function computeNextPollAt(pollConfig: PollConfig, now: number): Promise<Date> {
  const intervalMs = pollConfig.intervalMinutes * 60_000;
  const last = await readPollRun();

  if (last.at) {
    const due = new Date(new Date(last.at).getTime() + intervalMs);
    if (due.getTime() > now) return due;
    return new Date(now);
  }

  return new Date(now + intervalMs);
}

/** Recompute the next run after the configuration changed. */
export async function reschedule(): Promise<void> {
  const pollConfig = await readPollConfig();
  nextPollAt = pollConfig.enabled
    ? await computeNextPollAt(pollConfig, Date.now())
    : null;
}

async function tick(galleryRoot: string): Promise<void> {
  if (!config || !config.enabled) return;
  if (pollRunning || syncRunning) return;

  // Do not queue a poll behind a large library scan.
  if (scannerService.getProgress().isScanning) {
    return;
  }

  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastTickMinute) return;
  lastTickMinute = minuteKey;

  const pollConfig = await readPollConfig();
  if (!pollConfig.enabled) {
    nextPollAt = null;
    return;
  }

  if (!nextPollAt) {
    nextPollAt = await computeNextPollAt(pollConfig, now.getTime());
    return;
  }

  if (now.getTime() < nextPollAt.getTime()) return;

  try {
    // The next run is set from the poll's START, so the UI shows a sensible
    // future time for the whole (long) duration of the poll. It is
    // recomputed from the end once the poll is done.
    const pollConfigNow = await readPollConfig();
    nextPollAt = new Date(
      Date.now() + pollConfigNow.intervalMinutes * 60_000
    );
    await runPollNow(galleryRoot);
  } catch (error) {
    // `runPollNow` handles its own errors; this only catches the unexpected.
    log(`poll crashed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The configuration is read again: it may have changed during the poll.
  const updated = await readPollConfig();
  nextPollAt = await computeNextPollAt(updated, Date.now());
}

/**
 * Clear a poll state that claims to be running.
 *
 * The state is written when the poll starts and again when it finishes, so a
 * server that is restarted mid-poll leaves a "running" record behind — with
 * nothing running. The record is corrected on the next boot.
 */
async function reconcileInterruptedPoll(): Promise<void> {
  const state = await readPollRun();
  if (state.status !== "running") return;

  log("the previous poll was interrupted by a restart — marking it as failed");
  await writePollRun({
    ...state,
    status: "failed",
    error: "the poll was interrupted by a server restart",
    durationMs: state.durationMs
  });
}

export async function startScheduler(
  ctx: PluginContext,
  pluginConfig: InstagramSyncConfig,
  galleryRoot: string
): Promise<void> {
  config = pluginConfig;
  log = ctx.log;

  // A poll that was running when the server stopped never got to write its
  // outcome, so its state would claim "running" forever. The process that
  // owned it is gone — say so. This runs even when the plugin is disabled:
  // the stale record would outlive it.
  await reconcileInterruptedPoll();

  if (!config.enabled) {
    log("disabled via INSTAGRAM_SYNC_ENABLED=0");
    return;
  }

  clearInterval(timer);

  // Make sure the configuration exists before the first tick reads it.
  const pollConfig = await readPollConfig();
  nextPollAt = pollConfig.enabled
    ? await computeNextPollAt(pollConfig, Date.now())
    : null;

  // Offset the first tick so a fleet of servers does not hit Instagram at the
  // same minute.
  const offsetMs = Math.floor(Math.random() * TICK_INTERVAL_MS);
  setTimeout(() => {
    void tick(galleryRoot);
  }, offsetMs);

  timer = setInterval(() => {
    void tick(galleryRoot).catch((error: unknown) => {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, TICK_INTERVAL_MS);

  log(
    `scheduler started: every ${pollConfig.intervalMinutes} min, library=${pollConfig.library}, collections=${pollConfig.collections}, next=${nextPollAt ? nextPollAt.toISOString() : "never"}`
  );
}

export function stopScheduler(): void {
  clearInterval(timer);
  timer = undefined;
}

/** Current state, for the status route. */
export interface SchedulerState {
  running: boolean;
  nextRunAt: string | null;
  lastRun: SyncRunState;
  lastPoll: PollRunState;
}

export async function schedulerState(): Promise<SchedulerState> {
  return {
    running: isRunning(),
    nextRunAt: nextPollAt ? nextPollAt.toISOString() : null,
    lastRun: await readLastRun(),
    lastPoll: await readPollRun()
  };
}
