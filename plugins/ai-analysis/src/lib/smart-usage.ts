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

/** One of the plan's windows, as the operator sees it. */
export interface PlanWindowView {
  /** Which window this is: the plan's interval, or its week. */
  kind: "interval" | "weekly";
  /** How much of the window is left, as a percentage. */
  remainingPercent: number;
  /** The plan's absolute allowance. Zero when the plan publishes none. */
  total: number;
  /** How much of it is used — by everybody. */
  used: number;
  /** When the window starts, in epoch milliseconds. */
  startTime: number;
  /** When the window ends, in epoch milliseconds. */
  endTime: number;
  /** How long until the window rolls over, in seconds. */
  rollsOverInSeconds: number;
  /**
   * How long the window has left at the rate it is being spent, in hours.
   *
   * Null when the plan is not being spent, or when there is not enough
   * history yet to tell how fast it is going. This is the number that
   * answers "when does this run out".
   */
  hoursLeft: number | null;
}

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
  /** Every window the plan publishes, with what is left of each. */
  windows: PlanWindowView[];
  /**
   * How much faster the plan could be spent before a window runs out
   * before it renews.
   *
   * Above one there is room to spare and the queue can work harder; below
   * one the plan is being spent faster than its window lasts, and going
   * faster would exhaust it early and leave the queue idle until the
   * window renews.
   *
   * This is the ratio of the window that renews soonest: its allowance is
   * the one that is wasted when it renews, so it is the one the pace
   * follows. The other windows have their own ratio, and the queue
   * brakes when one of them is clearly over-spent.
   *
   * Null when there is not enough signal to say.
   */
  roomRatio: number | null;
  /**
   * The worst ratio of the windows that do not decide the pace.
   *
   * It is a brake, not a target: the long budget of the plan belongs
   * mostly to whoever else is on it, and what they spend is not ours to
   * slow down. It only holds the queue back when the plan would be
   * exhausted at more than twice the pace its window allows.
   */
  brakeRatio: number | null;
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

/**
 * The smoothed room ratio of each provider.
 *
 * The plan publishes whole percentages, so the ratio that comes out of it
 * wanders by a few tenths around its true value. The queue follows the
 * smoothed one: the noise would make it change the number of workers every
 * few minutes for no reason, and the room really does move slowly.
 */
const smoothedRoomRatio = new Map<string, number>();

/** How much of the new reading counts when the room is smoothed. */
const ROOM_RATIO_SMOOTHING = 0.4;

/**
 * The recent readings of each pool, so the rate it is being spent at can be
 * measured over more than one poll.
 *
 * The plan publishes whole percentages, so a single poll says almost
 * nothing: two minutes of spending is a fraction of a point. The rate
 * needs a longer stretch to mean anything.
 */
const readingHistory = new Map<string, { state: PoolState; at: number }[]>();

/**
 * How long the readings are kept.
 *
 * The plan publishes whole percentages, so a point is worth many minutes of
 * spending: the rate can only be measured over a stretch long enough for
 * the plan to have moved a whole point. Twelve hours covers a whole
 * five-hour window, which is the shortest one the plan has.
 */
const HISTORY_MS = 12 * 3_600_000;

/** How many readings are kept, so the memory stays bounded. */
const HISTORY_ENTRIES = 400;

/**
 * The shortest stretch the rate is measured over.
 *
 * Below this the numbers are noise: the plan's granularity alone is worth
 * more than the difference.
 */
const MINIMUM_RATE_SPAN_MS = 15 * 60_000;

/**
 * How many points the plan has to have lost for the rate to mean anything.
 *
 * The plan publishes whole percentages, so a measurement that rests on one
 * point can be wrong by a hundred per cent. Three points is the least
 * that gives a usable answer.
 */
const MINIMUM_RATE_POINTS = 3;

/** The cached reading of each pool, so the endpoint is not polled too often. */
const cachedReading = new Map<string, { state: PoolState; at: number }>();

/** Forget the readings. Used by the tests and when the configuration changes. */
export function resetSmartUsage(): void {
  lastReading.clear();
  cachedReading.clear();
  readingHistory.clear();
  smoothedRoomRatio.clear();
}

/**
 * How much room a window has, as a multiplier.
 *
 * The window's room is what is left of it; the time is what is left of
 * its life. Together they say how fast the window may be spent before it
 * runs out before it renews.
 *
 * The drain is the rate the plan is being spent at over the window, which
 * is measured from the moment the window opened: the plan was whole then.
 * A recent measurement would be sharper, but the plan publishes whole
 * percentages and batches them, so a recent measurement is mostly noise.
 *
 * Null when the window has not been running long enough to say.
 */
export function windowRoomRatio(window: PoolWindow, now: number): number | null {
  const hoursSinceStart = (now - window.startTime) / 3_600_000;
  const hoursUntilReset = (window.endTime - now) / 3_600_000;

  // A window that just opened says nothing yet.
  if (hoursSinceStart * 3_600_000 < MINIMUM_RATE_SPAN_MS) return null;
  if (hoursUntilReset <= 0) return 0;

  const drain = (100 - window.remainingPercent) / hoursSinceStart;
  if (drain <= 0) {
    // The plan is not being spent: all the room there is.
    return Number.POSITIVE_INFINITY;
  }

  const room = window.remainingPercent / hoursUntilReset;
  return room / drain;
}

/**
 * A reading of one window of a plan, as it was taken before this process
 * started.
 *
 * The readings outlive the process so the rate survives a restart: the
 * plan publishes whole percentages, and a rate that rests on one point
 * says nothing.
 */
export interface StoredPlanReading {
  /** Which window: the plan's interval, or its week. */
  readonly windowKind: string;
  /** When the window started, in epoch milliseconds. */
  readonly windowStart: number;
  /** When the window ends, in epoch milliseconds. */
  readonly windowEnd: number;
  /** How much of the window was left, as a percentage. */
  readonly remainingPercent: number;
  /** When the reading was taken, in epoch milliseconds. */
  readonly readAt: number;
}

/**
 * Puts the readings that were taken before this process started back into
 * the history.
 *
 * They are what the rate is measured against, so without them the
 * projection is gone until the plan has lost enough whole percentages for
 * the rate to mean anything.
 */
export function seedPlanHistory(
  providerId: string,
  readings: readonly StoredPlanReading[]
): void {
  const history = readingHistory.get(providerId) ?? [];

  for (const reading of readings) {
    const state: PoolState = {
      providerId,
      ok: true,
      error: null,
      model: null,
      readAt: reading.readAt,
      windows: [
        {
          kind: reading.windowKind === 'weekly' ? 'weekly' : 'interval',
          total: 0,
          used: 0,
          remainingPercent: reading.remainingPercent,
          startTime: reading.windowStart,
          endTime: reading.windowEnd
        }
      ]
    };

    history.push({ state, at: reading.readAt });
  }

  // The history is ordered from the oldest to the newest.
  history.sort((a, b) => a.at - b.at);
  readingHistory.set(providerId, history);
}

/**
 * How fast the plan is being spent, as percentage points per hour.
 *
 * Two measurements, and the recent one wins:
 *
 *  - the **recent rate**, between the oldest and the newest reading of the
 *    same window. It says how fast the plan is going now, which is what
 *    answers "when does this run out". A window that rolled over is a
 *    different window, and comparing across the rollover would say the
 *    plan had been refilled.
 *  - the **average over the window**, when there is no history to measure
 *    the recent rate with. The plan is whole when its window opens — the
 *    quota returns to the tier's allowance — so the window's own start is
 *    a reference that is always there. It is diluted by the stretches in
 *    which the plan was not being spent, which is why it is the second
 *    choice.
 *
 * Null when the plan is not being spent, or when neither measurement has
 * enough signal to mean anything.
 */
export function burnRatePerHour(
  history: { state: PoolState; at: number }[],
  kind: "interval" | "weekly",
  now: number
): number | null {
  const current = history[history.length - 1];
  if (!current) return null;

  const window = current.state.windows.find((w) => w.kind === kind);
  if (!window) return null;

  // The oldest reading that is still in the same window. The history is
  // ordered from the oldest to the newest, so the first match is it.
  let oldest: { state: PoolState; at: number } | null = null;
  for (const reading of history) {
    const w = reading.state.windows.find((entry) => entry.kind === kind);
    if (w && w.startTime === window.startTime) {
      oldest = reading;
      break;
    }
  }

  if (oldest) {
    const oldestWindow = oldest.state.windows.find((w) => w.kind === kind);
    const span = now - oldest.at;

    if (oldestWindow && span >= MINIMUM_RATE_SPAN_MS) {
      const drop = oldestWindow.remainingPercent - window.remainingPercent;
      if (drop >= MINIMUM_RATE_POINTS) {
        return drop / (span / 3_600_000);
      }
    }
  }

  // No usable recent rate: the average over the window, from the moment
  // it opened.
  const elapsed = now - window.startTime;
  if (elapsed < MINIMUM_RATE_SPAN_MS) return null;

  const drop = 100 - window.remainingPercent;
  if (drop < MINIMUM_RATE_POINTS) return null;

  return drop / (elapsed / 3_600_000);
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
        windows: [],
        roomRatio: null,
        brakeRatio: null,
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
        windows: [],
        roomRatio: null,
        brakeRatio: null,
        blocked: false,
        resetsAt: null,
        readAt: state.readAt
      });
      continue;
    }

    // The reading joins the history: the rate the plan is being spent at
    // is measured between the oldest and the newest reading of the same
    // window.
    const history = readingHistory.get(provider.id) ?? [];
    history.push({ state, at: now });
    while (history.length > HISTORY_ENTRIES) {
      history.shift();
    }
    // The readings older than the window are of no use.
    while (history.length > 1 && now - history[0].at > HISTORY_MS) {
      history.shift();
    }
    readingHistory.set(provider.id, history);

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

    const windows: PlanWindowView[] = [];
    // The window that renews soonest sets the pace: its allowance is the
    // one that is lost when it renews.
    let paceRatio: number | null = null;
    let paceWindowEnd = Number.POSITIVE_INFINITY;
    // The others are only a brake.
    let brakeRatio: number | null = null;

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

      // How fast this window is being spent, and what that means for how
      // long it lasts. This is the projection the operator cannot get from
      // the percentage alone.
      const burnRate = burnRatePerHour(history, w.kind, now);
      let hoursLeft =
        burnRate && burnRate > 0 ? w.remainingPercent / burnRate : null;

      // The window renews before that, and what is not spent is lost: the
      // plan does not carry the remainder over. So the window that ends
      // first is the limit, and the projection says so.
      if (hoursLeft !== null) {
        const untilRenewal = Math.max(0, (w.endTime - now) / 3_600_000);
        hoursLeft = Math.min(hoursLeft, untilRenewal);
      }

      windows.push({
        kind: w.kind,
        remainingPercent: w.remainingPercent,
        total: w.total,
        used: w.used,
        startTime: w.startTime,
        endTime: w.endTime,
        rollsOverInSeconds: Math.max(0, Math.round((w.endTime - now) / 1000)),
        hoursLeft
      });

      // How much room this window has. The room is what is left of it
      // against how long it has left to live, and the drain is how fast
      // the plan is going. Above one the queue can work harder; below one
      // the plan is being spent faster than its window lasts.
      const ratio = windowRoomRatio(w, now);
      if (ratio === null) continue;

      if (w.endTime < paceWindowEnd) {
        paceWindowEnd = w.endTime;
        paceRatio = ratio;
      }

      if (brakeRatio === null || ratio < brakeRatio) {
        brakeRatio = ratio;
      }
    }

    lastReading.set(provider.id, { state, at: now });

    // The room is smoothed: the plan publishes whole percentages, and the
    // noise in the ratio would make the queue change the number of workers
    // every few minutes for no reason at all.
    let smoothed = paceRatio;
    if (paceRatio !== null) {
      const previous = smoothedRoomRatio.get(provider.id);
      smoothed =
        previous === undefined
          ? paceRatio
          : previous * (1 - ROOM_RATIO_SMOOTHING) + paceRatio * ROOM_RATIO_SMOOTHING;
      smoothedRoomRatio.set(provider.id, smoothed);
    }

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
      // Every window the plan publishes, with what is left of each and how
      // long it lasts at the rate it is going.
      windows,
      // How much faster the plan could be spent before the window that
      // renews soonest runs out before it renews.
      roomRatio: smoothed,
      // The brake: the worst of the other windows.
      brakeRatio: paceRatio === brakeRatio ? null : brakeRatio,
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
