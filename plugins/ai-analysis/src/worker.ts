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
import { recordAiPause, setAiQueueDepth } from "../../../server/dist/observability/telemetry.js";
import { analyzeVideo } from "./analyzer.js";
import {
  getRecanonicalizationState,
  runRecanonicalizationSweep
} from "./canonicalize.js";
import { readAiConfig } from "./configStore.js";
import { RateLimitedError, UpstreamUnavailableError } from "./lib/litellm-client.js";
import { countDomains } from "./storage.js";
import { getCachedUsageStatus, type UsageStatus } from "./usage.js";
import {
  evaluateSmartUsage,
  poolReading,
  type SmartProviderState
} from "./lib/smart-usage.js";
import {
  claimNextPending,
  countPendingAnalyses,
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

/**
 * How often the queue depth is read from the database, in milliseconds.
 *
 * The count is not cheap on a big library - it is a scan over every pending
 * video - so it is read every few minutes instead of on every tick. A queue
 * depth that is five minutes old is still worth more than no queue depth.
 */
const QUEUE_DEPTH_REFRESH_MS = 300_000;

let queue: IndexedVideoAsset[] = [];
let draining = false;

/**
 * The provider the vision stage spends from.
 *
 * The worker refreshes it from the configuration on every tick, so the
 * telemetry can name the provider that caused a pause instead of saying
 * "unknown".
 */
let activeProviderId: string | null = null;

/** When the queue depth was last read from the database. */
let lastQueueDepthRead = 0;
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
/**
 * The usage limit that stopped the queue, if any.
 *
 * Unlike the upstream fault, this lifts by itself: the window resets and the
 * budget is available again, so the queue resumes without an operator.
 */
let usagePause: UsageStatus | null = null;
/**
 * The shared plan that stopped the queue, if any.
 *
 * The plan may be in use by somebody else — a person's editor assistant, for
 * instance. The plan says so, and the queue gets out of the way until the
 * pool is free again or the window rolls over.
 */
let smartPause: SmartProviderState | null = null;
/** What the smart mode says about every provider, for the API. */
let smartStates = new Map<string, SmartProviderState>();
/**
 * The cooldown after a transient upstream fault.
 *
 * A spent credit or an unreachable gateway is not a broken configuration:
 * both come back on their own. The queue waits instead of stopping, and the
 * wait grows with every consecutive failure — a long outage is met with one
 * request an hour, not one a minute.
 */
let quotaPausedUntil: number | null = null;
/** Consecutive transient failures — the index into the cooldown ladder. */
let quotaAttempts = 0;

/**
 * How long to wait after a transient upstream fault, in minutes.
 *
 * The ladder grows so a long outage is not met with a request every minute,
 * and stops at an hour: long enough to be cheap, short enough that the
 * queue picks up promptly once the credit is back.
 */
const QUOTA_COOLDOWN_MINUTES = [1, 2, 5, 10, 30, 60];
/**
 * The domain count at the last re-check sweep.
 *
 * The sweep only matters when the taxonomy has grown, so it is skipped when
 * the count has not moved.
 */
let domainsAtLastSweep = 0;
/** True while a re-check sweep is running. */
let recanonicalizationRunning = false;

/** Why the queue is paused. */
export type PauseCause =
  | "manual"
  | "upstream"
  | "rate_limit"
  | "usage_limit"
  | "upstream_quota"
  | "shared_plan";

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
  /** The usage status that caused a usage_limit pause. */
  usage: UsageStatus | null;
  /** The shared plan that caused a shared_plan pause. */
  sharedPlan: SmartProviderState | null;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** True while the worker must not claim any new video. */
function isPaused(): boolean {
  return (
    manualPaused ||
    upstreamPaused ||
    quotaPausedUntil !== null ||
    usagePause !== null ||
    smartPause !== null ||
    (rateLimitedUntil !== null && Date.now() < rateLimitedUntil)
  );
}

/** A one-line explanation of why the shared plan stopped the queue. */
function sharedPlanMessage(state: SmartProviderState): string {
  if (state.contended) {
    return (
      `somebody else is using the "${state.label}" plan — the queue yields ` +
      `until the plan is free again`
    );
  }
  return (
    `the "${state.label}" plan's share is used up — the queue waits for the ` +
    `window to roll over`
  );
}

/**
 * A one-line explanation of why the plan's own wall stopped the queue.
 *
 * The number is the plan's own: how much of the window is left, as it
 * publishes it.
 */
function poolSpentMessage(state: SmartProviderState): string {
  const left = state.poolRemainingPercent;
  const remaining = left === null ? "" : ` (${left}% left)`;
  return (
    `the "${state.label}" plan has no room left${remaining} — the queue waits ` +
    `for the window to roll over`
  );
}

/** A one-line explanation of which budget stopped the queue. */
function usageMessage(status: UsageStatus): string {
  const provider = status.providers.find((entry) => entry.blocked);
  const window = provider?.windows.find((entry) => entry.overThreshold);
  if (!provider || !window) return "the usage limit was reached";
  return (
    `the ${window.hours}h usage limit of "${provider.label}" was reached ` +
    `(${Math.round(window.percent)}% of its budget)`
  );
}

/** The current pause state, in the shape the API exposes. */
export function getPauseState(): WorkerPauseState {
  if (smartPause !== null) {
    return {
      paused: true,
      // The plan being spent and the plan being shared are different causes.
      cause: smartPause.blocked ? "usage_limit" : "shared_plan",
      message: smartPause.blocked
        ? poolSpentMessage(smartPause)
        : sharedPlanMessage(smartPause),
      upstreamError,
      resumeAt: smartPause.resetsAt,
      // The pool frees itself: the other user stops, or the window rolls
      // over. No operator needed.
      requiresAction: false,
      pausedAt: isoOrNull(pausedAt),
      usage: null,
      sharedPlan: smartPause
    };
  }
  if (usagePause !== null) {
    return {
      paused: true,
      cause: "usage_limit",
      message: usageMessage(usagePause),
      upstreamError,
      resumeAt:
        usagePause.providers.find((entry) => entry.blocked)?.blockedUntil ?? null,
      // The window resets on its own — no operator needed.
      requiresAction: false,
      pausedAt: isoOrNull(pausedAt),
      usage: usagePause,
      sharedPlan: null
    };
  }
  if (quotaPausedUntil !== null) {
    return {
      paused: true,
      cause: "upstream_quota",
      message:
        upstreamError ??
        "the upstream's credit or allowance ran out — the queue retries on its own",
      upstreamError,
      resumeAt: new Date(quotaPausedUntil).toISOString(),
      // The cooldown lifts by itself; no operator needed.
      requiresAction: false,
      pausedAt: isoOrNull(pausedAt),
      usage: usagePause,
      sharedPlan: null
    };
  }
  if (manualPaused) {
    return {
      paused: true,
      cause: "manual",
      message: manualReason ?? "paused by operator",
      upstreamError,
      resumeAt: null,
      requiresAction: true,
      pausedAt: isoOrNull(pausedAt),
      usage: usagePause,
      sharedPlan: null
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
      usage: usagePause,
      sharedPlan: null
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
      usage: usagePause,
      sharedPlan: null
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
    usage: usagePause,
    sharedPlan: null
  };
}

/** Operator pause: the worker stops claiming new work. */
export function pauseWorker(reason?: string): WorkerPauseState {
  const wasPaused = isPaused();
  manualPaused = true;
  manualReason = reason && reason.trim() ? reason.trim().slice(0, 200) : null;
  if (!wasPaused) {
    pausedAt = Date.now();
    recordAiPause({ providerId: null, cause: "manual" });
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
  quotaPausedUntil = null;
  quotaAttempts = 0;
  smartPause = null;
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
/**
 * What the smart mode says about every provider that uses it.
 *
 * The API hands this to the browser so the settings page can show the plan's
 * state — how much of it is used, how much of that is ours, and whether
 * somebody else is in the pool.
 */
export function getSmartStates(): SmartProviderState[] {
  return [...smartStates.values()];
}

export function getRateLimitState(): { limitedUntil: number | null; retryAfterSec: number | null } {
  return { limitedUntil: rateLimitedUntil, retryAfterSec: lastRetryAfterSec };
}

/** Called by the analyzer when it detects a 429. Pauses the worker. */
export function noteRateLimited(retryAfterSec: number): void {
  // Add 1s cushion to avoid re-hitting the same instant.
  if (!isPaused()) pausedAt = Date.now();
  rateLimitedUntil = Date.now() + Math.max(1, retryAfterSec) * 1000 + 1000;
  lastRetryAfterSec = retryAfterSec;
  recordAiPause({ providerId: activeProviderId, cause: "rate_limit" });
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
  await resetToPending(imageId);

  // A quota or an unreachable service comes back on its own: the credit is
  // topped up, the gateway restarts, the DNS catches up. The queue waits
  // instead of stopping, and the wait grows with every consecutive failure.
  if (err.kind === "quota" || err.kind === "unreachable") {
    const minutes =
      QUOTA_COOLDOWN_MINUTES[
        Math.min(quotaAttempts, QUOTA_COOLDOWN_MINUTES.length - 1)
      ];
    quotaAttempts += 1;
    quotaPausedUntil = Date.now() + minutes * 60_000;
    upstreamError = err.message;
    if (!manualPaused) pausedAt = Date.now();
    recordAiPause({ providerId: activeProviderId, cause: "upstream_quota" });
    log(
      `upstream ${err.kind} — waiting ${minutes} min before retrying, id=${imageId} back to pending`
    );
    return;
  }

  // A bad key or a missing model only a human can fix.
  const wasPaused = upstreamPaused;
  upstreamPaused = true;
  upstreamError = err.message;
  recordAiPause({ providerId: activeProviderId, cause: "upstream" });
  if (!wasPaused && !manualPaused) pausedAt = Date.now();
  log(`upstream unavailable — queue paused, id=${imageId} back to pending: ${err.message}`);
  log("fix the model/API key, then resume the queue with POST /api/plugins/ai-analysis/resume");
}

/**
 * Publishes how much work is waiting.
 *
 * The count comes from the database, where the real queue lives. The
 * in-memory list is only the fast path for the videos that were just
 * indexed, and it is empty most of the time.
 */
async function refreshQueueDepth(): Promise<void> {
  const now = Date.now();

  if (now - lastQueueDepthRead < QUEUE_DEPTH_REFRESH_MS) {
    return;
  }

  lastQueueDepthRead = now;

  try {
    setAiQueueDepth(await countPendingAnalyses());
  } catch (e) {
    console.error(
      '[ai-analysis] could not read the queue depth:',
      e instanceof Error ? e.message : String(e)
    );
  }
}

/**
 * Stop the queue when a usage limit has been reached.
 *
 * The pause lifts by itself: the window resets, the budget is available
 * again, and the next tick carries on. Nothing is lost — the videos stay
 * `pending` and are picked up afterwards.
 */
async function applyUsageLimit(): Promise<void> {
  const config = await readAiConfig();

  // Refreshed here because this runs on every tick, before anything can
  // pause the queue.
  activeProviderId = config.stages.vision.providerId || null;

  // A provider in smart mode whose pool can be read is governed by the
  // pool: the plan's own wall is the limit, and the operator's budget is
  // not — the plan knows nothing about a number that was typed here.
  //
  // The typed windows are only the fallback for a pool that could not be
  // read. Better than nothing while the server is unreachable, and it stops
  // being the limit as soon as the server answers again.
  const limited = config.providers.filter((provider) => {
    if (!provider.usageLimits.enabled) return false;
    if (provider.usageLimits.mode !== "smart") return true;
    if (provider.usageLimits.smart.ignoreHardWindows) return false;
    const pool = poolReading(provider.id);
    return !(pool && pool.ok);
  });
  if (limited.length === 0) {
    usagePause = null;
    return;
  }

  const status = await getCachedUsageStatus(config.providers);
  if (!status.blocked) {
    if (usagePause !== null) {
      log("usage limit no longer reached — the queue carries on");
    }
    usagePause = null;
    return;
  }

  const blocking = status.providers.find((provider) => provider.blocked);
  if (usagePause?.providers.find((entry) => entry.blocked)?.providerId !== blocking?.providerId) {
    log(`usage limit reached: ${usageMessage(status)}`);
  }
  // Only the start of the pause is counted. The tick repeats every few
  // seconds, and a pause that is still on must not be counted again and
  // again.
  if (usagePause === null) {
    recordAiPause({ providerId: blocking?.providerId ?? null, cause: "usage_limit" });
  }
  usagePause = status;
}

/**
 * Stop the queue when the plan is shared with somebody else, or when the
 * plan has no room left.
 *
 * The plan says what everybody used. When the part that is not ours is more
 * than a rounding error, somebody else is in the pool, and the queue gets out
 * of the way: it stops claiming work and waits for the pool to be free again
 * or for the window to roll over.
 *
 * When the plan itself runs out of room, the queue stops too — but for a
 * different reason, and it says so: the plan's wall is not the same thing as
 * somebody else taking a share.
 *
 * The pause lifts by itself — the other user stops, or the window ends.
 */
async function applySharedPlan(): Promise<void> {
  const config = await readAiConfig();
  const shared = config.providers.filter(
    (provider) => provider.usageLimits.enabled && provider.usageLimits.mode === "smart"
  );
  if (shared.length === 0) {
    smartStates = new Map();
    smartPause = null;
    return;
  }

  const states = await evaluateSmartUsage(config.providers);
  smartStates = states;

  // A shared pool is the more specific reason, so it wins over an exhausted
  // share.
  let blocking: SmartProviderState | null = null;
  for (const state of states.values()) {
    if (!state.contended && !state.blocked) continue;
    if (!blocking || (state.contended && !blocking.contended)) blocking = state;
  }

  if (!blocking) {
    if (smartPause !== null) {
      log("the plan is free again — the queue carries on");
    }
    smartPause = null;
    return;
  }

  // The plan being spent and the plan being shared are different causes,
  // and the operator has to be able to tell them apart.
  const cause: PauseCause = blocking.blocked ? "usage_limit" : "shared_plan";

  if (
    smartPause?.providerId !== blocking.providerId ||
    smartPause?.contended !== blocking.contended ||
    smartPause?.blocked !== blocking.blocked
  ) {
    log(blocking.blocked ? poolSpentMessage(blocking) : sharedPlanMessage(blocking));
  }
  // Only the start of the pause is counted, for the same reason as above.
  if (smartPause === null) {
    recordAiPause({ providerId: blocking.providerId, cause });
  }
  smartPause = blocking;
  if (!manualPaused) pausedAt = Date.now();
}

/**
 * Re-check the earlier posts once the queue has drained.
 *
 * The sweep is worth running when the taxonomy has grown: a domain proposed
 * after a post was analysed may fit it better than the one it was given. It is
 * a background concern, so it never blocks the queue and it is skipped while
 * the canonicalizer is off.
 */
async function maybeRunRecanonicalization(): Promise<void> {
  if (recanonicalizationRunning) return;

  const config = await readAiConfig();
  if (!config.stages.canonicalizer.enabled || !config.stages.canonicalizer.url) {
    return;
  }

  const domains = await countDomains();
  if (domains === domainsAtLastSweep) return;

  recanonicalizationRunning = true;
  try {
    const result = await runRecanonicalizationSweep(200, config.stages.canonicalizer.verify);
    if (result.checked > 0) {
      domainsAtLastSweep = domains;
      log(`re-checked ${result.checked} post(s), ${result.moved} moved to a better domain`);
    }
  } finally {
    recanonicalizationRunning = false;
  }
}

async function tick(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // The depth is published before anything else, so it is fresh even
    // while the queue is paused - which is when it matters most.
    await refreshQueueDepth();

    // The plan is read first: it decides whether the pool's wall or the
    // operator's own budget is the limit, and that answer has to be in
    // place before the budget is looked at.
    await applySharedPlan();

    // The usage limit is checked before anything is claimed: a poll that
    // would blow through the budget must not start.
    await applyUsageLimit();

    // A cooldown after a transient upstream fault elapsed → try again.
    if (quotaPausedUntil !== null && Date.now() >= quotaPausedUntil) {
      quotaPausedUntil = null;
      quotaAttempts = 0;
      log("the upstream cooldown elapsed — retrying");
    }

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
    if (!claimed) {
      // The queue is empty — a good moment to re-check the posts whose
      // domain may have moved on (a newer domain was proposed since they
      // were analysed).
      await maybeRunRecanonicalization();
      return;
    }
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
      // The upstream answered, so the cooldown ladder starts over.
      quotaAttempts = 0;
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
