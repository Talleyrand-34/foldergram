/**
 * P3 — Full per-video pipeline.
 *
 * Combines P1 (vision) + P2 (audio) into one pass:
 *   1. Extract 3 frames
 *   2. Extract audio → whisper transcript
 *   3. Send (3 frames + transcript) to vision LLM → structured {summary, domains, tags}
 *
 * The bet: combining modalities produces better domain classification than
 * vision alone (text gives us topics that aren't visually obvious) and
 * better summaries than audio alone (frames give us visual context).
 *
 * Usage:
 *   bun run plugins/ai-analysis/.scratch/p3-full-pipeline.ts <video-path>
 *
 * Output: combined classification + artifact at runs/p3-*.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { chat, fileToDataUrl, transcribe, VISION_MODEL, AUDIO_MODEL } from "../src/lib/litellm-client.js";
import { extractAudio, extractSampleFrames, probeVideo, rmTempDir } from "../src/lib/ffmpeg.js";

interface ClassificationResult {
  summary: string;
  domains: string[];
  tags: string[];
  language: string;
  sentiment: string;
  /** What the LLM said about each input modality (for debugging). */
  evidence?: { visual?: string; audio?: string };
}

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("usage: bun p3-full-pipeline.ts <video-path>");
    process.exit(1);
  }

  const start = Date.now();
  const info = await probeVideo(videoPath);
  console.log(`[p3] video: ${info.width}x${info.height} ${info.duration.toFixed(1)}s hasAudio=${info.hasAudio}`);

  const tmpDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "tmp", `p3-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // Phase A — visual: extract 3 frames
    const framesDir = join(tmpDir, "frames");
    await mkdir(framesDir, { recursive: true });
    const t1 = Date.now();
    const framePaths = await extractSampleFrames(videoPath, 3, framesDir);
    console.log(`[p3] extracted ${framePaths.length} frames in ${Date.now() - t1}ms`);
    const dataUrls = await Promise.all(framePaths.map((p) => fileToDataUrl(p, "image/jpeg")));

    // Phase B — audio: extract + transcribe (in parallel with phase A is possible, but
    // ffmpeg can be CPU-contended; sequential is safer for a prototype).
    let transcript = "";
    let detectedLanguage = "n/a";
    if (info.hasAudio) {
      const audioPath = await extractAudio(videoPath, tmpDir);
      const t2 = Date.now();
      const r = await transcribe({ filePath: audioPath, model: AUDIO_MODEL });
      transcript = r.text.trim();
      detectedLanguage = (r.raw as { language?: string }).language ?? "auto";
      console.log(`[p3] transcript: ${transcript.length} chars, lang=${detectedLanguage}, in ${Date.now() - t2}ms`);
    } else {
      console.log(`[p3] no audio stream; skipping whisper`);
    }

    // Phase C — combined inference
    const t3 = Date.now();
    const prompt = `You are a video librarian. You have 3 frames (10%, 50%, 95% of a <1 minute video) AND an audio transcript. Produce STRICT JSON.

Audio transcript (may be empty if no speech):
"""
${transcript || "(no speech detected)"}
"""

Detected language: ${detectedLanguage}

Output JSON with this exact shape:
{
  "summary": "one sentence (≤120 chars) describing what this video is, using both visual and audio evidence",
  "domains": ["a list of knowledge domains — use slash notation like 'music/reggaeton', 'politics/france', 'films/scifi', 'comedy/stand-up', 'sports/football', 'tech/ai', 'history/ww2', etc. Pick the most specific paths you can."],
  "tags": ["5-15 lowercase tags — names of people, places, brands, songs, events, concepts mentioned in speech or visible on screen"],
  "language": "primary spoken or on-screen language as ISO 639-1 code (es, en, fr, de, ja, etc.), or 'unknown'",
  "sentiment": "one of: positive | negative | neutral | mixed | provocative | informative",
  "evidence": { "visual": "what you saw in the frames (1 short sentence)", "audio": "what you heard in the transcript (1 short sentence, or 'no speech')" }
}

Pick domains from a stable vocabulary:
  arts/music, arts/film, arts/literature, comedy, education, finance, food, gaming,
  health, history, news, philosophy, politics, religion, science, sports, tech,
  travel, vlog
and a sub-genre or sub-region if applicable. Always at least one domain. At most 3.

Return ONLY the JSON object. No prose, no markdown.`;

    const result = await chat({
      model: VISION_MODEL,
      maxTokens: 2000,
      json: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...dataUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        },
      ],
    });
    console.log(`[p3] llm responded in ${Date.now() - t3}ms (${result.usage.total_tokens} tokens)`);

    const parsed = parseJsonLenient<ClassificationResult>(result.content);
    if (!parsed) {
      console.error("[p3] failed to parse JSON. raw content:");
      console.error(result.content);
      console.error("reasoning:");
      console.error(result.reasoning);
      process.exit(1);
    }

    const artifact = {
      videoPath,
      videoMeta: info,
      frames: framePaths.length,
      audioChars: transcript.length,
      detectedLanguage,
      model: result.model,
      classification: parsed,
      usage: result.usage,
      durationMs: Date.now() - start,
    };

    console.log("");
    console.log(JSON.stringify(parsed, null, 2));

    const runsDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "runs");
    await mkdir(runsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const artifactPath = join(runsDir, `p3-${basename(videoPath)}-${stamp}.json`);
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    console.log(`[p3] wrote ${artifactPath}`);
  } finally {
    await rmTempDir(tmpDir);
  }
}

function parseJsonLenient<T>(raw: string): T | null {
  if (!raw) return null;
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

await main();
