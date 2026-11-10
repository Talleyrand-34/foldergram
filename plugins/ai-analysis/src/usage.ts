/**
 * Tracking what the AI pipeline has spent, per provider, and deciding when
 * to stop.
 *
 * The limits live on the **provider**, because the providers' own allowances
 * differ: a paid plan counts tokens over its own window, a local model
 * against nothing at all. A MiniMax plan might count a rolling 5-hour window
 * and a weekly one; the operator configures exactly those windows.
 *
 * The windows are **rolling** — "in the last N hours" — because a window
 * with an arbitrary length has no calendar boundary to align to. The budget
 * is the provider's total allowance, and each window names the share of it
 * that window may spend.
 *
 * The usage is read from `ai_analysis_events`, which records the token counts
 * of every run and the provider that spent them.
 */

import { databaseManager } from "../../../server/dist/db/database.js";

import type { AiProvider, AiUsageWindowRule } from "./config.js";

/** The usage in one window. */
export interface UsageWindowStatus {
  /** The window's length, in hours. */
  hours: number;
  /** The tokens spent in this window. */
  used: number;
  /** The budget for this window — the provider's budget times the share. */
  limit: number;
  /** The share of THIS window's budget used, 0–100+. */
  percent: number;
  /** True when the window has used its share. */
  overThreshold: boolean;
  /** When the window frees up — the length of the window from now. */
  resetsAt: string;
}

/** What one provider has spent. */
export interface ProviderUsageStatus {
  /** The provider the numbers belong to. */
  providerId: string;
  /** The provider's label, for display. */
  label: string;
  /** The limits are being enforced. */
  enabled: boolean;
  /** The provider's total budget. */
  budget: number;
  windows: UsageWindowStatus[];
  /**
   * True when a window has used its share. The queue must not claim any more
   * work while this holds.
   */
  blocked: boolean;
  /** The window that tripped, if any. */
  blockedWindow: number | null;
  /** When the blocking window frees up. */
  blockedUntil: string | null;
}

/** What every provider has spent. */
export interface UsageStatus {
  providers: ProviderUsageStatus[];
  /** A provider is over its share — the queue must not claim work. */
  blocked: boolean;
}

/**
 * The tokens a provider spent since a moment.
 *
 * Every event counts, not just the completed ones: a run that failed at the
 * last step still consumed its input tokens.
 */
export async function tokensSince(
  providerId: string,
  since: Date
): Promise<number> {
  const driver = await databaseManager.getConnection();
  const row = await driver.queryOne<{ used: number | null }>(
    `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS used
       FROM ai_analysis_events
      WHERE provider_id = ?
        AND created_at >= ?`,
    [providerId, since.toISOString()]
  );
  return Number(row?.used ?? 0);
}

/**
 * The tokens a provider spent between two moments.
 *
 * The plan counts requests, but a plan that counts tokens would need the
 * token figure to be compared with. The events are written when an analysis
 * finishes, so the figure trails the real spend a little.
 */
export async function tokensBetween(
  providerId: string,
  from: Date,
  to: Date
): Promise<number> {
  const driver = await databaseManager.getConnection();
  const row = await driver.queryOne<{ used: number | null }>(
    `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS used
       FROM ai_analysis_events
      WHERE provider_id = ?
        AND created_at >= ?
        AND created_at < ?`,
    [providerId, from.toISOString(), to.toISOString()]
  );
  return Number(row?.used ?? 0);
}

/** The budget of one window: the provider's budget times the window's share. */
export function windowBudget(budget: number, rule: AiUsageWindowRule): number {
  if (budget <= 0 || rule.percent <= 0) return 0;
  return Math.floor((budget * rule.percent) / 100);
}

/** The usage of one provider, and whether it is over a share. */
export async function getProviderUsage(
  provider: AiProvider,
  now: Date = new Date()
): Promise<ProviderUsageStatus> {
  const limits = provider.usageLimits;
  const windows: UsageWindowStatus[] = [];

  for (const rule of limits.windows) {
    const limit = windowBudget(limits.budget, rule);
    if (limit <= 0) continue;

    const since = new Date(now.getTime() - rule.hours * 3_600_000);
    const used = await tokensSince(provider.id, since);
    const percent = Math.round((used / limit) * 1000) / 10;
    const overThreshold = used >= limit;

    windows.push({
      hours: rule.hours,
      used,
      limit,
      percent,
      overThreshold,
      // A rolling window frees up its oldest tokens as they age out.
      resetsAt: new Date(now.getTime() + rule.hours * 3_600_000).toISOString()
    });
  }

  const blocking = windows.find((window) => window.overThreshold) ?? null;

  return {
    providerId: provider.id,
    label: provider.label,
    enabled: limits.enabled,
    budget: limits.budget,
    windows,
    blocked: blocking !== null,
    blockedWindow: blocking?.hours ?? null,
    blockedUntil: blocking?.resetsAt ?? null
  };
}

/** What every provider has spent, and whether any of them is over. */
export async function getUsageStatus(
  providers: AiProvider[],
  now: Date = new Date()
): Promise<UsageStatus> {
  const statuses: ProviderUsageStatus[] = [];

  for (const provider of providers) {
    const limits = provider.usageLimits;
    // A provider in smart mode that ignores the hard windows is judged by
    // the plan's own wall, not by ours.
    const smartOnly =
      limits.mode === "smart" && limits.smart.ignoreHardWindows;

    if (!limits.enabled || smartOnly) {
      statuses.push({
        providerId: provider.id,
        label: provider.label,
        enabled: limits.enabled,
        budget: limits.budget,
        windows: [],
        blocked: false,
        blockedWindow: null,
        blockedUntil: null
      });
      continue;
    }
    statuses.push(await getProviderUsage(provider, now));
  }

  return {
    providers: statuses,
    blocked: statuses.some((status) => status.blocked)
  };
}

/**
 * A short-lived cache.
 *
 * The worker checks the usage on every tick, and the check is a SUM over the
 * event table. A few seconds of staleness does not matter for a limit that is
 * measured in thousands of tokens.
 */
let cached: { at: number; status: UsageStatus } | null = null;
const CACHE_MS = 10_000;

/** The usage status, from the cache when it is fresh enough. */
export async function getCachedUsageStatus(
  providers: AiProvider[],
  now: Date = new Date()
): Promise<UsageStatus> {
  const nowMs = now.getTime();
  if (cached && nowMs - cached.at < CACHE_MS) {
    return cached.status;
  }

  const status = await getUsageStatus(providers, now);
  cached = { at: nowMs, status };
  return status;
}

/** Forget the cached usage — used when the limits change. */
export function invalidateUsageCache(): void {
  cached = null;
}
