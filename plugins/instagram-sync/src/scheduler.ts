/**
 * The internal cron.
 *
 * The server has no cron library and adding one for a single plugin is not
 * worth the dependency, so the plugin owns its own timer with a minimal
 * 5-field matcher (`cron.ts`).
 *
 * Guard rails:
 *  - no overlap: a run in progress blocks the next tick;
 *  - skip the tick when the scanner is already busy, so a sync does not queue
 *    behind a large library scan;
 *  - the first tick is offset by a random amount so a fleet of servers does
 *    not stampede Instagram at the same minute.
 */

import type { PluginContext } from "../../../server/dist/plugins/types.js";
import { scannerService } from "../../../server/dist/services/scanner-service.js";

import { matchesCron, nextRun } from "./cron.js";
import type { InstagramSyncConfig } from "./config.js";
import { readCookieFile, validateCookie } from "./cookie.js";
import { runGalleryDl } from "./fetcher.js";
import { indexDownloaded } from "./indexer.js";
import { readLastRun, writeLastRun, type SyncRunState } from "./state.js";

const TICK_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let config: InstagramSyncConfig | null = null;
let log: PluginContext["log"] = (message) => console.log(`[instagram-sync] ${message}`);
let lastTickMinute: string | null = null;

export function isRunning(): boolean {
  return running;
}

/** The next time the cron expression fires, or null when the plugin is off. */
export function nextScheduledRun(): Date | null {
  if (!config || !config.enabled) return null;
  return nextRun(config.cron, new Date());
}

/**
 * Run one sync cycle: validate the session, run gallery-dl, index whatever
 * came down, persist the outcome.
 */
export async function runSyncNow(galleryRoot: string): Promise<void> {
  if (!config) {
    throw new Error("instagram-sync is not configured");
  }
  if (running) {
    throw new Error("a sync is already running");
  }

  running = true;
  const startedAt = Date.now();

  try {
    const cookieText = await readCookieFile(config.cookieFile);
    if (cookieText === null) {
      const error = "no cookie file — upload a fresh Instagram session cookie";
      log(`skipped: ${error}`);
      await writeLastRun({
        at: new Date().toISOString(),
        status: "failed",
        downloaded: 0,
        skipped: 0,
        error,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    const validation = validateCookie(cookieText);
    if (!validation.ok) {
      const error = `cookie is not usable: ${validation.reason}`;
      log(`skipped: ${error}`);
      await writeLastRun({
        at: new Date().toISOString(),
        status: "session-expired",
        downloaded: 0,
        skipped: 0,
        error,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    log("starting sync");
    const result = await runGalleryDl({ config, galleryRoot });

    if (result.status !== "ok") {
      log(`sync failed: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
      await writeLastRun({
        at: new Date().toISOString(),
        status: result.status === "session-expired" ? "session-expired" : "failed",
        downloaded: 0,
        skipped: result.skippedCount,
        error: result.error,
        durationMs: result.durationMs
      });
      return;
    }

    const indexed = await indexDownloaded(galleryRoot, result.downloadedPaths);
    log(
      `sync done: downloaded=${result.downloadedPaths.length} indexed=${indexed.length} skipped=${result.skippedCount} in ${result.durationMs}ms`
    );

    await writeLastRun({
      at: new Date().toISOString(),
      status: "ok",
      downloaded: result.downloadedPaths.length,
      skipped: result.skippedCount,
      error: null,
      durationMs: result.durationMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`sync error: ${message}`);
    await writeLastRun({
      at: new Date().toISOString(),
      status: "error",
      downloaded: 0,
      skipped: 0,
      error: message.slice(0, 500),
      durationMs: Date.now() - startedAt
    });
  } finally {
    running = false;
  }
}

async function tick(galleryRoot: string): Promise<void> {
  if (!config || !config.enabled) return;
  if (running) return;

  // Do not queue a sync behind a large library scan.
  if (scannerService.getProgress().isScanning) {
    return;
  }

  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastTickMinute) return;

  if (!matchesCron(config.cron, now)) return;
  lastTickMinute = minuteKey;

  await runSyncNow(galleryRoot);
}

export function startScheduler(
  ctx: PluginContext,
  pluginConfig: InstagramSyncConfig,
  galleryRoot: string
): void {
  config = pluginConfig;
  log = ctx.log;

  if (!config.enabled) {
    log("disabled via INSTAGRAM_SYNC_ENABLED=0");
    return;
  }

  clearInterval(timer);

  // Offset the first tick so a fleet of servers does not hit Instagram at the
  // same minute.
  const offsetMs = Math.floor(Math.random() * TICK_INTERVAL_MS);
  setTimeout(() => {
    void tick(galleryRoot);
  }, offsetMs);

  timer = setInterval(() => {
    void tick(galleryRoot);
  }, TICK_INTERVAL_MS);

  const upcoming = nextScheduledRun();
  log(
    `scheduler started: cron="${config.cron}" next=${upcoming ? upcoming.toISOString() : "never"}`
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
}

export async function schedulerState(): Promise<SchedulerState> {
  const upcoming = nextScheduledRun();
  return {
    running,
    nextRunAt: upcoming ? upcoming.toISOString() : null,
    lastRun: await readLastRun()
  };
}
