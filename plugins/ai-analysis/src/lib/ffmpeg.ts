/**
 * ffmpeg helpers for the AI-analysis scratch prototypes.
 *
 * Extract frames at chosen timestamps, and extract audio as 16 kHz mono WAV
 * for the whisper endpoint. Reuses the patterns from folder-knowledge's
 * video extractor but in TypeScript.
 */

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTranscoder } from "../../../../server/dist/services/transcoder/index.js";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "ffprobe";

export interface VideoInfo {
  duration: number; // seconds
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/**
 * Perceptual hash (dHash, 8x8) of an image file. 64-bit string derived
 * from horizontal-gradient differences after down-scaling to 9x8 grayscale.
 * Used to cheaply measure frame-to-frame similarity for the quality check.
 */
export async function dHash(imagePath: string): Promise<string> {
  // Use ImageMagick (preferred) or fall back to a tiny Python helper.
  // ImageMagick syntax: convert to 9x8 grayscale, compute the 64-bit hash.
  const { spawn } = await import('node:child_process');
  const tmp = imagePath + '.pgm';
  const args = ['convert', imagePath, '-resize', '9x8!', '-colorspace', 'Gray', '-depth', '8', tmp];
  const child = spawn('magick', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`magick exit ${code}`)));
    child.on('error', reject);
  });
  const fs = await import('node:fs/promises');
  const buf = await fs.readFile(tmp);
  await fs.unlink(tmp).catch(() => {});
  // 9x8 grayscale = 72 bytes. Compare each byte to the previous: bit=1 if
  // current > previous, else 0. Drop the last row (8th) since there's no
  // neighbor for column 7.
  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const cur = buf[row * 9 + col];
      const next = buf[row * 9 + col + 1];
      bits += cur > next ? '1' : '0';
    }
  }
  return bits;
}

/** Hamming distance between two dHash strings of equal length. */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) d++;
  return d;
}

/**
 * Sample N frames uniformly across a video, returning their paths and a
 * dHash per frame. Used by the analyzer to detect "low quality" videos
 * (where 3 sparse samples miss the point) and to pick the most-diverse
 * subset when re-analyzing.
 */
export interface SampledFrame {
  path: string;
  hash: string;
  index: number;       // 0..N-1 in the timeline
  timeSec: number;     // timestamp in the source video
}

export async function sampleFrames(
  videoPath: string,
  count: number,
  outDir?: string,
): Promise<SampledFrame[]> {
  const dir: string = outDir ?? (await import('node:fs/promises').then((m) => m.mkdtemp(
    join(tmpdir(), '/aia-frames-'),
  )) as string);
  await mkdir(dir, { recursive: true });
  const pattern = join(dir, 'f%03d.jpg');
  const args = ['-nostdin', '-v', 'error', '-i', videoPath, '-vf', `fps=1/${Math.max(1, Math.ceil(60 / count))},scale=480:-2`, '-frames:v', String(count), '-q:v', '3', pattern];
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    child.on('error', reject);
  });
  // Read the produced files (they're named f001.jpg, f002.jpg, ...)
  const fs = await import('node:fs/promises');
  const items: SampledFrame[] = [];
  for (let i = 1; i <= count; i++) {
    const fp = join(dir, `f${String(i).padStart(3, '0')}.jpg`);
    try {
      const stat = await fs.stat(fp);
      if (!stat.isFile()) continue;
      const hash = await dHash(fp);
      items.push({ path: fp, hash, index: i - 1, timeSec: (i - 1) * (60 / count) });
    } catch {
      // file might be missing if video is shorter than count
    }
  }
  return items;
}

/**
 * Pick `k` most-diverse frames using a greedy k-center on the dHash
 * Hamming-distance graph. Frames are picked in order of maximum average
 * distance to whatever has been selected so far.
 */
export function pickMostDiverse(
  frames: SampledFrame[],
  k: number,
): SampledFrame[] {
  if (frames.length <= k) return frames.slice();
  const picked: SampledFrame[] = [frames[0]];
  while (picked.length < k) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < frames.length; i++) {
      if (picked.includes(frames[i])) continue;
      let avg = 0;
      for (const p of picked) avg += hamming(frames[i].hash, p.hash);
      const score = avg / picked.length;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    picked.push(frames[bestIdx]);
  }
  return picked;
}

/**
 * Aggregate quality verdict from a set of dHashes. If the average pairwise
 * Hamming distance is very low the frames are near-duplicates (static /
 * fixed camera / slow motion) and a 3-frame sample is fine. If the spread
 * is high, frames are wildly different (montage / cuts) and 3 samples
 * might miss the topic.
 *
 * Returns:
 *   quality: 'high' | 'medium' | 'low'
 *   avgDist: average pairwise Hamming distance (normalized to 0..1)
 */
export function assessFrameQuality(
  frames: SampledFrame[],
): { quality: 'high' | 'medium' | 'low'; avgDist: number } {
  if (frames.length < 2) return { quality: 'high', avgDist: 0 };
  let total = 0, pairs = 0;
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      total += hamming(frames[i].hash, frames[j].hash);
      pairs++;
    }
  }
  const avgDist = pairs > 0 ? total / pairs / 64 : 0;
  // 'high'  = frames are similar (sparse 3-frame is fine)
  // 'medium' = mixed (re-analysis optional)
  // 'low'    = wildly different (re-analysis strongly recommended)
  const quality = avgDist < 0.10 ? 'high' : avgDist < 0.30 ? 'medium' : 'low';
  return { quality, avgDist };
}
export interface VideoInfo {
  duration: number; // seconds
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probeVideo(path: string): Promise<VideoInfo> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ];
  const out = await runProcess(FFPROBE, args);
  const data = JSON.parse(out.stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type: string;
      avg_frame_rate?: string;
      width?: number;
      height?: number;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const fps = parseRate(video?.avg_frame_rate ?? "0/1");
  return {
    duration: Number(data.format?.duration ?? 0),
    fps,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(audio),
  };
}

function parseRate(s: string): number {
  const [num, den] = s.split("/").map(Number);
  return den ? num / den : num;
}

/** Extract `count` evenly-spaced frames from a video as JPEGs. Returns paths. */
export async function extractSampleFrames(
  videoPath: string,
  count: number,
  outDir?: string,
): Promise<string[]> {
  const dir = outDir ?? (await mkTempDir("aip-frames-"));
  const pattern = join(dir, "f%03d.jpg");
  // fps filter of `count/duration` gives exactly `count` frames evenly spaced.
  const info = await probeVideo(videoPath);
  const fps = info.duration > 0 ? Math.max(0.01, count / info.duration) : 1;

  await runProcess(FFMPEG, [
    "-nostdin",
    "-v",
    "error",
    "-i",
    videoPath,
    "-vf",
    `fps=${fps.toFixed(4)},scale='min(1280,iw)':-2`,
    "-frames:v",
    String(count),
    "-q:v",
    "3",
    pattern,
  ]);
  // Glob the produced files.
  // `fileExists` is async — filtering on the Promise directly would keep
  // every path, including the ones ffmpeg failed to produce.
  const paths: string[] = [];
  for (const [index, p] of Array.from({ length: count }, (_, i) =>
    join(dir, `f${String(i + 1).padStart(3, "0")}.jpg`)
  ).entries()) {
    if (await fileExists(p)) paths.push(p);
  }
  return paths;
}

/**
 * Extract one frame per position, where each position is a fraction of the
 * video's duration (0..1).
 *
 * The even-spacing `fps` filter cannot express "10%, 50%, 95%" — it only
 * divides the timeline into equal slices. Seeking per frame can, and it
 * costs one short ffmpeg process per frame.
 */
/**
 * The widest a frame is sent at.
 *
 * The cost of a frame in tokens goes with its area, so this is the
 * biggest lever on how fast the queue can go: the provider counts the
 * tokens of every minute, and the frames are most of them.
 */
export const DEFAULT_FRAME_WIDTH = 1280;

export async function extractFramesAtPositions(
  videoPath: string,
  positions: number[],
  outDir?: string,
  maxWidth: number = DEFAULT_FRAME_WIDTH,
): Promise<string[]> {
  const dir = outDir ?? (await mkTempDir("aip-frames-"));
  const info = await probeVideo(videoPath);
  const duration = info.duration;

  const paths: string[] = [];
  for (const [index, position] of positions.entries()) {
    // A zero-length video has no meaningful timestamp; the caller skips those.
    const timestamp = duration > 0 ? Math.max(0, duration * position) : 0;
    const outPath = join(dir, `f${String(index + 1).padStart(3, "0")}.jpg`);
    try {
      await runProcess(FFMPEG, [
        "-nostdin",
        "-v",
        "error",
        "-y",
        // Input seeking: fast, and lands on the keyframe before the timestamp.
        "-ss",
        timestamp.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${Math.max(64, Math.round(maxWidth))},iw)':-2`,
        "-q:v",
        "3",
        outPath,
      ]);
    } catch {
      // A frame that cannot be decoded is not fatal — the pipeline works with
      // fewer frames than asked for.
      continue;
    }
    if (await fileExists(outPath)) paths.push(outPath);
  }
  return paths;
}

/**
 * Extract the full audio track as 16 kHz mono WAV (whisper's preferred format).
 *
 * The extraction goes through the transcoder, so an external agent can take
 * it when one is configured. The agent that is not there is not a problem:
 * the job is done here instead.
 */
export async function extractAudio(videoPath: string, outDir?: string): Promise<string> {
  const dir = outDir ?? (await mkTempDir("aip-audio-"));
  const outPath = join(dir, "audio.wav");
  const transcoder = await getTranscoder();

  await transcoder.run({
    plans: [
      {
        encoder: "software",
        args: [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-i",
          "{input}",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "wav",
          "{output}",
        ],
      },
    ],
    inputPath: videoPath,
    outputPath: outPath,
    label: "ai-audio",
  });

  return outPath;
}

async function mkTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on("error", reject);
  });
}

export async function rmTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
