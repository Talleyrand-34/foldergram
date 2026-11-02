/**
 * Typed client for the instagram-sync plugin's REST endpoints.
 *
 * Endpoints (all under /api/plugins/instagram-sync):
 *   GET  /status             → plugin status snapshot
 *   POST /run                → start a sync run now (409 when one is already running)
 *   POST /cookie             → upload a Netscape cookie file (raw text/plain body)
 *   GET  /gallery-dl/check   → gallery-dl version known to the server
 *   POST /gallery-dl/update  → install the latest gallery-dl
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
  error: string | null;
  durationMs: number | null;
}

export interface InstagramSyncStatus {
  enabled: boolean;
  sourceUrl: string;
  cron: string | null;
  nextRunAt: string | null;
  galleryDl: InstagramGalleryDlState;
  cookie: InstagramCookieState;
  archive: InstagramArchiveState;
  lastRun: InstagramSyncRun | null;
  /** True while the server is executing a sync run. Optional: absent on
   *  servers that only report the last completed run. */
  running?: boolean;
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

/** One of the user's Instagram saved collections ("sub-folders" of saved). */
export interface InstagramCollection {
  id: string;
  name: string;
  /** Instagram's own type, e.g. "MediaCollection". */
  type: string;
  /** True for Instagram's catch-all "All posts" pseudo-collection. */
  isAuto: boolean;
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
): Promise<InstagramCollectionSyncResult> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  return await requestJson<InstagramCollectionSyncResult>(
    `${INSTAGRAM_SYNC_BASE_PATH}/collections/sync${query}`,
    { method: 'POST' },
  );
}

export async function updateGalleryDl(): Promise<InstagramGalleryDlUpdateResult> {
  return await requestJson<InstagramGalleryDlUpdateResult>(
    `${INSTAGRAM_SYNC_BASE_PATH}/gallery-dl/update`,
    { method: 'POST' },
  );
}
