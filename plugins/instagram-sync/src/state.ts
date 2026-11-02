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

export type SyncStatus = "ok" | "failed" | "skipped" | "session-expired" | "error";

export interface SyncRunState {
  at: string | null;
  status: SyncStatus;
  downloaded: number;
  skipped: number;
  error: string | null;
  durationMs: number | null;
}

export const EMPTY_RUN_STATE: SyncRunState = {
  at: null,
  status: "skipped",
  downloaded: 0,
  skipped: 0,
  error: null,
  durationMs: null
};

function isSyncStatus(value: unknown): value is SyncStatus {
  return (
    value === "ok" ||
    value === "failed" ||
    value === "skipped" ||
    value === "session-expired" ||
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
      skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
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
