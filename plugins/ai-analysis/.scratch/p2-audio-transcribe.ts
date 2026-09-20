/**
 * P2 — Audio transcription + language detection.
 *
 * Take a video, extract the audio track as 16 kHz mono WAV, send to whisper
 * via LiteLLM. Measure transcript quality on real content (likely bilingual
 * ES/EN for this user's library).
 *
 * Usage:
 *   bun run plugins/ai-analysis/.scratch/p2-audio-transcribe.ts <video-path>
 *
 * Output: prints transcript + detected language + sample of word timings.
 * Writes artifact to plugins/ai-analysis/.scratch/runs/p2-*.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { transcribe, AUDIO_MODEL } from "./lib/litellm-client.js";
import { extractAudio, probeVideo, rmTempDir } from "./lib/ffmpeg.js";

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("usage: bun p2-audio-transcribe.ts <video-path>");
    process.exit(1);
  }

  const start = Date.now();
  const info = await probeVideo(videoPath);
  console.log(`[p2] video: ${info.width}x${info.height} ${info.duration.toFixed(1)}s hasAudio=${info.hasAudio}`);
  if (!info.hasAudio) {
    console.error("[p2] no audio stream — nothing to transcribe");
    process.exit(1);
  }

  const tmpDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "tmp", `p2-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    const t0 = Date.now();
    const audioPath = await extractAudio(videoPath, tmpDir);
    console.log(`[p2] extracted audio in ${Date.now() - t0}ms → ${audioPath}`);

    const t1 = Date.now();
    const result = await transcribe({
      filePath: audioPath,
      model: AUDIO_MODEL,
      // language omitted → whisper auto-detects
    });
    console.log(`[p2] whisper responded in ${Date.now() - t1}ms`);

    const transcript = result.text.trim();
    const words = transcript.split(/\s+/).filter(Boolean);
    const detectedLanguage = (result.raw as { language?: string }).language ?? "auto";

    console.log("");
    console.log(`[p2] language=${detectedLanguage} words=${words.length} chars=${transcript.length}`);
    console.log("--- transcript ---");
    console.log(transcript);
    console.log("--- end ---");

    const artifact = {
      videoPath,
      videoMeta: info,
      model: AUDIO_MODEL,
      detectedLanguage,
      transcript,
      wordCount: words.length,
      charCount: transcript.length,
      durationMs: Date.now() - start,
    };

    const runsDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "runs");
    await mkdir(runsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const artifactPath = join(runsDir, `p2-${basename(videoPath)}-${stamp}.json`);
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    console.log(`[p2] wrote ${artifactPath}`);
  } finally {
    await rmTempDir(tmpDir);
  }
}

await main();
