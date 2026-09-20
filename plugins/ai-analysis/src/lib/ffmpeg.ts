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

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "ffprobe";

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
  // Glob the produced files
  return Array.from({ length: count }, (_, i) =>
    join(dir, `f${String(i + 1).padStart(3, "0")}.jpg`),
  ).filter((p) => fileExists(p));
}

/** Extract the full audio track as 16 kHz mono WAV (whisper's preferred format). */
export async function extractAudio(videoPath: string, outDir?: string): Promise<string> {
  const dir = outDir ?? (await mkTempDir("aip-audio-"));
  const outPath = join(dir, "audio.wav");
  await runProcess(FFMPEG, [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    outPath,
  ]);
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
