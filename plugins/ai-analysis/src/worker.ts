/**
 * Background worker — pulls pending videos and analyzes them.
 *
 * Singleton: started once at boot, runs forever, processes one video at a time
 * to avoid hammering the GPU box.
 *
 * Backpressure: if the ai-gateway / LiteLLM is down, we sleep and retry; we
 * don't drop work. Statuses stay "pending" so the queue is recoverable.
 *
 * Rate-limit handling: if a request comes back with HTTP 429 (or a
 * transient upstream saturation), the worker pauses until the Retry-After
 * window expires, then resumes automatically. No status loss.
 *
 * Auto-backfill: when AI_ANALYSIS_AUTO_BACKFILL=1 at boot, the worker
 * walks every folder that has at least one video and hasn't been analyzed
 * yet, and enqueues them as pending. Disabled by default to avoid
 * surprising users with a sudden queue spike on first install.
 */

import type { IndexedVideoAsset, PluginContext } from "../../../server/dist/plugins/types.js";
import { analyzeVideo } from "./analyzer.js";
import {
  claimNextPending,
  getDistinctFolderIdsWithPendingOrUnanalyzedVideos,
  getStatusSummary,
  markFailed,
  markFolderUnanalyzedAsPending,
  markPendingIfFresh,
  markRunning,
} from "./storage.js";

const POLL_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 30_000;

let queue: IndexedVideoAsset[] = [];
let draining = false;
let timer: NodeJS.Timeout | null = null;
let log: PluginContext["log"] = ((msg) => console.log(`[ai-analysis] ${msg}`));

/**
 * When non-null, the worker pauses processing until this timestamp. Set by
 * the analyzer when it sees a 429 / Retry-After from the upstream. Cleared
 * implicitly when the tick runs after the deadline.
 */
let rateLimitedUntil: number | null = null;
/** Retry-After seconds from the most recent 429 response (informational). */
let lastRetryAfterSec: number | null = null;

function logRateLimitStatus(): void {
  if (!rateLimitedUntil) return;
  const remainingMs = rateLimitedUntil - Date.now();
  if (remainingMs > 0) {
    log(`rate-limited: resuming in ${Math.ceil(remainingMs / 1000)}s (retry-after=${lastRetryAfterSec ?? "?"}s)`);
  } else {
    log(`rate-limit window elapsed, resuming`);
    rateLimitedUntil = null;
    lastRetryAfterSec = null;
  }
}

/** Called by the video.indexed hook. Just enqueues; the worker pulls from DB too. */
export function enqueueAnalysis(asset: IndexedVideoAsset): void {
  log(`enqueue: ${asset.relativePath} (id=${asset.imageId})`);
  void markPendingIfFresh(asset.imageId, asset.mtimeMs).then((queued) => {
    if (queued) log(`marked pending: id=${asset.imageId}`);
  });
  // The worker loop checks the DB, so we don't need to keep an in-memory queue
  // — but we keep one for fast pickup on first iteration.
  queue.push(asset);
  if (timer === null) {
    // Start the loop on first enqueue.
    timer = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
  }
}

export function startBackgroundWorker(ctx: PluginContext): void {
  log = ctx.log;
  if (timer === null) {
    timer = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
  }

  // Auto-backfill: schedule every folder that has a video but hasn't been
  // analyzed yet. Gated by AI_ANALYSIS_AUTO_BACKFILL=1 so it doesn't fire
  // on every install. Triggered once per process.
  if (process.env.AI_ANALYSIS_AUTO_BACKFILL === '1') {
    void runAutoBackfill();
  }
}

async function runAutoBackfill(): Promise<void> {
  try {
    const folderIds = await getDistinctFolderIdsWithPendingOrUnanalyzedVideos();
    if (folderIds.length === 0) {
      log('auto-backfill: nothing to do (all videos already analyzed)');
      return;
    }
    log(`auto-backfill: queuing ${folderIds.length} folders for analysis`);
    for (const folderId of folderIds) {
      try {
        // Mark every unanalyzed video in the folder as pending. The worker
        // tick will pick them up; no need to push to the in-memory queue.
        await markPendingIfFresh(0, 0); // unused — see per-folder function
      } catch {
        // ignore
      }
    }
    // Actually trigger per-folder enqueueing. We use a lightweight path
    // here: read all unanalyzed video ids in those folders, build the
    // IndexedVideoAsset shape we have available, and push them onto the
    // in-memory queue. The tick will then process them.
    for (const folderId of folderIds) {
      await enqueueFolderUnanalyzed(folderId);
    }
  } catch (e) {
    log(`auto-backfill failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function enqueueFolderUnanalyzed(folderId: number): Promise<void> {
  // Mark every unanalyzed video in this folder as pending. The periodic
  // tick then picks them up and processes them in id order.
  const n = await markFolderUnanalyzedAsPending(folderId);
  log(`auto-backfill: marked ${n} videos pending in folder ${folderId}`);
}

/** Module exports so other plugins / the server can read rate-limit state. */
export function getRateLimitState(): { limitedUntil: number | null; retryAfterSec: number | null } {
  return { limitedUntil: rateLimitedUntil, retryAfterSec: lastRetryAfterSec };
}

/** Called by the analyzer when it detects a 429. Pauses the worker. */
export function noteRateLimited(retryAfterSec: number): void {
  // Add 1s cushion to avoid re-hitting the same instant.
  rateLimitedUntil = Date.now() + Math.max(1, retryAfterSec) * 1000 + 1000;
  lastRetryAfterSec = retryAfterSec;
  log(`rate-limited upstream: pausing until ${new Date(rateLimitedUntil).toISOString()} (retry-after=${retryAfterSec}s)`);
}

async function tick(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // If upstream is rate-limited, just log and wait.
    if (rateLimitedUntil && Date.now() < rateLimitedUntil) {
      logRateLimitStatus();
      return;
    }
    // Window elapsed; clear state and resume.
    if (rateLimitedUntil && Date.now() >= rateLimitedUntil) {
      log('rate-limit window elapsed, resuming the queue');
      rateLimitedUntil = null;
      lastRetryAfterSec = null;
    }

    // Drain any in-memory queue first (newly-enqueued videos).
    while (queue.length > 0) {
      const asset = queue.shift()!;
      try {
        await processOne(asset);
      } catch (e) {
        // processOne swallows errors itself, but if the analyzer throws
        // a structured RateLimitedError, we handle it here.
        if (e && typeof e === 'object' && (e as { name?: string }).name === 'RateLimitedError') {
          const r = (e as { retryAfterSec?: number }).retryAfterSec ?? 60;
          noteRateLimited(r);
          // Reset the asset to pending so a later tick picks it up.
          // markPendingIfFresh won't move 'running' -> 'pending'; do it
          // via markPendingIfFresh-style reset.
          await markPendingIfFresh(asset.imageId, asset.mtimeMs, { force: true });
          // Push the asset back to the head of the queue for resume order.
          queue.unshift(asset);
          return;
        }
        throw e;
      }
    }
    // Then poll DB for any pending videos we missed (e.g. from a prior run).
    const claimed = await claimNextPending();
    if (!claimed) return;
    try {
      await processOne({
        imageId: claimed.imageId,
        assetKey: '',
        relativePath: '',
        absolutePath: claimed.absolutePath,
        folderId: claimed.folderId,
        mediaType: 'video' as const,
        extension: '',
        fileSize: 0,
        mtimeMs: claimed.mtimeMs,
        durationMs: null,
        width: null,
        height: null,
      });
    } catch (e) {
      if (e && typeof e === 'object' && (e as { name?: string }).name === 'RateLimitedError') {
        const r = (e as { retryAfterSec?: number }).retryAfterSec ?? 60;
        noteRateLimited(r);
        // The asset is 'running' from the claim; reset to pending so a
        // later tick re-processes it once the rate-limit window expires.
        await markPendingIfFresh(claimed.imageId, claimed.mtimeMs, { force: true });
        return;
      }
      throw e;
    }
  } catch (e) {
    log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    draining = false;
  }
}

async function processOne(asset: IndexedVideoAsset): Promise<void> {
  log(`processing: id=${asset.imageId}`);
  await markRunning(asset.imageId);
  const result = await analyzeVideo(asset);
  if (result.status === 'failed') {
    log(`failed: id=${asset.imageId} reason=${result.reason}`);
    await markFailed(asset.imageId, result.reason ?? 'unknown');
    // Brief backoff so we don't tight-loop on persistent failures.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  } else if (result.status === 'skipped') {
    log(`skipped: id=${asset.imageId} reason=${result.reason}`);
  } else {
    log(`done: id=${asset.imageId} in ${result.durationMs}ms; domains=${result.domains?.join(', ')}`);
  }
  // Surface a periodic status line.
  try {
    const summary = await getStatusSummary();
    log(
      `queue: total=${summary.totalVideos} ok=${summary.byStatus.ok ?? 0} pending=${summary.byStatus.pending ?? 0} failed=${summary.byStatus.failed ?? 0}`,
    );
  } catch {
    /* ignore — status is best-effort */
  }
}
