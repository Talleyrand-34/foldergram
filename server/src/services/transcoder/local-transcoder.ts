import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  TranscodeRequest,
  Transcoder,
  TranscoderCapabilities
} from './types.js';
import { resolvePlanArgs } from './types.js';

const execFileAsync = promisify(execFile);

/** The ffmpeg of this host. The environment may point at another one. */
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/**
 * The runner that uses the ffmpeg installed next to Foldergram.
 *
 * It has no GPU of its own, so only the software plans are eligible. When
 * the request carries no software plan the run fails with a clear message
 * instead of silently doing nothing.
 */
export class LocalTranscoder implements Transcoder {
  readonly kind = 'local' as const;

  async getCapabilities(): Promise<TranscoderCapabilities> {
    return {
      encoder: 'software',
      remote: false
    };
  }

  async run(request: TranscodeRequest): Promise<void> {
    const plan = request.plans.find((candidate) => candidate.encoder === 'software');

    if (!plan) {
      throw new Error(`No software encoder plan available for ${request.label}.`);
    }

    const args = resolvePlanArgs(plan, {
      inputPath: request.inputPath,
      outputPath: request.outputPath
    });

    await execFileAsync(FFMPEG, args, {
      maxBuffer: 8 * 1024 * 1024
    });
  }
}
