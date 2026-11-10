/**
 * The smart usage mode.
 *
 * The hard mode stops the queue when the operator's own windows are spent.
 * That is the right answer when the provider's plan belongs to nobody else.
 *
 * The smart mode answers a different question: *is the plan shared right now?*
 * A plan is often shared — a person's editor assistant and foldergram's bulk
 * analysis draw on the same MiniMax Token Plan — and the plan reports what
 * **everybody** used. So the queue can tell whether it is alone in the pool:
 *
 *   - alone → take the pool, up to the share the operator allows. "Use it
 *     until max."
 *   - not alone → get out of the way. Stop claiming work, wait until the pool
 *     is free again or until the window rolls over and the usage is back at
 *     its minimum.
 *
 * The two rules together are a duty cycle: full throttle when the pool is
 * idle, nothing at all when somebody else is in it.
 *
 * The measurement is a difference of two readings. The plan's counter moves
 * by what *everybody* spent; our own request counter moves by what *we*
 * spent. What is left over is the other user's.
 */

import type { AiProvider } from "../config.js";
import {
  emptyPoolState,
  readPool,
  type PoolState,
  type PoolWindow
} from "./pool-probe.js";
import { providerRequestsBetween, providerRequestsSince } from "./request-counter.js";
import { tokensBetween } from "../usage.js";

/** What the smart mode decided about one provider. */
export interface SmartProviderState {
  /** The provider this is about. */
  providerId: string;
  /** The label, for display. */
  label: string;
  /** The pool could be read. */
  probeOk: boolean;
  /** Why it could not be read. */
  probeError: string | null;
  /** The model the pool reports for. */
  model: string | null;
  /** Somebody else is using the plan. */
  contended: boolean;
  /** How much of the pool's drain was not ours. */
  residual: number;
  /** The share of the pool we may take right now, as a percentage. */
  allowedPercent: number;
  /** The pool's allowance for the watched window. */
  poolTotal: number;
  /** The pool's usage for the watched window — by everybody. */
  poolUsed: number;
  /** Our own usage for the watched window. */
  ourUsage: number;
  /** The cap: the share of the pool we may take. */
  cap: number;
  /** We have taken our share; the queue must stop until the window rolls. */
  blocked: boolean;
  /** When the watched window rolls over. */
  resetsAt: string | null;
  /** When the pool was last read. */
  readAt: number;
}

/** The verdict on a shared pool. */
export interface ContentionVerdict {
  /** Somebody else is using the plan. */
  contended: boolean;
  /** How much of the pool's drain was not ours. */
  residual: number;
  /** The unit the pool turned out to count. */
  unit: "requests" | "tokens";
}

/**
 * Decide whether somebody else is in the pool.
 *
 * The plan's counter and our counter must be in the same unit to be
 * subtracted. The plan counts **requests** — that is what MiniMax's plan
 * allowance is — but the reading is checked rather than assumed: if our own
 * requests already exceed the pool's drain, the plan must be counting
 * something bigger, and the tokens are used instead.
 *
 * A drain that is ours alone leaves a residual of zero: the pool is free.
 * A residual above the tolerance is somebody else's.
 */
export function detectContention(
  poolDrain: number,
  ourRequests: number,
  ourTokens: number,
  contentionPercent: number
): ContentionVerdict {
  const drain = Math.max(0, poolDrain);
  const requests = Math.max(0, ourRequests);
  const tokens = Math.max(0, ourTokens);

  // Our requests cannot explain the drain at all: the plan counts something
  // bigger than requests, so the tokens are the ones to compare.
  if (requests > drain) {
    const residual = drain - tokens;
    return {
      contended: residual > toleranceFor(drain, contentionPercent),
      residual,
      unit: "tokens"
    };
  }

  const requestResidual = drain - requests;

  // The plan counts requests — that is what MiniMax's allowance is — so the
  // requests are the answer unless the tokens explain the drain far better.
  // A plan that counts tokens would leave a huge residual behind, and the
  // tokens would clear it.
  if (tokens <= drain && (drain - tokens) * 10 < requestResidual) {
    const residual = drain - tokens;
    return {
      contended: residual > toleranceFor(drain, contentionPercent),
      residual,
      unit: "tokens"
    };
  }

  return {
    contended: requestResidual > toleranceFor(drain, contentionPercent),
    residual: requestResidual,
    unit: "requests"
  };
}

/**
 * The drain that counts as somebody else's.
 *
 * A percentage of the drain, but never less than one request: a single
 * request from another user is enough to make the pool shared.
 */
function toleranceFor(drain: number, contentionPercent: number): number {
  return Math.max(1, (drain * Math.max(0, contentionPercent)) / 100);
}

/** The last reading of each pool, so the next one can be compared with it. */
const lastReading = new Map<string, { state: PoolState; at: number }>();

/** The cached reading of each pool, so the endpoint is not polled too often. */
const cachedReading = new Map<string, { state: PoolState; at: number }>();

/** Forget the readings. Used by the tests and when the configuration changes. */
export function resetSmartUsage(): void {
  lastReading.clear();
  cachedReading.clear();
}

/**
 * Read the pool, but no more often than the operator asked for.
 *
 * The worker ticks far more often than the pool needs to be read, so the
 * reading is cached for `pollMinutes`.
 */
async function readPoolCached(
  provider: AiProvider,
  now: number
): Promise<PoolState> {
  const pollMs = Math.max(1, provider.usageLimits.smart.pollMinutes) * 60_000;
  const cached = cachedReading.get(provider.id);
  if (cached && now - cached.at < pollMs) return cached.state;

  const state = await readPool(provider);
  cachedReading.set(provider.id, { state, at: now });
  return state;
}

/** The window the operator wants to watch. */
export function pickWindow(
  state: PoolState,
  watch: "interval" | "weekly" | "both"
): PoolWindow | null {
  if (watch === "both") {
    return state.windows[0] ?? null;
  }
  return state.windows.find((window) => window.kind === watch) ?? state.windows[0] ?? null;
}

/**
 * What the smart mode says about every provider that uses it.
 *
 * A provider that is not in smart mode is not in the result — the hard mode
 * handles it.
 */
export async function evaluateSmartUsage(
  providers: AiProvider[],
  now: number = Date.now()
): Promise<Map<string, SmartProviderState>> {
  const result = new Map<string, SmartProviderState>();

  for (const provider of providers) {
    const limits = provider.usageLimits;
    if (!limits.enabled || limits.mode !== "smart") continue;

    const state = await readPoolCached(provider, now);

    if (!state.ok) {
      result.set(provider.id, {
        providerId: provider.id,
        label: provider.label,
        probeOk: false,
        probeError: state.error,
        model: null,
        contended: false,
        residual: 0,
        allowedPercent: limits.smart.idlePercent,
        poolTotal: 0,
        poolUsed: 0,
        ourUsage: 0,
        cap: 0,
        blocked: false,
        resetsAt: null,
        readAt: state.readAt
      });
      continue;
    }

    const window = pickWindow(state, limits.smart.watch);
    if (!window) {
      result.set(provider.id, {
        providerId: provider.id,
        label: provider.label,
        probeOk: false,
        probeError: "the plan reported no window to watch",
        model: state.model,
        contended: false,
        residual: 0,
        allowedPercent: limits.smart.idlePercent,
        poolTotal: 0,
        poolUsed: 0,
        ourUsage: 0,
        cap: 0,
        blocked: false,
        resetsAt: null,
        readAt: state.readAt
      });
      continue;
    }

    // What we sent since the window started.
    const ourUsage = providerRequestsSince(provider.id, window.startTime);

    // What the pool did since we last looked, and what we did in the same
    // span. The difference is the other user's.
    const previous = lastReading.get(provider.id);
    let contended = false;
    let residual = 0;

    if (previous) {
      const previousWindow = pickWindow(previous.state, limits.smart.watch);
      if (previousWindow) {
        const poolDrain = Math.max(0, window.used - previousWindow.used);
        const ourDrain = providerRequestsBetween(provider.id, previous.at, now);
        const ourTokens = await tokensBetween(
          provider.id,
          new Date(previous.at),
          new Date(now)
        );
        const verdict = detectContention(
          poolDrain,
          ourDrain,
          ourTokens,
          limits.smart.contentionPercent
        );
        contended = verdict.contended;
        residual = verdict.residual;
      }
    }

    // The share of the pool we may take right now.
    const allowedPercent = contended ? limits.smart.yieldPercent : limits.smart.idlePercent;
    const cap = Math.floor((window.total * allowedPercent) / 100);

    lastReading.set(provider.id, { state, at: now });

    result.set(provider.id, {
      providerId: provider.id,
      label: provider.label,
      probeOk: true,
      probeError: null,
      model: state.model,
      contended,
      residual,
      allowedPercent,
      poolTotal: window.total,
      poolUsed: window.used,
      ourUsage,
      cap,
      // Over our share of the pool: the queue waits for the window to roll.
      blocked: cap > 0 && ourUsage >= cap,
      resetsAt: new Date(window.endTime).toISOString(),
      readAt: state.readAt
    });
  }

  return result;
}

/** The reading of a pool, for the API and the tests. */
export function poolReading(providerId: string): PoolState | null {
  return cachedReading.get(providerId)?.state ?? emptyPoolState(providerId, "not read yet");
}
