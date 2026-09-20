/**
 * Background worker — pulls pending videos and analyzes them.
 *
 * Singleton: started once at boot, runs forever, processes one video at a time
 * to avoid hammering the GPU box.
 *
 * Backpressure: if the ai-gateway / LiteLLM is down, we sleep and retry; we
 * don't drop work. Statuses stay "pending" so the queue is recoverable.
 */

import type { IndexedVideoAsset, PluginContext } from "../../../server/src/plugins/types.js";
import { analyzeVideo } from "./analyzer.js";
import { claimNextPending, getStatusSummary, markFailed, markPendingIfFresh, markRunning } from "./storage.js";

const POLL_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 30_000;

let queue: IndexedVideoAsset[] = [];
let draining = false;
let timer: NodeJS.Timeout | null = null;
let log: PluginContext["log"] = ((msg) => console.log(`[ai-analysis] ${msg}`));

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
  // The hook uses a dynamic import to avoid loading the worker before
  // storage is ready; the worker's tick also pulls from DB on its own.
  if (timer === null) {
    timer = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
  }
}

async function tick(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Drain any in-memory queue first (newly-enqueued videos).
    while (queue.length > 0) {
      const asset = queue.shift()!;
      await processOne(asset);
    }
    // Then poll DB for any pending videos we missed (e.g. from a prior run).
    const claimed = await claimNextPending();
    if (!claimed) return;
    await processOne({
      imageId: claimed.imageId,
      assetKey: "",
      relativePath: "",
      absolutePath: claimed.absolutePath,
      folderId: 0,
      mediaType: "video" as const,
      extension: "",
      fileSize: 0,
      mtimeMs: claimed.mtimeMs,
      durationMs: null,
      width: null,
      height: null,
    });
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
  if (result.status === "failed") {
    log(`failed: id=${asset.imageId} reason=${result.reason}`);
    await markFailed(asset.imageId, result.reason ?? "unknown");
    // Brief backoff so we don't tight-loop on persistent failures.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  } else if (result.status === "skipped") {
    log(`skipped: id=${asset.imageId} reason=${result.reason}`);
  } else {
    log(`done: id=${asset.imageId} in ${result.durationMs}ms; domains=${result.domains?.join(", ")}`);
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
