import { log } from '../log-service.js';
import { LocalTranscoder } from './local-transcoder.js';
import { RemoteTranscoder, isWithinUploadLimit } from './remote-transcoder.js';
import {
  readTranscoderSettings,
  resetTranscoderSettingsCache,
  type TranscoderSettings
} from './settings-service.js';
import type { TranscodeRequest, Transcoder, TranscoderCapabilities } from './types.js';

export * from './types.js';
export { LocalTranscoder } from './local-transcoder.js';
export { RemoteTranscoder } from './remote-transcoder.js';
export {
  TRANSCODER_OPERATIONS,
  TRANSCODER_SETTING_KEY,
  envTranscoderSettings,
  readTranscoderSettings,
  resetTranscoderSettingsCache,
  toTranscoderSettingsView,
  writeTranscoderSettings
} from './settings-service.js';
export type {
  TranscoderOperation,
  TranscoderSettings,
  TranscoderSettingsView
} from './settings-service.js';

/**
 * The runner that decides where a job goes.
 *
 * A derivative only leaves the host when it is worth leaving: the kind of
 * derivative has to be on the list, and the source has to be small enough
 * to ship. Everything else runs here.
 *
 * The agent can be down, busy or unable to decode a codec. None of that
 * should stop a derivative from being produced, so a failed remote job is
 * retried locally unless the fallback is turned off.
 */
class DelegatingTranscoder implements Transcoder {
  readonly kind = 'remote' as const;

  constructor(
    private readonly remote: Transcoder,
    private readonly local: Transcoder,
    private readonly settings: TranscoderSettings
  ) {}

  async getCapabilities(): Promise<TranscoderCapabilities> {
    return this.remote.getCapabilities();
  }

  /** Whether this kind of derivative is allowed to leave the host. */
  private isAllowed(label: string): boolean {
    const operations = this.settings.operations;
    return operations.includes('*') || operations.includes(label);
  }

  async run(request: TranscodeRequest): Promise<void> {
    if (!this.isAllowed(request.label)) {
      await this.local.run(request);
      return;
    }

    if (!(await isWithinUploadLimit(request.inputPath, this.settings.maxUploadBytes))) {
      log.info('Transcoder: source is too large to ship, transcoding locally', {
        label: request.label,
        maxUploadBytes: this.settings.maxUploadBytes
      });
      await this.local.run(request);
      return;
    }

    try {
      await this.remote.run(request);
    } catch (error) {
      if (this.settings.fallback === 'off') {
        throw error;
      }

      log.error('Transcoder: remote run failed, falling back to the local ffmpeg', {
        label: request.label,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.local.run(request);
    }
  }
}

/** Build the runner described by the configuration. */
export function createTranscoder(settings: TranscoderSettings): Transcoder {
  const local = new LocalTranscoder();

  if (!settings.enabled || settings.url.length === 0) {
    return local;
  }

  const remote = new RemoteTranscoder({
    baseUrl: settings.url,
    token: settings.token,
    timeoutMs: 900_000,
    encoder: settings.encoder
  });

  return new DelegatingTranscoder(remote, local, settings);
}

let cached: { signature: string; transcoder: Transcoder } | null = null;

/**
 * The runner the derivative pipeline uses.
 *
 * The configuration is read from the Settings page, so a change takes
 * effect without a restart. The runner is rebuilt whenever the
 * configuration changes.
 */
export async function getTranscoder(): Promise<Transcoder> {
  const settings = await readTranscoderSettings();
  const signature = JSON.stringify(settings);

  if (!cached || cached.signature !== signature) {
    cached = { signature, transcoder: createTranscoder(settings) };
  }

  return cached.transcoder;
}

/** What the agent reports about itself. */
export interface TranscoderStatus {
  /** Whether the agent answered. */
  reachable: boolean;
  /** The encoder the agent would use. */
  encoder?: string;
  /** The render node the agent would use. */
  device?: string;
  /** The ffmpeg the agent runs. */
  ffmpeg?: string;
  /** Why the agent could not be reached. */
  error?: string;
}

/**
 * Ask the agent how it is doing.
 *
 * The Settings page shows this, so the administrator can tell a broken
 * agent from an idle one without reading a log.
 */
export async function getTranscoderStatus(): Promise<TranscoderStatus> {
  const settings = await readTranscoderSettings();

  if (!settings.enabled || settings.url.length === 0) {
    return { reachable: false, error: 'The external transcoder is off.' };
  }

  const transcoder = new RemoteTranscoder({
    baseUrl: settings.url,
    token: settings.token,
    timeoutMs: 10_000
  });

  try {
    const capabilities = await transcoder.getCapabilities();
    return {
      reachable: true,
      encoder: capabilities.encoder,
      device: capabilities.device,
      ffmpeg: capabilities.ffmpeg
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Drop the cached runner. Used by tests that change the configuration. */
export function resetTranscoder(): void {
  cached = null;
  resetTranscoderSettingsCache();
}
