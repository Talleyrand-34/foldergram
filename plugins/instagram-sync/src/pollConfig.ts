/**
 * The polling configuration — what a poll refreshes, how often, and which
 * saved collections are in scope.
 *
 * The schedule is first-class: it lives in `app_settings` and is edited from
 * the plugin's UI, not baked into the environment.
 *
 * What a poll covers:
 *
 *   - the **general library** — the saved-posts feed, downloaded by gallery-dl
 *     and handed to the scanner, so new posts land in the library;
 *   - the **saved collections** — Instagram's named sub-collections, mirrored
 *     into library collections of the same name.
 *
 * Either half can be switched off, and the collections can be narrowed to a
 * selection instead of all of them.
 *
 * One global configuration, not one per user: the plugin has a single
 * Instagram session (one cookie, one source feed) that the whole library
 * shares.
 *
 * This module is pure — the persistence lives in `pollStore.ts`.
 */

export const INSTAGRAM_SYNC_POLL_SETTING_KEY = "instagram_sync.poll_config";

/** Which saved collections a poll covers. */
export type PollCollectionMode = "all" | "selected";

export interface PollConfig {
  /** Is the polling on at all? */
  enabled: boolean;
  /** How many minutes pass between two polls. */
  intervalMinutes: number;
  /** Refresh the general library. */
  library: boolean;
  /** Refresh the saved collections. */
  collections: boolean;
  /** Every saved collection, or only the selected ones. */
  collectionMode: PollCollectionMode;
  /** The Instagram ids of the selected collections. */
  collectionIds: string[];
  /** Their names, kept alongside the ids for display. */
  collectionNames: string[];
}

/** Below this, polling Instagram is pointless and rude. */
export const MIN_POLL_INTERVAL_MINUTES = 15;
/** A week — the longest sensible gap. */
export const MAX_POLL_INTERVAL_MINUTES = 7 * 24 * 60;
/** Four hours. */
export const DEFAULT_POLL_INTERVAL_MINUTES = 240;

/** The configuration a fresh install starts with. */
export function defaultPollConfig(): PollConfig {
  return {
    enabled: true,
    intervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
    library: true,
    collections: true,
    collectionMode: "all",
    collectionIds: [],
    collectionNames: []
  };
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

/** Clamp an interval into the supported range. */
export function clampIntervalMinutes(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_INTERVAL_MINUTES;

  return Math.min(
    MAX_POLL_INTERVAL_MINUTES,
    Math.max(MIN_POLL_INTERVAL_MINUTES, Math.round(parsed))
  );
}

/**
 * Turn anything into a valid configuration.
 *
 * The stored value is user input (it comes back from the UI), so every field
 * is validated rather than trusted.
 */
export function normalizePollConfig(raw: unknown): PollConfig {
  const fallback = defaultPollConfig();
  if (!raw || typeof raw !== "object") return fallback;

  const value = raw as Partial<PollConfig>;
  return {
    enabled: toBoolean(value.enabled, fallback.enabled),
    intervalMinutes: clampIntervalMinutes(value.intervalMinutes),
    library: toBoolean(value.library, fallback.library),
    collections: toBoolean(value.collections, fallback.collections),
    collectionMode: value.collectionMode === "selected" ? "selected" : "all",
    collectionIds: toStringList(value.collectionIds),
    collectionNames: toStringList(value.collectionNames)
  };
}

/**
 * Apply a patch to the current configuration.
 *
 * Only the fields the patch actually carries are taken — a request that
 * leaves a field out must not reset it to the default.
 */
export function mergePollConfig(current: PollConfig, patch: unknown): PollConfig {
  const raw = (patch ?? {}) as Record<string, unknown>;
  const pick = <T>(key: string): T | undefined =>
    raw[key] === undefined ? undefined : (raw[key] as T);

  return normalizePollConfig({
    enabled: pick<boolean>("enabled") ?? current.enabled,
    intervalMinutes: pick<number>("intervalMinutes") ?? current.intervalMinutes,
    library: pick<boolean>("library") ?? current.library,
    collections: pick<boolean>("collections") ?? current.collections,
    collectionMode:
      pick<PollCollectionMode>("collectionMode") ?? current.collectionMode,
    collectionIds: pick<string[]>("collectionIds") ?? current.collectionIds,
    collectionNames: pick<string[]>("collectionNames") ?? current.collectionNames
  });
}

/**
 * Is this interval usable? The UI rejects anything outside the range instead
 * of letting the normalizer silently clamp it.
 */
export function isValidIntervalMinutes(value: unknown): boolean {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return false;

  return (
    Math.round(parsed) >= MIN_POLL_INTERVAL_MINUTES &&
    Math.round(parsed) <= MAX_POLL_INTERVAL_MINUTES
  );
}

/**
 * Which collections the poll should mirror.
 *
 * `null` means "every collection" — the mirror treats a null selection as
 * "all of them".
 */
export function pollCollectionSelection(config: PollConfig): {
  ids: string[];
  names: string[];
} | null {
  if (!config.collections) return null;
  if (config.collectionMode !== "selected") return null;

  return { ids: config.collectionIds, names: config.collectionNames };
}
