/**
 * Reading a provider's shared plan.
 *
 * A paid plan is often shared: the same MiniMax Token Plan may serve a
 * person's editor assistant and foldergram's bulk analysis at the same time.
 * The plan knows how much *everybody* has used — MiniMax publishes it at
 * `/v1/token_plan/remains` — and that is the only way to tell "the pool is
 * mine" from "somebody else is in here".
 *
 * The reading has the shape:
 *
 * ```json
 * {
 *   "model_remains": [
 *     {
 *       "model_name": "MiniMax-M3",
 *       "start_time": 1788264000000,
 *       "end_time": 1788282000000,
 *       "current_interval_total_count": 100000,
 *       "current_interval_usage_count": 91000,
 *       "current_interval_remaining_percent": 91,
 *       "weekly_start_time": 1787688000000,
 *       "weekly_end_time": 1788292800000,
 *       "current_weekly_total_count": 300000,
 *       "current_weekly_usage_count": 210000,
 *       "current_weekly_remaining_percent": 70
 *     }
 *   ]
 * }
 * ```
 *
 * The interval window is the plan's own five-hour window; the weekly one is
 * the plan's week. `end_time` is the moment the window rolls over — "the time
 * left".
 */

import type { AiProvider } from "../config.js";

/** One of the plan's windows. */
export interface PoolWindow {
  /** Which window this is: the plan's interval, or its week. */
  kind: "interval" | "weekly";
  /** The plan's allowance for this window. */
  total: number;
  /** How much of it is used — by everybody, not only by us. */
  used: number;
  /** The share left, as a percentage. */
  remainingPercent: number;
  /** When the window starts, in epoch milliseconds. */
  startTime: number;
  /** When the window ends, in epoch milliseconds. */
  endTime: number;
}

/** What a pool reading says. */
export interface PoolState {
  /** The provider the pool belongs to. */
  providerId: string;
  /** True when the pool could be read. */
  ok: boolean;
  /** Why it could not be read, if it could not. */
  error: string | null;
  /** The model the rows belong to. */
  model: string | null;
  /** The windows the plan reports. */
  windows: PoolWindow[];
  /** When the reading was taken, in epoch milliseconds. */
  readAt: number;
}

/** The empty reading, used when the pool cannot be read. */
export function emptyPoolState(providerId: string, error: string): PoolState {
  return {
    providerId,
    ok: false,
    error,
    model: null,
    windows: [],
    readAt: Date.now()
  };
}

/**
 * The endpoint that reports the plan.
 *
 * MiniMax's is `/v1/token_plan/remains`. A provider that reaches MiniMax
 * through a gateway has to say so, because the gateway holds the key and does
 * not proxy the plan's endpoint.
 */
export function resolveProbeUrl(provider: AiProvider): string {
  const configured = provider.usageLimits.smart.probeUrl.trim();
  if (configured) return configured;

  if (provider.dialect === "minimax") {
    return `${provider.baseUrl.replace(/\/+$/, "")}/token_plan/remains`;
  }
  return "";
}

/** The key the plan is read with. */
export function resolveProbeKey(provider: AiProvider): string {
  const configured = provider.usageLimits.smart.probeApiKey.trim();
  if (configured) return configured;
  return provider.apiKey;
}

/** One row of the plan's answer. */
interface PlanRow {
  model_name?: string;
  start_time?: number;
  end_time?: number;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Turn the plan's answer into windows.
 *
 * The rows are per model, so the row that belongs to the provider's own model
 * is the one that counts. When the model is not named, the first row with a
 * window is used — the plan counts the same way for all of them.
 */
export function parsePoolState(
  providerId: string,
  body: unknown,
  wantedModel: string
): PoolState {
  const rows = (body as { model_remains?: PlanRow[] } | null)?.model_remains;
  if (!Array.isArray(rows) || rows.length === 0) {
    return emptyPoolState(providerId, "the plan reported no windows");
  }

  const named = rows.find((row) => row.model_name === wantedModel);
  const row = named ?? rows.find((entry) => numberOr(entry.end_time) > 0) ?? rows[0];

  const windows: PoolWindow[] = [];

  const intervalTotal = numberOr(row.current_interval_total_count);
  const intervalUsed = numberOr(row.current_interval_usage_count);
  if (intervalTotal > 0 && numberOr(row.end_time) > 0) {
    windows.push({
      kind: "interval",
      total: intervalTotal,
      used: intervalUsed,
      remainingPercent: numberOr(
        row.current_interval_remaining_percent,
        intervalTotal > 0 ? Math.round(((intervalTotal - intervalUsed) / intervalTotal) * 1000) / 10 : 0
      ),
      startTime: numberOr(row.start_time),
      endTime: numberOr(row.end_time)
    });
  }

  const weeklyTotal = numberOr(row.current_weekly_total_count);
  const weeklyUsed = numberOr(row.current_weekly_usage_count);
  if (weeklyTotal > 0 && numberOr(row.weekly_end_time) > 0) {
    windows.push({
      kind: "weekly",
      total: weeklyTotal,
      used: weeklyUsed,
      remainingPercent: numberOr(
        row.current_weekly_remaining_percent,
        weeklyTotal > 0 ? Math.round(((weeklyTotal - weeklyUsed) / weeklyTotal) * 1000) / 10 : 0
      ),
      startTime: numberOr(row.weekly_start_time),
      endTime: numberOr(row.weekly_end_time)
    });
  }

  if (windows.length === 0) {
    return emptyPoolState(providerId, "the plan reported no usable window");
  }

  return {
    providerId,
    ok: true,
    error: null,
    model: row.model_name ?? null,
    windows,
    readAt: Date.now()
  };
}

/**
 * Read the plan.
 *
 * A read-only GET. The endpoint needs no group and spends nothing — it only
 * reports the counters.
 */
export async function readPool(provider: AiProvider): Promise<PoolState> {
  const url = resolveProbeUrl(provider);
  if (!url) {
    return emptyPoolState(
      provider.id,
      "no plan endpoint is configured for this provider"
    );
  }

  const key = resolveProbeKey(provider);
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000)
    });

    const text = await response.text();
    if (!response.ok) {
      return emptyPoolState(
        provider.id,
        `the plan endpoint answered ${response.status}: ${text.slice(0, 200)}`
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return emptyPoolState(provider.id, "the plan endpoint answered with no JSON");
    }

    // The plan answers with a status of its own inside a 200.
    const status = (body as { base_resp?: { status_code?: number; status_msg?: string } })
      ?.base_resp;
    if (status && numberOr(status.status_code, 0) !== 0) {
      return emptyPoolState(
        provider.id,
        `the plan endpoint refused: ${status.status_msg ?? status.status_code}`
      );
    }

    return parsePoolState(provider.id, body, provider.defaultModel);
  } catch (e) {
    return emptyPoolState(
      provider.id,
      `the plan endpoint could not be reached: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
