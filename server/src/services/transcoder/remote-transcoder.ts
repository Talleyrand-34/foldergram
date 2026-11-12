import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type {
  TranscodePlan,
  TranscodeRequest,
  Transcoder,
  TranscoderCapabilities
} from './types.js';

/** The shape of the agent's `/health` answer. */
interface AgentHealth {
  ok?: boolean;
  encoder?: string;
  device?: string;
  ffmpeg?: string;
}

export interface RemoteTranscoderOptions {
  /** Base URL of the agent, e.g. `http://10.0.2.31:8787`. */
  baseUrl: string;
  /** Shared secret sent as a bearer token. */
  token?: string;
  /** How long a single job may take. */
  timeoutMs: number;
  /**
   * Which encoder the agent should use.
   *
   * `auto` sends every plan and lets the agent pick the first one its
   * hardware supports. `vaapi` and `software` send only that one, so a
   * misconfigured host fails loudly instead of silently encoding in
   * software.
   */
  encoder?: 'auto' | 'vaapi' | 'software';
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The runner that hands the work to the agent.
 *
 * The source file travels with the request and the produced file comes back
 * with the answer, so neither host needs a shared filesystem. The result is
 * written to a temporary file next to the target and renamed afterwards, so
 * an interrupted job never leaves a half-written derivative behind — the
 * derivative cache treats any non-empty file as valid.
 */
export class RemoteTranscoder implements Transcoder {
  readonly kind = 'remote' as const;

  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly encoder: 'auto' | 'vaapi' | 'software';
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteTranscoderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.encoder = options.encoder ?? 'auto';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCapabilities(): Promise<TranscoderCapabilities> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000))
    });

    if (!response.ok) {
      throw new Error(`Transcoder agent health check failed with ${response.status}.`);
    }

    const health = (await response.json()) as AgentHealth;
    const encoder = health.encoder === 'vaapi' ? 'vaapi' : 'software';

    return {
      encoder,
      device: typeof health.device === 'string' ? health.device : undefined,
      ffmpeg: typeof health.ffmpeg === 'string' ? health.ffmpeg : undefined,
      remote: true
    };
  }

  async run(request: TranscodeRequest): Promise<void> {
    const plans = selectPlans(request.plans, this.encoder);

    if (plans.length === 0) {
      throw new Error(`No encoder plan matches the ${this.encoder} preference for ${request.label}.`);
    }

    const payload = plans.map((plan) => ({
      encoder: plan.encoder,
      args: plan.args
    }));

    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-foldergram-label': request.label,
      'x-foldergram-plans': Buffer.from(JSON.stringify({ plans }), 'utf8').toString('base64'),
      'x-foldergram-input-name': path.basename(request.inputPath),
      'x-foldergram-output-name': path.basename(request.outputPath)
    };

    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/transcode`, {
      method: 'POST',
      headers,
      body: Readable.toWeb(createReadStream(request.inputPath)) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(this.timeoutMs)
    } as RequestInit);

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`Transcoder agent failed with ${response.status}.${detail}`);
    }

    if (!response.body) {
      throw new Error('Transcoder agent returned an empty body.');
    }

    const outputPath = request.outputPath;
    const temporaryPath = `${outputPath}.transcode-${process.pid}-${Date.now()}.part`;
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    try {
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        createWriteStream(temporaryPath)
      );
      await fsp.rename(temporaryPath, outputPath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

/** Read a short error message from a failed answer without draining a body. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? ` ${text.slice(0, 500)}` : '';
  } catch {
    return '';
  }
}

/**
 * Narrow the plans of a request to the ones the preference allows.
 *
 * The order is kept: the agent tries the plans in the order it receives
 * them and falls through to the next one when a plan fails.
 */
export function selectPlans(
  plans: TranscodePlan[],
  preference: 'auto' | 'vaapi' | 'software'
): TranscodePlan[] {
  if (preference === 'auto') {
    return plans;
  }

  return plans.filter((plan) => plan.encoder === preference);
}

/** Whether a file is big enough to be worth shipping to another host. */
export async function isWithinUploadLimit(filePath: string, maxBytes: number): Promise<boolean> {
  if (maxBytes <= 0) {
    return false;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    return stats.size <= maxBytes;
  } catch {
    return false;
  }
}
