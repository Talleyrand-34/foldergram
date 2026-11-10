/**
 * Persistence for the polling configuration.
 *
 * The configuration lives in the existing `app_settings` key/value store as
 * one JSON blob, the same way the plugin's run state is stored — that keeps
 * the plugin out of the server's migration path entirely.
 *
 * The value is cached in memory: the scheduler reads it on every tick, and
 * the UI is the only writer.
 */

import { appSettingsRepository } from "../../../server/dist/db/repositories.js";

import {
  INSTAGRAM_SYNC_POLL_SETTING_KEY,
  defaultPollConfig,
  normalizePollConfig,
  type PollConfig
} from "./pollConfig.js";

let cached: PollConfig | null = null;

/** The configuration as it is in memory, or null before it has been read. */
export function cachedPollConfig(): PollConfig | null {
  return cached;
}

/** Replace the in-memory copy without touching the database. */
export function setCachedPollConfig(config: PollConfig): void {
  cached = normalizePollConfig(config);
}

/** Read the configuration. The result is cached — the UI is the only writer. */
export async function readPollConfig(): Promise<PollConfig> {
  if (cached) return cached;

  const raw = await appSettingsRepository.get(INSTAGRAM_SYNC_POLL_SETTING_KEY);
  if (!raw) {
    cached = defaultPollConfig();
    return cached;
  }

  try {
    cached = normalizePollConfig(JSON.parse(raw));
  } catch {
    cached = defaultPollConfig();
  }
  return cached;
}

/** Persist the configuration and refresh the in-memory copy. */
export async function writePollConfig(config: PollConfig): Promise<PollConfig> {
  const normalized = normalizePollConfig(config);
  await appSettingsRepository.set(
    INSTAGRAM_SYNC_POLL_SETTING_KEY,
    JSON.stringify(normalized)
  );
  cached = normalized;
  return normalized;
}
