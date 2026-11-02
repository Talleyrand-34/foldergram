/**
 * Configuration for the instagram-sync plugin.
 *
 * Every value has an env override so the plugin can be tuned without a code
 * change. Defaults are chosen to match the shell script this plugin replaces
 * (`insta.sh` on `pvei`): the same saved-posts feed, the same `-A 300`
 * skip-abort budget, and the same cookie/archive files.
 */

import path from "node:path";

import type { appConfig } from "../../../server/dist/config/env.js";

export interface InstagramSyncConfig {
  enabled: boolean;
  /** 5-field cron expression driving the internal scheduler. */
  cron: string;
  /** The Instagram saved-posts feed to sync. */
  sourceUrl: string;
  /**
   * `-A` budget: abort the extractor after this many consecutive skipped
   * files. This is NOT a post cap — it is gallery-dl's "you have caught up"
   * early-exit. 300 matches the original script.
   */
  abortAfterSkips: number;
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
export const DEFAULT_CRON = "17 */6 * * *";
export const MIN_GALLERY_DL_VERSION = "1.32.17";

export function loadConfig(config: typeof appConfig): InstagramSyncConfig {
  const workDir = process.env.INSTAGRAM_SYNC_WORK_DIR
    ? path.resolve(process.env.INSTAGRAM_SYNC_WORK_DIR)
    : path.join(config.galleryRoot, ".instagram-sync");

  return {
    enabled: readBoolean(process.env.INSTAGRAM_SYNC_ENABLED, true),
    cron: process.env.INSTAGRAM_SYNC_CRON?.trim() || DEFAULT_CRON,
    sourceUrl: process.env.INSTAGRAM_SYNC_SOURCE_URL?.trim() || DEFAULT_SOURCE_URL,
    abortAfterSkips: readPositiveInt(process.env.INSTAGRAM_SYNC_ABORT_AFTER_SKIPS, 300),
    timeoutMinutes: readPositiveInt(process.env.INSTAGRAM_SYNC_TIMEOUT_MINUTES, 45),
    minGalleryDlVersion:
      process.env.INSTAGRAM_SYNC_MIN_GALLERY_DL_VERSION?.trim() || MIN_GALLERY_DL_VERSION,
    workDir,
    cookieFile: path.join(workDir, "cookies.txt"),
    archiveFile: path.join(workDir, "archive.sqlite"),
    galleryDlDir: path.join(workDir, "gallery-dl")
  };
}
