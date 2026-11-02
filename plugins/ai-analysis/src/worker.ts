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
 * Upstream-fault handling: if the upstream is unusable (expired key, DNS
 * failure, gateway 5xx) the worker pauses for good — only an operator can
 * resume it — and the video in flight goes back to 'pending'. Marking it
 * 'failed' would burn the whole library while the key is broken.
 *
 * Operator control: POST /pause stops the worker from claiming new work,
 * POST /resume starts it again. The state is observable via GET /status.
 *
 * Auto-backfill: when AI_ANALYSIS_AUTO_BACKFILL=1 at boot, the worker
 * walks every folder that has at least one video and hasn't been analyzed
 * yet, and enqueues them as pending. Disabled by default to avoid
 * surprising users with a sudden queue spike on first install.
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { IndexedVideoAsset, PluginContext } from "../../../server/dist/plugins/types.js";
import { analyzeVideo } from "./analyzer.js";
import { RateLimitedError, UpstreamUnavailableError } from "./lib/litellm-client.js";
import {
  claimNextPending,
  getDistinctFolderIdsWithPendingOrUnanalyzedVideos,
  getStatusSummary,
  markFailed,
  markFolderUnanalyzedAsPending,
  markPendingIfFresh,
  markRunning,
  reclaimStuckVideos,
  resetToPending,
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

/** Operator-driven pause (POST /pause). Lifts only on POST /resume. */
let manualPaused = false;
/** Optional operator-supplied explanation, shown in the status UI. */
let manualReason: string | null = null;
/**
 * Auto-pause after an upstream fault (expired key, unreachable gateway).
 *
 * The pause is indefinite on purpose: an expired API key can only be fixed
 * by a human, so we stop making requests entirely until an operator resumes
 * the queue. Every resume attempt costs exactly one upstream request, so
 * repeated failures can never hot-loop.
 */
let upstreamPaused = false;
/** The last upstream error seen — surfaced in GET /status. */
let upstreamError: string | null = null;
/** Epoch ms of the current pause (informational). */
let pausedAt: number | null = null;
/** The video currently being analysed — excluded from the reclaim sweep. */
let inFlightImageId: number | null = null;

/** Why the queue is paused. */
export type PauseCause = "manual" | "upstream" | "rate_limit";

/** Observable pause state, rendered by the client and returned by GET /status. */
export interface WorkerPauseState {
  /** True while the worker claims nothing new. */
  paused: boolean;
  /** What caused the pause; null when the worker is running. */
  cause: PauseCause | null;
  /** Human-readable explanation of the pause. */
  message: string | null;
  /** The last upstream error observed (kept for diagnostics). */
  upstreamError: string | null;
  /** ISO timestamp when the pause lifts by itself; null = operator must resume. */
  resumeAt: string | null;
  /** True when only POST /resume can lift the pause. */
  requiresAction: boolean;
  /** ISO timestamp of the current pause. */
  pausedAt: string | null;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** True while the worker must not claim any new video. */
function isPaused(): boolean {
  return (
    manualPaused ||
    upstreamPaused ||
    (rateLimitedUntil !== null && Date.now() < rateLimitedUntil)
  );
}

/** The current pause state, in the shape the API exposes. */
export function getPauseState(): WorkerPauseState {
  if (manualPaused) {
    return {
      paused: true,
      cause: "manual",
      message: manualReason ?? "paused by operator",
      upstreamError,
      resumeAt: null,
      requiresAction: true,
      pausedAt: isoOrNull(pausedAt),
    };
  }
  if (upstreamPaused) {
    return {
      paused: true,
      cause: "upstream",
      message: upstreamError ?? "the upstream AI service is unavailable",
      upstreamError,
      resumeAt: null,
      requiresAction: true,
      pausedAt: isoOrNull(pausedAt),
    };
  }
  if (rateLimitedUntil !== null && Date.now() < rateLimitedUntil) {
    return {
      paused: true,
      cause: "rate_limit",
      message: `upstream rate-limited (retry-after=${lastRetryAfterSec ?? "?"}s)`,
      upstreamError,
      resumeAt: isoOrNull(rateLimitedUntil),
      requiresAction: false,
      pausedAt: isoOrNull(pausedAt),
    };
  }
  return {
    paused: false,
    cause: null,
    message: null,
    upstreamError,
    resumeAt: null,
    requiresAction: false,
    pausedAt: null,
  };
}

/** Operator pause: the worker stops claiming new work. */
export function pauseWorker(reason?: string): WorkerPauseState {
  const wasPaused = isPaused();
  manualPaused = true;
  manualReason = reason && reason.trim() ? reason.trim().slice(0, 200) : null;
  if (!wasPaused) {
    pausedAt = Date.now();
    log(`paused by operator${manualReason ? `: ${manualReason}` : ""}`);
  }
  return getPauseState();
}

/**
 * Operator resume: clear every pause and pick the queue back up.
 *
 * Reclaims videos a crash (or the old upstream-failure bug) left behind, so
 * they get retried instead of sitting in 'running'/'failed' forever.
 */
export function resumeWorker(): WorkerPauseState {
  const wasPaused = isPaused();
  manualPaused = false;
  manualReason = null;
  upstreamPaused = false;
  rateLimitedUntil = null;
  lastRetryAfterSec = null;
  pausedAt = null;
  if (wasPaused) log("resumed by operator");
  void reclaimStuckWork();
  void tick();
  return getPauseState();
}

/** Reclaim orphaned rows; failures are logged, never fatal. */
async function reclaimStuckWork(): Promise<void> {
  try {
    const reclaimed = await reclaimStuckVideos(inFlightImageId === null ? [] : [inFlightImageId]);
    if (reclaimed.running > 0 || reclaimed.upstreamFailed > 0) {
      log(
        `reclaimed ${reclaimed.running} orphaned running video(s) and ${reclaimed.upstreamFailed} upstream-failed video(s) — back to pending`,
      );
    }
  } catch (e) {
    log(`reclaim failed: ${e instanceof Error ? e.message : String(e)}`);
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

  // A crashed worker leaves rows in 'running', and the old upstream-failure
  // bug left rows in 'failed' that were never the video's fault. Reclaim
  // them once at boot so they get retried instead of stranded.
  void reclaimStuckWork();

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
  if (!isPaused()) pausedAt = Date.now();
  rateLimitedUntil = Date.now() + Math.max(1, retryAfterSec) * 1000 + 1000;
  lastRetryAfterSec = retryAfterSec;
  log(`rate-limited upstream: pausing until ${new Date(rateLimitedUntil).toISOString()} (retry-after=${retryAfterSec}s)`);
}

/**
 * Called by the analyzer when the upstream is unusable (expired key, DNS
 * failure, gateway 5xx).
 *
 * The video goes back to 'pending' — the upstream is broken, the video is
 * fine — and the queue pauses until an operator resumes it. Without this the
 * worker would walk the whole library marking every video failed.
 */
export async function noteUpstreamUnavailable(err: UpstreamUnavailableError, imageId: number): Promise<void> {
  const wasPaused = upstreamPaused;
  await resetToPending(imageId);
  upstreamPaused = true;
  upstreamError = err.message;
  if (!wasPaused && !manualPaused) pausedAt = Date.now();
  log(`upstream unavailable — queue paused, id=${imageId} back to pending: ${err.message}`);
  log("fix the model/API key, then resume the queue with POST /api/plugins/ai-analysis/resume");
}

async function tick(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Rate-limit window elapsed → clear the window and continue.
    if (rateLimitedUntil !== null && Date.now() >= rateLimitedUntil) {
      rateLimitedUntil = null;
      lastRetryAfterSec = null;
      if (!manualPaused && !upstreamPaused) pausedAt = null;
      log('rate-limit window elapsed, resuming the queue');
    }
    // Any pause (operator, upstream fault, rate limit) stops new claims.
    if (isPaused()) return;

    // Drain any in-memory queue first (newly-enqueued videos).
    while (queue.length > 0) {
      // A pause can be raised while we work (upstream fault, operator).
      if (isPaused()) return;
      const asset = queue.shift()!;
      try {
        await processOne(asset);
      } catch (e) {
        // The analyzer throws structured errors for the two upstream
        // conditions that must pause the queue instead of failing a video.
        if (e instanceof RateLimitedError) {
          noteRateLimited(e.retryAfterSec);
          // Reset the asset to pending so a later tick picks it up.
          await resetToPending(asset.imageId);
          // Push the asset back to the head of the queue for resume order.
          queue.unshift(asset);
          return;
        }
        if (e instanceof UpstreamUnavailableError) {
          await noteUpstreamUnavailable(e, asset.imageId);
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
      if (e instanceof RateLimitedError) {
        noteRateLimited(e.retryAfterSec);
        // The asset is 'running' from the claim; reset to pending so a
        // later tick re-processes it once the rate-limit window expires.
        await resetToPending(claimed.imageId);
        return;
      }
      if (e instanceof UpstreamUnavailableError) {
        await noteUpstreamUnavailable(e, claimed.imageId);
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
  // Tracked so the reclaim sweep never resets the video we are working on.
  inFlightImageId = asset.imageId;
  try {
    await markRunning(asset.imageId);
    const result = await analyzeVideo(asset);
    if (result.status === 'failed') {
      log(`failed: id=${asset.imageId} reason=${result.reason}`);
      await markFailed(asset.imageId, result.reason ?? 'unknown');
      // Brief backoff so we don't tight-loop on persistent failures.
      await sleep(RETRY_DELAY_MS);
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
  } finally {
    inFlightImageId = null;
  }
}
