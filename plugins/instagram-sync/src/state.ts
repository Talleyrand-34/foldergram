/**
 * Run state, persisted in the existing `app_settings` key/value store.
 *
 * v1 has a single configured source and no per-source history, so the whole
 * state fits in one JSON blob. That keeps the plugin out of the server's
 * migration path entirely.
 */

import { appSettingsRepository } from "../../../server/dist/db/repositories.js";

export const INSTAGRAM_SYNC_LAST_RUN_SETTING_KEY = "instagram_sync.last_run";
export const INSTAGRAM_SYNC_GALLERY_DL_VERSION_SETTING_KEY = "instagram_sync.gallery_dl_version";
export const INSTAGRAM_SYNC_POLL_RUN_SETTING_KEY = "instagram_sync.poll_run";
export const INSTAGRAM_SYNC_DEEP_SCAN_SETTING_KEY = "instagram_sync.deep_scan";

export type SyncStatus =
  | "ok"
  | "failed"
  | "skipped"
  | "session-expired"
  /**
   * The sync worked but the download archive could not be used. The files are
   * still deduped by the on-disk check, so nothing was downloaded twice.
   */
  | "archive-unavailable"
  | "error";

export interface SyncRunState {
  at: string | null;
  status: SyncStatus;
  downloaded: number;
  /** The absolute paths that came down, so the mirror can reach them. */
  downloadedPaths?: string[];
  skipped: number;
  /**
   * True when the extractor stopped early because it had skipped enough
   * files in a row.
   *
   * gallery-dl swallows the abort and exits 0, so without this the run would
   * claim to have finished when it only gave up.
   */
  stoppedEarly: boolean;
  error: string | null;
  durationMs: number | null;
}

export const EMPTY_RUN_STATE: SyncRunState = {
  at: null,
  status: "skipped",
  downloaded: 0,
  skipped: 0,
  stoppedEarly: false,
  error: null,
  durationMs: null
};

function isSyncStatus(value: unknown): value is SyncStatus {
  return (
    value === "ok" ||
    value === "failed" ||
    value === "skipped" ||
    value === "session-expired" ||
    value === "archive-unavailable" ||
    value === "error"
  );
}

/** Read the last run. Tolerates a missing or corrupt value. */
export async function readLastRun(): Promise<SyncRunState> {
  const raw = await appSettingsRepository.get(INSTAGRAM_SYNC_LAST_RUN_SETTING_KEY);
  if (!raw) return { ...EMPTY_RUN_STATE };

  try {
    const parsed = JSON.parse(raw) as Partial<SyncRunState>;
    return {
      at: typeof parsed.at === "string" ? parsed.at : null,
      status: isSyncStatus(parsed.status) ? parsed.status : "skipped",
      downloaded: typeof parsed.downloaded === "number" ? parsed.downloaded : 0,
      downloadedPaths: Array.isArray(parsed.downloadedPaths)
        ? parsed.downloadedPaths.filter((entry): entry is string => typeof entry === "string")
        : [],
      skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
      stoppedEarly: parsed.stoppedEarly === true,
      error: typeof parsed.error === "string" ? parsed.error : null,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : null
    };
  } catch {
    return { ...EMPTY_RUN_STATE };
  }
}

export async function writeLastRun(state: SyncRunState): Promise<void> {
  await appSettingsRepository.set(
    INSTAGRAM_SYNC_LAST_RUN_SETTING_KEY,
    JSON.stringify(state)
  );
}

// ---------------------------------------------------------------------------
// Poll state
// ---------------------------------------------------------------------------

export type PollStatus = "ok" | "failed" | "skipped" | "error" | "running";

/**
 * The outcome of one poll.
 *
 * A poll covers the general library and/or the saved collections, so the two
 * halves are reported separately: a poll that refreshed the library but could
 * not reach Instagram's collections is not a total failure.
 *
 * `running` is written when the poll starts, so the UI shows the poll that is
 * happening now rather than the previous one.
 */
export interface PollRunState {
  at: string | null;
  status: PollStatus;
  /** The general library was refreshed. */
  library: boolean;
  /** The saved collections were refreshed. */
  collections: boolean;
  /** How many collections were mirrored. */
  mirrored: number;
  /** How many collections the poll has to mirror; null until they are known. */
  mirroredTotal: number | null;
  /** The collection being mirrored right now. */
  currentCollection: string | null;
  /** The first error of the poll, when there was one. */
  error: string | null;
  durationMs: number | null;
}

export const EMPTY_POLL_STATE: PollRunState = {
  at: null,
  status: "skipped",
  library: false,
  collections: false,
  mirrored: 0,
  mirroredTotal: null,
  currentCollection: null,
  error: null,
  durationMs: null
};

function isPollStatus(value: unknown): value is PollStatus {
  return (
    value === "ok" ||
    value === "failed" ||
    value === "skipped" ||
    value === "error" ||
    value === "running"
  );
}

/** Read the last poll. Tolerates a missing or corrupt value. */
export async function readPollRun(): Promise<PollRunState> {
  const raw = await appSettingsRepository.get(INSTAGRAM_SYNC_POLL_RUN_SETTING_KEY);
  if (!raw) return { ...EMPTY_POLL_STATE };

  try {
    const parsed = JSON.parse(raw) as Partial<PollRunState>;
    return {
      at: typeof parsed.at === "string" ? parsed.at : null,
      status: isPollStatus(parsed.status) ? parsed.status : "skipped",
      library: parsed.library === true,
      collections: parsed.collections === true,
      mirrored: typeof parsed.mirrored === "number" ? parsed.mirrored : 0,
      mirroredTotal:
        typeof parsed.mirroredTotal === "number" ? parsed.mirroredTotal : null,
      currentCollection:
        typeof parsed.currentCollection === "string" ? parsed.currentCollection : null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : null
    };
  } catch {
    return { ...EMPTY_POLL_STATE };
  }
}

export async function writePollRun(state: PollRunState): Promise<void> {
  await appSettingsRepository.set(
    INSTAGRAM_SYNC_POLL_RUN_SETTING_KEY,
    JSON.stringify(state)
  );
}

// ---------------------------------------------------------------------------
// The intensive scan request
// ---------------------------------------------------------------------------

/**
 * A request for an **intensive** scan.
 *
 * The normal runs use a small `-A` budget: gallery-dl stops the extractor
 * after that many files in a row were skipped, because the list is ordered
 * newest first and the new posts are reached before any skip. That early
 * exit is a *false "finished"*: gallery-dl swallows the abort and exits 0,
 * so a run that gave up looks exactly like a run that finished.
 *
 * When something did not go well, the next run walks much further before it
 * decides that it is caught up. The request is remembered, so it survives a
 * restart — the state that asked for it is gone otherwise.
 */
export interface DeepScanState {
  /** The library sync must run intensively. */
  library: boolean;
  /** The collections must be enumerated intensively. */
  collections: boolean;
  /** Why the intensive scan was asked for. */
  reason: string | null;
  /** When it was asked for. */
  requestedAt: string | null;
  /**
   * True when the last run of that scope went wrong.
   *
   * This is what keeps the poll out of the slow mode: a fault that was
   * already there when the intensive scan ran has had its remedy, so asking
   * again would leave every poll intensive — slower than the fault it was
   * meant to cure.
   */
  libraryFaulted: boolean;
  collectionsFaulted: boolean;
}

export const EMPTY_DEEP_SCAN_STATE: DeepScanState = {
  library: false,
  collections: false,
  reason: null,
  requestedAt: null,
  libraryFaulted: false,
  collectionsFaulted: false
};

/** Read the intensive-scan request. Tolerates a missing or corrupt value. */
export async function readDeepScanState(): Promise<DeepScanState> {
  const raw = await appSettingsRepository.get(INSTAGRAM_SYNC_DEEP_SCAN_SETTING_KEY);
  if (!raw) return { ...EMPTY_DEEP_SCAN_STATE };

  try {
    const parsed = JSON.parse(raw) as Partial<DeepScanState>;
    return {
      library: parsed.library === true,
      collections: parsed.collections === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : null,
      libraryFaulted: parsed.libraryFaulted === true,
      collectionsFaulted: parsed.collectionsFaulted === true
    };
  } catch {
    return { ...EMPTY_DEEP_SCAN_STATE };
  }
}

export async function writeDeepScanState(state: DeepScanState): Promise<void> {
  await appSettingsRepository.set(
    INSTAGRAM_SYNC_DEEP_SCAN_SETTING_KEY,
    JSON.stringify(state)
  );
}

/**
 * Ask for an intensive scan.
 *
 * The reason is kept, because "why is this poll walking the whole list?"
 * is the first question an operator asks.
 */
export async function requestDeepScan(
  state: DeepScanState,
  scope: "library" | "collections",
  reason: string
): Promise<DeepScanState> {
  const next: DeepScanState = {
    ...state,
    [scope]: true,
    reason,
    requestedAt: new Date().toISOString()
  };
  await writeDeepScanState(next);
  return next;
}

/**
 * The intensive scan is done — clear the request.
 *
 * The scope is cleared only when it was the one that ran, so a failed run
 * leaves the request standing.
 */
export async function clearDeepScan(
  state: DeepScanState,
  scope: "library" | "collections"
): Promise<DeepScanState> {
  if (!state[scope]) return state;

  const next: DeepScanState = { ...state, [scope]: false };
  if (!next.library && !next.collections) {
    next.reason = null;
    next.requestedAt = null;
  }
  await writeDeepScanState(next);
  return next;
}

/**
 * Settle the intensive-scan request after a run.
 *
 * The request is **consumed** by the run that used it: that run went
 * intensively, so the next one need not.
 *
 * A fault asks for an intensive scan — but only when it is **new**. A fault
 * that was already there when the intensive scan ran has had its remedy, and
 * asking again would leave every poll in the slow mode, which is worse than
 * the fault it was meant to cure.
 */
export async function settleDeepScan(
  scope: "library" | "collections",
  faulted: boolean,
  reason: string
): Promise<DeepScanState> {
  const state = await readDeepScanState();
  const faultFlag = scope === "library" ? "libraryFaulted" : "collectionsFaulted";
  const wasFaulted = state[faultFlag];

  // The request has been used by the run that just finished.
  const consumed = await clearDeepScan(state, scope);

  if (!faulted) {
    // A clean run ends the episode: the next fault asks for a scan again.
    const next = { ...consumed, [faultFlag]: false } as DeepScanState;
    await writeDeepScanState(next);
    return next;
  }

  if (wasFaulted) {
    // Not a new fault: the intensive scan has already had its turn.
    const next = { ...consumed, [faultFlag]: true } as DeepScanState;
    await writeDeepScanState(next);
    return next;
  }

  const requested = await requestDeepScan(consumed, scope, reason);
  const next = { ...requested, [faultFlag]: true } as DeepScanState;
  await writeDeepScanState(next);
  return next;
}

/**
 * The installed gallery-dl version. Read from disk rather than the running
 * process, because the file is the source of truth after an update.
 */
export async function readStoredGalleryDlVersion(): Promise<string | null> {
  const value = await appSettingsRepository.get(INSTAGRAM_SYNC_GALLERY_DL_VERSION_SETTING_KEY);
  return value && value.trim() ? value.trim() : null;
}

export async function writeStoredGalleryDlVersion(version: string): Promise<void> {
  await appSettingsRepository.set(INSTAGRAM_SYNC_GALLERY_DL_VERSION_SETTING_KEY, version);
}
