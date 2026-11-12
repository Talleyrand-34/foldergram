/**
 * Transcoder — the seam between derivative generation and the machine that
 * actually runs ffmpeg.
 *
 * Foldergram used to run every ffmpeg call on the host that owns the
 * gallery. That host is often a container with no GPU and a handful of CPU
 * cores, which makes video previews the slowest part of a scan. The
 * transcoder seam lets the same recipes run somewhere else: a box with a
 * dedicated GPU that can encode with VAAPI.
 *
 * A recipe is a *list of encoder plans*. Each plan carries the ffmpeg
 * arguments for one encoder, and the plans are ordered by preference. The
 * runner picks the first plan it can execute:
 *
 *   - the local runner only has software encoders, so it takes the first
 *     `software` plan;
 *   - the remote runner hands the whole list to the agent, which knows its
 *     own hardware and falls through to the next plan when a plan fails.
 *
 * The arguments use three placeholders so the same plan can be executed on
 * two different machines:
 *
 *   `{input}`   the source file;
 *   `{output}`  the file the encoder writes;
 *   `{device}`  the VAAPI device, known only by the machine that runs it.
 */

/** The encoder a plan targets. */
export type TranscoderEncoder = 'software' | 'vaapi';

/** One encoder plan: the ffmpeg arguments for a single encoder. */
export interface TranscodePlan {
  /** Which encoder the plan targets. */
  encoder: TranscoderEncoder;
  /**
   * The ffmpeg arguments, with `{input}`, `{output}` and `{device}` left
   * unresolved.
   */
  args: string[];
}

/** A request to produce one derivative file. */
export interface TranscodeRequest {
  /** The encoder plans, ordered by preference. */
  plans: TranscodePlan[];
  /** Absolute path of the source file on the host that owns the gallery. */
  inputPath: string;
  /** Absolute path the result has to end up at on that same host. */
  outputPath: string;
  /** Short label used for logs, e.g. `video-preview`. */
  label: string;
}

/** What a runner can do. */
export interface TranscoderCapabilities {
  /** The encoder the runner prefers for video transcodes. */
  encoder: TranscoderEncoder;
  /** The VAAPI device, when the runner has one. */
  device?: string;
  /** The ffmpeg the runner uses. */
  ffmpeg?: string;
  /** True when the runner is not the local process. */
  remote: boolean;
}

/** A machine that can run ffmpeg on this host's behalf. */
export interface Transcoder {
  /** Where the work goes. */
  readonly kind: 'local' | 'remote';
  /** What the runner supports. */
  getCapabilities(): Promise<TranscoderCapabilities>;
  /** Run the first plan the runner can execute. */
  run(request: TranscodeRequest): Promise<void>;
}

/** The placeholder for the source file inside a plan. */
export const INPUT_PLACEHOLDER = '{input}';
/** The placeholder for the produced file inside a plan. */
export const OUTPUT_PLACEHOLDER = '{output}';
/** The placeholder for the VAAPI device inside a plan. */
export const DEVICE_PLACEHOLDER = '{device}';

/**
 * Resolve the placeholders of a plan for a concrete machine.
 *
 * The replacement is done with a function so a path that contains `$&` or
 * `$1` keeps its literal text.
 */
export function resolvePlanArgs(
  plan: TranscodePlan,
  paths: { inputPath: string; outputPath: string; device?: string }
): string[] {
  return plan.args.map((argument) =>
    argument
      .split(INPUT_PLACEHOLDER).join(paths.inputPath)
      .split(OUTPUT_PLACEHOLDER).join(paths.outputPath)
      .split(DEVICE_PLACEHOLDER).join(paths.device ?? '')
  );
}
