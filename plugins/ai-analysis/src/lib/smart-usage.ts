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
  /** The pool's allowance for the watched window. Zero when it publishes none. */
  poolTotal: number;
  /** How much of it is used — by everybody. */
  poolUsed: number;
  /** Our own use of it. */
  ourUsage: number;
  /** The cap: the share of the plan we may take. */
  cap: number;
  /**
   * How much of the watched window the plan says is left, as a percentage.
   *
   * This is the plan's own number, and for a plan that publishes no
   * absolute allowance it is the only one there is.
   */
  poolRemainingPercent: number | null;
  /** We have taken our share; the queue must stop until the window rolls. */
  blocked: boolean;
  /** When the watched window rolls over. */
  resetsAt: string | null;
  /** When the pool was last read. */
  readAt: number;
}

/**
 * The margin the queue keeps when the plan publishes no absolute allowance.
 *
 * The plan publishes whole percentages, so the finest gap it can express is
 * one point. Two points of margin is enough to finish the analysis that is
 * already running without starting one that could not be paid for.
 */
export const PERCENTAGE_SAFETY_MARGIN = 2;

/**
 * Whether the pool is spent, when it publishes no absolute allowance.
 *
 * The plan's own wall is then the limit: there is no count to compare with,
 * and the operator's budget is not the plan's business — the plan knows
 * nothing about it. So the queue stops when the plan says the window is
 * nearly over, and carries on when the window rolls over.
 *
 * While somebody else is in the pool, the queue leaves them their share: the
 * floor is the share we may take instead of the safety margin.
 */
export function poolIsSpent(window: PoolWindow, allowedPercent: number): boolean {
  const floor = Math.max(PERCENTAGE_SAFETY_MARGIN, 100 - Math.max(0, allowedPercent));
  return window.remainingPercent <= floor;
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
        poolRemainingPercent: null,
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
        poolRemainingPercent: null,
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
        const ourDrain = providerRequestsBetween(provider.id, previous.at, now);
        const ourTokens = await tokensBetween(
          provider.id,
          new Date(previous.at),
          new Date(now)
        );

        if (window.total > 0) {
          // A plan that counts: the pool's drain and our own usage are in
          // the same unit, so the difference is the other user's.
          const poolDrain = Math.max(0, window.used - previousWindow.used);
          const verdict = detectContention(
            poolDrain,
            ourDrain,
            ourTokens,
            limits.smart.contentionPercent
          );
          contended = verdict.contended;
          residual = verdict.residual;
        } else {
          // A plan that publishes only a percentage: its drain is in
          // percentage points and our usage is in requests, so the two
          // cannot be subtracted — a request costs the plan a number of
          // points that depends on the model and the request itself.
          //
          // What can be told apart is the pool moving while we sent
          // nothing: that drain is the other user's, whoever they are.
          // A pool that moved while we were working is not attributed to
          // anybody: we do not yield on a guess.
          const poolDrain = Math.max(
            0,
            previousWindow.remainingPercent - window.remainingPercent
          );
          contended = ourDrain === 0 && poolDrain > 0;
          residual = contended ? poolDrain : 0;
        }
      }
    }

    // The share of the pool we may take right now.
    const allowedPercent = contended ? limits.smart.yieldPercent : limits.smart.idlePercent;

    // The pool's wall, in every window the plan publishes.
    //
    // A plan that publishes an absolute allowance is compared with our own
    // requests: we stop when we have taken the share we may take. A plan
    // that publishes only a percentage has no count to compare with, and
    // its own wall is the limit — the operator's budget is not the plan's
    // business, and the plan knows nothing about it.
    //
    // Every window counts: the plan has a five-hour wall *and* a weekly
    // one, and the queue must not run past either of them.
    let blocked = false;
    let cap = 0;
    // The window the operator watches rolls over on its own, so the queue
    // always knows when it does.
    let resetsAt = new Date(window.endTime).toISOString();

    for (const w of state.windows) {
      let spent: boolean;

      if (w.total > 0) {
        const windowCap = Math.floor((w.total * allowedPercent) / 100);
        if (w.kind === window.kind) {
          cap = windowCap;
        }
        const ours = providerRequestsSince(provider.id, w.startTime);
        spent = windowCap > 0 && ours >= windowCap;
      } else {
        spent = poolIsSpent(w, allowedPercent);
      }

      if (spent) {
        blocked = true;
        // The queue carries on when the last of the spent windows rolls
        // over: until then one of them is still spent.
        if (w.endTime > Date.parse(resetsAt)) {
          resetsAt = new Date(w.endTime).toISOString();
        }
      }
    }

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
      // What the plan says is left of the watched window. For a plan that
      // publishes no absolute allowance this is the only number there is.
      poolRemainingPercent: window.remainingPercent,
      // Over our share of the pool, or out of room in one of its windows:
      // the queue waits for the window to roll.
      blocked,
      resetsAt,
      readAt: state.readAt
    });
  }

  return result;
}

/** The reading of a pool, for the API and the tests. */
export function poolReading(providerId: string): PoolState | null {
  return cachedReading.get(providerId)?.state ?? emptyPoolState(providerId, "not read yet");
}
