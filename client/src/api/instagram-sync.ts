/**
 * Typed client for the instagram-sync plugin's REST endpoints.
 *
 * Endpoints (all under /api/plugins/instagram-sync):
 *   GET  /status             → plugin status snapshot
 *   POST /run                → start a sync run now (409 when one is already running)
 *   POST /cookie             → upload a Netscape cookie file (raw text/plain body)
 *   GET  /gallery-dl/check   → gallery-dl version known to the server
 *   POST /gallery-dl/update  → install the latest gallery-dl
 *   GET  /poll               → the polling configuration and its state
 *   POST /poll               → change the polling configuration
 *   POST /poll/run           → start a poll now
 *
 * The cookie endpoint takes the cookie file verbatim as `text/plain`; it is
 * never sent as JSON and its contents are never echoed back by the server.
 */

import { requestJson } from './http.js';

export const INSTAGRAM_SYNC_BASE_PATH = '/api/plugins/instagram-sync';

export type InstagramSyncRunStatus =
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'session-expired'
  | 'archive-unavailable'
  | 'error';

export interface InstagramGalleryDlState {
  /** Installed version, or null when no gallery-dl is installed yet. */
  installed: string | null;
  /** Latest published version, or null when the PyPI lookup failed (offline). */
  latest: string | null;
  minRequired: string | null;
  updateAvailable: boolean;
}

export interface InstagramCookieState {
  present: boolean;
  valid: boolean;
  updatedAt: string | null;
}

export interface InstagramArchiveState {
  present: boolean;
  entries: number;
  sizeBytes: number;
}

export interface InstagramSyncRun {
  at: string | null;
  status: InstagramSyncRunStatus;
  downloaded: number;
  skipped: number;
  /**
   * True when the extractor stopped early because it had skipped enough
   * files in a row. gallery-dl swallows the abort and exits 0, so without
   * this the run would claim to have finished when it only gave up.
   */
  stoppedEarly?: boolean;
  error: string | null;
  durationMs: number | null;
}

/**
 * The early-exit budgets.
 *
 * gallery-dl stops the extractor after this many files in a row were
 * skipped. The budget is how far down the list a poll looks before it
 * decides that it is caught up.
 */
export interface InstagramScanBudgets {
  /** The saved-posts feed. */
  feed: number;
  /** One collection. */
  collections: number;
  /** The budget of an intensive scan. */
  intensive: number;
}

/**
 * A request for an intensive scan.
 *
 * It is asked for when a run did not go well, so the next one looks further
 * down the list than the last one did.
 */
export interface InstagramDeepScanState {
  library: boolean;
  collections: boolean;
  reason: string | null;
  requestedAt: string | null;
}

export interface InstagramSyncStatus {
  enabled: boolean;
  sourceUrl: string;
  nextRunAt: string | null;
  galleryDl: InstagramGalleryDlState;
  cookie: InstagramCookieState;
  archive: InstagramArchiveState;
  lastRun: InstagramSyncRun | null;
  /** The polling configuration and its last run. Optional: absent on servers
   *  that predate the polling configuration. */
  poll?: InstagramPollSummary;
  /** True while the server is executing a sync run. Optional: absent on
   *  servers that only report the last completed run. */
  running?: boolean;
  /** The early-exit budgets. Optional: absent on older servers. */
  budgets?: InstagramScanBudgets;
  /** The pending intensive-scan request. Optional: absent on older servers. */
  deepScan?: InstagramDeepScanState;
}

export interface InstagramGalleryDlCheck {
  latest: string | null;
  installed: string | null;
  updateAvailable: boolean;
}

/**
 * Acknowledgement of `POST /run`. The server confirms the run started and
 * keeps going in the background; some builds also echo the run's state.
 */
export interface InstagramSyncRunStarted {
  started?: boolean;
  at?: string | null;
  status?: InstagramSyncRunStatus;
  downloaded?: number;
  skipped?: number;
  error?: string | null;
  durationMs?: number | null;
}

export interface InstagramGalleryDlUpdateResult {
  updated: boolean;
  /** Populated when `updated` is true. */
  from?: string | null;
  to?: string | null;
  /** Populated when `updated` is false. */
  version?: string | null;
}

export interface InstagramCookieUploadResult {
  ok: boolean;
}

/** How a collection's last mirror went. */
export type InstagramCollectionSyncStatus = 'never' | 'ok' | 'partial' | 'failed';

/** The recorded status of one collection. */
export interface InstagramCollectionState {
  name: string;
  /** How many posts the collection holds. */
  mediaCount: number;
  /** How many of them are in the library. */
  syncedCount: number;
  /** How many are not in the library yet. */
  missingCount: number;
  /** How many images the last mirror added. */
  addedCount: number;
  status: InstagramCollectionSyncStatus;
  /** ISO timestamp of the last mirror. */
  lastSyncedAt: string | null;
  /** The last failure, when there was one. */
  lastError: string | null;
}

/** One of the user's Instagram saved collections ("sub-folders" of saved). */
export interface InstagramCollection {
  id: string;
  name: string;
  /** Instagram's own type, e.g. "MediaCollection". */
  type: string;
  /** True for Instagram's catch-all "All posts" pseudo-collection. */
  isAuto: boolean;
  /** What the last mirror of this collection did. Null until it is mirrored. */
  state: InstagramCollectionState | null;
}

export interface InstagramCollectionList {
  collections: InstagramCollection[];
}

/** What one mirrored collection ended up containing. */
export interface InstagramCollectionMirrorResult {
  name: string;
  instagramId: string;
  /** The Foldergram collection the media was put into. */
  collectionSlug: string | null;
  /** True when the Foldergram collection was created by the mirror. */
  collectionCreated: boolean;
  /** Media the collection holds according to Instagram. */
  mediaCount: number;
  /** How many of those are indexed in the library. */
  matchedCount: number;
  /** Media that is not in the library (not downloaded, or not indexed yet). */
  missingCount: number;
  /** A sample of the relative paths that could not be matched. */
  missingPaths: string[];
  /** How many images were added to the collection. */
  addedCount: number;
}

export interface InstagramCollectionSyncResult {
  results: InstagramCollectionMirrorResult[];
}

/** Acknowledgement of `POST /collections/sync` — the mirror runs in the background. */
export interface InstagramCollectionSyncStarted {
  started: boolean;
}

/**
 * How a poll ended.
 *
 * `skipped` means the poll had nothing to do — it is not a failure.
 * `running` means the poll is happening right now: it is written when the
 * poll starts, so the UI shows the current poll rather than the previous one.
 */
export type InstagramPollStatus = 'ok' | 'failed' | 'skipped' | 'error' | 'running';

/** Which saved collections a poll covers. */
export type InstagramPollCollectionMode = 'all' | 'selected';

/** What a poll refreshes, how often, and which collections are in scope. */
export interface InstagramPollConfig {
  /** Is the polling on? */
  enabled: boolean;
  /** How many minutes pass between two polls. */
  intervalMinutes: number;
  /** Refresh the general library. */
  library: boolean;
  /** Refresh the saved collections. */
  collections: boolean;
  /** Every saved collection, or only the selected ones. */
  collectionMode: InstagramPollCollectionMode;
  /** The Instagram ids of the selected collections. */
  collectionIds: string[];
  /** Their names, kept alongside the ids for display. */
  collectionNames: string[];
}

/** The outcome of one poll. */
export interface InstagramPollRun {
  at: string | null;
  status: InstagramPollStatus;
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
  error: string | null;
  durationMs: number | null;
}

/** The polling configuration as the server has it. */
export interface InstagramPollSummary {
  enabled: boolean;
  intervalMinutes: number;
  library: boolean;
  collections: boolean;
  collectionMode: InstagramPollCollectionMode;
  collectionIds: string[];
  collectionNames: string[];
  nextRunAt: string | null;
  lastRun: InstagramPollRun | null;
}

/** The polling configuration and its state. */
export interface InstagramPollState {
  config: InstagramPollConfig;
  nextRunAt: string | null;
  running: boolean;
  lastRun: InstagramPollRun | null;
  /** The interval range the server accepts. */
  limits: {
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
  };
}

/** The server's answer to a configuration change. */
export interface InstagramPollSaved {
  config: InstagramPollConfig;
  nextRunAt: string | null;
}

/** Acknowledgement of `POST /poll/run` — the poll runs in the background. */
export interface InstagramPollStarted {
  started: boolean;
}

/** The state of the background mirror job. */
export interface InstagramMirrorJob {
  running: boolean;
  /** What the job covers: "All collections" or a list of names. */
  selection?: string | null;
  /** The collection being mirrored, or null when idle. */
  name: string | null;
  /** The collection currently being enumerated. */
  currentCollection: string | null;
  /** Media found so far in the current collection. */
  mediaFound: number | null;
  /** Collections finished so far. */
  completedCount: number;
  /** Collections to mirror in this job, once they are known. */
  totalCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  results: InstagramCollectionMirrorResult[];
  error: string | null;
  /** Recent activity, oldest first. */
  log: string[];
}

export async function fetchInstagramSyncStatus(): Promise<InstagramSyncStatus> {
  return await requestJson<InstagramSyncStatus>(`${INSTAGRAM_SYNC_BASE_PATH}/status`);
}

export async function runInstagramSync(): Promise<InstagramSyncRunStarted> {
  return await requestJson<InstagramSyncRunStarted>(`${INSTAGRAM_SYNC_BASE_PATH}/run`, {
    method: 'POST',
  });
}

/**
 * Uploads a Netscape cookies.txt file. The body is the file's raw text; the
 * server validates it and never returns its contents.
 */
export async function uploadInstagramCookie(
  cookieText: string,
): Promise<InstagramCookieUploadResult> {
  return await requestJson<InstagramCookieUploadResult>(`${INSTAGRAM_SYNC_BASE_PATH}/cookie`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: cookieText,
  });
}

export async function checkGalleryDl(): Promise<InstagramGalleryDlCheck> {
  return await requestJson<InstagramGalleryDlCheck>(
    `${INSTAGRAM_SYNC_BASE_PATH}/gallery-dl/check`,
  );
}

/**
 * The user's Instagram saved collections. The server reads them through
 * Instagram's saved-collections API.
 */
export async function fetchInstagramCollections(): Promise<InstagramCollectionList> {
  return await requestJson<InstagramCollectionList>(`${INSTAGRAM_SYNC_BASE_PATH}/collections`);
}

/**
 * Mirror Instagram saved collections into Foldergram collections of the same
 * name. Pass `name` to mirror a single collection; omit it to mirror all of them.
 */
export async function syncInstagramCollections(
  name?: string,
): Promise<InstagramCollectionSyncStarted> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  return await requestJson<InstagramCollectionSyncStarted>(
    `${INSTAGRAM_SYNC_BASE_PATH}/collections/sync${query}`,
    { method: 'POST' },
  );
}

/** The state of the background mirror job. Poll this while a mirror is running. */
export async function fetchInstagramMirrorJob(): Promise<InstagramMirrorJob> {
  return await requestJson<InstagramMirrorJob>(`${INSTAGRAM_SYNC_BASE_PATH}/collections/sync`);
}

export async function updateGalleryDl(): Promise<InstagramGalleryDlUpdateResult> {
  return await requestJson<InstagramGalleryDlUpdateResult>(
    `${INSTAGRAM_SYNC_BASE_PATH}/gallery-dl/update`,
    { method: 'POST' },
  );
}

/**
 * The polling configuration and its state: what a poll refreshes, how often,
 * when the next one is due and how the last one went.
 */
export async function fetchInstagramPoll(): Promise<InstagramPollState> {
  return await requestJson<InstagramPollState>(`${INSTAGRAM_SYNC_BASE_PATH}/poll`);
}

/**
 * Change the polling configuration.
 *
 * Only the fields in the patch are changed; the rest is left alone.
 */
export async function saveInstagramPoll(
  patch: Partial<InstagramPollConfig>,
): Promise<InstagramPollSaved> {
  return await requestJson<InstagramPollSaved>(`${INSTAGRAM_SYNC_BASE_PATH}/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** Start a poll now, whatever the schedule says. */
export async function runInstagramPoll(): Promise<InstagramPollStarted> {
  return await requestJson<InstagramPollStarted>(`${INSTAGRAM_SYNC_BASE_PATH}/poll/run`, {
    method: 'POST',
  });
}
