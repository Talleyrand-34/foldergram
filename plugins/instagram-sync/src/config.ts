/**
 * Configuration for the instagram-sync plugin.
 *
 * Everything here is the *environment* surface: the plugin's own settings
 * (what a poll covers, how often it runs) live in the database and are edited
 * from the plugin's UI — see `pollConfig.ts`.
 *
 * Every value has an env override so the plugin can be tuned without a code
 * change. The cookie and archive files are the ones the shell script this
 * plugin replaces (`insta.sh` on `pvei`) used; the `-A` budget is smaller,
 * because the early-exit it buys is only worth it when it is reached
 * quickly.
 */

import path from "node:path";

import type { appConfig } from "../../../server/dist/config/env.js";

export interface InstagramSyncConfig {
  enabled: boolean;
  /** The Instagram saved-posts feed to sync. */
  sourceUrl: string;
  /**
   * `-A` budget for the saved-posts feed: abort the extractor after this many
   * consecutive skipped files. This is NOT a post cap — it is gallery-dl's
   * "you have caught up" early-exit.
   *
   * It is deliberately small. The feed is ordered newest first, so the new
   * posts are reached before any skip; a big budget only means the run walks
   * a long way down the list of things it already has, which costs time and
   * finds nothing.
   */
  abortAfterSkips: number;
  /**
   * The same budget for the collections.
   *
   * A collection is enumerated on its own, so a small budget is enough to
   * prove that nothing new is in it — and it makes the poll fast, because
   * enumerating a collection is the slow part.
   */
  abortAfterSkipsCollections: number;
  /**
   * The budget of an **intensive** scan.
   *
   * When a run did not go well, the next one walks much further down the
   * list before it decides that the queue is caught up. The feed keeps a
   * budget even here — the list is long enough that walking all of it would
   * outrun the timeout.
   */
  abortAfterSkipsDeep: number;
  /** Hard cap on a single gallery-dl run. */
  timeoutMinutes: number;
  /** gallery-dl versions below this cannot resolve Instagram usernames. */
  minGalleryDlVersion: string;
  /** Working set root. Lives inside the gallery mount, in a hidden dir. */
  workDir: string;
  /** Netscape cookie file (live Instagram session). */
  cookieFile: string;
  /** SQLite download-archive ledger. */
  archiveFile: string;
  /** Root of the vendored, versioned gallery-dl installs. */
  galleryDlDir: string;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_SOURCE_URL = "https://www.instagram.com/rodantes_6/saved/";
export const MIN_GALLERY_DL_VERSION = "1.32.17";

export function loadConfig(config: typeof appConfig): InstagramSyncConfig {
  const workDir = process.env.INSTAGRAM_SYNC_WORK_DIR
    ? path.resolve(process.env.INSTAGRAM_SYNC_WORK_DIR)
    : path.join(config.galleryRoot, ".instagram-sync");

  return {
    enabled: readBoolean(process.env.INSTAGRAM_SYNC_ENABLED, true),
    sourceUrl: process.env.INSTAGRAM_SYNC_SOURCE_URL?.trim() || DEFAULT_SOURCE_URL,
    abortAfterSkips: readPositiveInt(process.env.INSTAGRAM_SYNC_ABORT_AFTER_SKIPS, 30),
    abortAfterSkipsCollections: readPositiveInt(
      process.env.INSTAGRAM_SYNC_ABORT_AFTER_SKIPS_COLLECTIONS,
      10
    ),
    abortAfterSkipsDeep: readPositiveInt(
      process.env.INSTAGRAM_SYNC_ABORT_AFTER_SKIPS_DEEP,
      3000
    ),
    timeoutMinutes: readPositiveInt(process.env.INSTAGRAM_SYNC_TIMEOUT_MINUTES, 45),
    minGalleryDlVersion:
      process.env.INSTAGRAM_SYNC_MIN_GALLERY_DL_VERSION?.trim() || MIN_GALLERY_DL_VERSION,
    workDir,
    cookieFile: path.join(workDir, "cookies.txt"),
    archiveFile: path.join(workDir, "archive.sqlite"),
    galleryDlDir: path.join(workDir, "gallery-dl")
  };
}
