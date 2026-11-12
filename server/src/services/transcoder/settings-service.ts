import { z } from 'zod';

import { appConfig } from '../../config/env.js';
import { appSettingsRepository } from '../../db/repositories.js';
import { log } from '../log-service.js';

/**
 * The transcoder configuration as the Settings page stores it.
 *
 * The environment variables are the starting point: a deployment that sets
 * `FFMPEG_TRANSCODER_URL` works out of the box, and the Settings page shows
 * those values as the current configuration. From there the administrator
 * can turn the external transcoder off, move it to another host or change
 * how much work it takes.
 *
 * The token is never sent to the browser. The read path replaces it with a
 * flag, and the write path tells an absent token (keep the stored one) from
 * an empty one (clear it).
 */

export const TRANSCODER_SETTING_KEY = 'transcoder.config';

/** The kinds of work that can be delegated. */
export const TRANSCODER_OPERATIONS = [
  'video-preview',
  'video-thumbnail',
  'animated-avif-preview',
  'animated-avif-thumbnail',
  'ai-audio'
] as const;

export type TranscoderOperation = (typeof TRANSCODER_OPERATIONS)[number];

const transcoderSettingsSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(2048),
  token: z.string().max(512),
  encoder: z.enum(['auto', 'vaapi', 'software']),
  operations: z.array(z.string().max(64)),
  fallback: z.enum(['local', 'off']),
  maxUploadBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

export interface TranscoderSettings {
  /** Whether the external transcoder may be used at all. */
  enabled: boolean;
  /** Base URL of the agent. */
  url: string;
  /** Shared secret. Never leaves the server. */
  token: string;
  /** Which encoder the agent should use. */
  encoder: 'auto' | 'vaapi' | 'software';
  /** The kinds of work that may leave the host. `*` means all of them. */
  operations: string[];
  /** What happens when the agent cannot do the job. */
  fallback: 'local' | 'off';
  /** Sources larger than this stay on this host. */
  maxUploadBytes: number;
}

/** The settings as the browser sees them. */
export interface TranscoderSettingsView extends Omit<TranscoderSettings, 'token'> {
  /** Whether a token is stored. */
  tokenSet: boolean;
}

let cached: TranscoderSettings | null = null;

/** The configuration the environment describes. */
export function envTranscoderSettings(): TranscoderSettings {
  return {
    enabled: appConfig.ffmpegTranscoderMode !== 'local' && Boolean(appConfig.ffmpegTranscoderUrl),
    url: appConfig.ffmpegTranscoderUrl ?? '',
    token: appConfig.ffmpegTranscoderToken ?? '',
    encoder: appConfig.ffmpegTranscoderEncoder,
    operations: [...appConfig.ffmpegTranscoderOperations],
    fallback: appConfig.ffmpegTranscoderFallback,
    maxUploadBytes: appConfig.ffmpegTranscoderMaxUploadBytes
  };
}

/** Fill in what a stored blob leaves out with the environment's values. */
function normalizeStoredSettings(value: unknown): TranscoderSettings | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const fallback = envTranscoderSettings();
  const candidate = {
    ...fallback,
    ...(value as Partial<TranscoderSettings>)
  };

  const parsed = transcoderSettingsSchema.safeParse({
    ...candidate,
    operations: Array.isArray(candidate.operations)
      ? candidate.operations.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
      : fallback.operations
  });

  return parsed.success ? parsed.data : null;
}

/**
 * The configuration in force.
 *
 * The stored configuration wins over the environment: the Settings page is
 * the place where the administrator decides. Without a stored configuration
 * the environment decides.
 */
export async function readTranscoderSettings(): Promise<TranscoderSettings> {
  if (cached) {
    return cached;
  }

  try {
    const raw = await appSettingsRepository.get(TRANSCODER_SETTING_KEY);
    cached = (raw ? normalizeStoredSettings(JSON.parse(raw)) : null) ?? envTranscoderSettings();
  } catch (error) {
    // A database that cannot be read must not stop the derivatives. The
    // environment is a good enough answer.
    log.error('Transcoder: the stored configuration could not be read', {
      error: error instanceof Error ? error.message : String(error)
    });
    cached = envTranscoderSettings();
  }

  return cached;
}

/**
 * Store the configuration.
 *
 * An absent token keeps the stored one; an empty token clears it.
 */
export async function writeTranscoderSettings(
  patch: Partial<TranscoderSettings> & { token?: string }
): Promise<TranscoderSettings> {
  const current = await readTranscoderSettings();
  const token = patch.token === undefined ? current.token : patch.token.trim();

  const next = normalizeStoredSettings({
    ...current,
    ...patch,
    token,
    operations: patch.operations ?? current.operations
  });

  if (!next) {
    throw new Error('The transcoder configuration is not valid.');
  }

  await appSettingsRepository.set(TRANSCODER_SETTING_KEY, JSON.stringify(next));
  cached = next;

  return next;
}

/** Forget the cached configuration. Used by tests. */
export function resetTranscoderSettingsCache(): void {
  cached = null;
}

/** The configuration without the secret. */
export function toTranscoderSettingsView(settings: TranscoderSettings): TranscoderSettingsView {
  const { token, ...rest } = settings;

  return {
    ...rest,
    tokenSet: token.length > 0
  };
}
