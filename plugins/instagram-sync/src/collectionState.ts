/**
 * Per-collection sync status, persisted in the existing `app_settings` store.
 *
 * Each Instagram saved collection keeps its own record: how many posts it
 * holds, how many of them are in the library, what the last mirror did, and
 * when. The map is keyed by the Instagram collection id, so a renamed
 * collection keeps its history.
 *
 * One JSON blob keeps this out of the server's migration path, the same way the
 * plugin's run state is stored.
 */

import { appSettingsRepository } from "../../../server/dist/db/repositories.js";

export const INSTAGRAM_SYNC_COLLECTIONS_SETTING_KEY = "instagram_sync.collections";

/**
 * - `never`   — the collection has not been mirrored yet
 * - `ok`      — every post is in the library
 * - `partial` — some posts are not in the library yet
 * - `failed`  — the last mirror of this collection failed
 */
export type CollectionSyncStatus = "never" | "ok" | "partial" | "failed";

export interface CollectionState {
  /** The collection's name at the time of the last mirror. */
  name: string;
  /** How many posts the collection holds. */
  mediaCount: number;
  /** How many of them are in the library. */
  syncedCount: number;
  /** How many are not in the library yet. */
  missingCount: number;
  /** How many images were added to the collection by the last mirror. */
  addedCount: number;
  status: CollectionSyncStatus;
  /** ISO timestamp of the last mirror. */
  lastSyncedAt: string | null;
  /** The last failure, when there was one. */
  lastError: string | null;
}

export type CollectionStates = Record<string, CollectionState>;

export const EMPTY_COLLECTION_STATE: CollectionState = {
  name: "",
  mediaCount: 0,
  syncedCount: 0,
  missingCount: 0,
  addedCount: 0,
  status: "never",
  lastSyncedAt: null,
  lastError: null
};

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toStatus(value: unknown): CollectionSyncStatus {
  return value === "ok" || value === "partial" || value === "failed" ? value : "never";
}

function parseState(value: unknown): CollectionState {
  const raw = (value ?? {}) as Partial<CollectionState>;
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    mediaCount: toNumber(raw.mediaCount),
    syncedCount: toNumber(raw.syncedCount),
    missingCount: toNumber(raw.missingCount),
    addedCount: toNumber(raw.addedCount),
    status: toStatus(raw.status),
    lastSyncedAt: typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null
  };
}

/** Every collection's status, keyed by Instagram collection id. */
export async function readCollectionStates(): Promise<CollectionStates> {
  const raw = await appSettingsRepository.get(INSTAGRAM_SYNC_COLLECTIONS_SETTING_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const states: CollectionStates = {};
    for (const [id, value] of Object.entries(parsed)) {
      states[id] = parseState(value);
    }
    return states;
  } catch {
    return {};
  }
}

/** Record one collection's status, keeping the other collections' records. */
export async function writeCollectionState(
  id: string,
  state: CollectionState
): Promise<void> {
  const states = await readCollectionStates();
  states[id] = state;
  await appSettingsRepository.set(
    INSTAGRAM_SYNC_COLLECTIONS_SETTING_KEY,
    JSON.stringify(states)
  );
}
