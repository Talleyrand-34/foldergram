/**
 * P1 — Vision-only domain classification.
 *
 * Take a video, extract 3 frames (10%, 50%, 95% by default), send to the
 * vision LLM (minimax/MiniMax-M3), and ask for structured JSON describing
 * the video's domain, tags, and a one-line summary.
 *
 * Goal: prove that a vision model can correctly classify short clips into
 * domains like "music/reggaeton", "politics/france/2024", "films/scifi", etc.
 * This is the core bet.
 *
 * Usage:
 *   bun run plugins/ai-analysis/.scratch/p1-vision-classify.ts <video-path>
 *
 * Output: prints JSON to stdout; also writes the JSON artifact to
 *   plugins/ai-analysis/.scratch/runs/p1-<basename>-<timestamp>.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { chat, fileToDataUrl, VISION_MODEL } from "../src/lib/litellm-client.js";
import { extractSampleFrames, probeVideo, rmTempDir } from "../src/lib/ffmpeg.js";

interface ClassificationResult {
  summary: string;
  domains: string[];
  tags: string[];
  language: string;
  sentiment: string;
}

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("usage: bun p1-vision-classify.ts <video-path>");
    process.exit(1);
  }

  const start = Date.now();
  const info = await probeVideo(videoPath);
  console.log(`[p1] video: ${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(1)}s hasAudio=${info.hasAudio}`);

  const framesDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "tmp", `p1-${Date.now()}`);
  await mkdir(framesDir, { recursive: true });
  const framePaths = await extractSampleFrames(videoPath, 3, framesDir);
  console.log(`[p1] extracted ${framePaths.length} frames in ${Date.now() - start}ms`);

  try {
    const dataUrls = await Promise.all(
      framePaths.map((p) => fileToDataUrl(p, "image/jpeg"))
    );

    const prompt = `You are a video librarian. Analyze these 3 frames (10%, 50%, 95% of a <1 minute video) and produce STRICT JSON.

Output JSON with this exact shape:
{
  "summary": "one sentence (≤120 chars) describing what this video is",
  "domains": ["a list of knowledge domains — use slash notation like 'music/reggaeton', 'politics/france', 'films/scifi', 'comedy/stand-up', 'sports/football', 'tech/ai', 'history/ww2', etc. Pick the most specific paths you can."],
  "tags": ["5-15 lowercase tags — names of people, places, brands, songs, events, concepts"],
  "language": "primary spoken or on-screen language as ISO 639-1 code (es, en, fr, de, ja, etc.), or 'unknown'",
  "sentiment": "one of: positive | negative | neutral | mixed | provocative | informative"
}

Pick domains from a stable vocabulary:
  arts/music, arts/film, arts/literature, comedy, education, finance, food, gaming,
  health, history, news, philosophy, politics, religion, science, sports, tech,
  travel, vlog
and a sub-genre or sub-region if applicable. Always at least one domain. At most 3.

Return ONLY the JSON object. No prose, no markdown.`;

    const t0 = Date.now();
    const result = await chat({
      model: VISION_MODEL,
      maxTokens: 1500,
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
    console.log(`[p1] llm responded in ${Date.now() - t0}ms (${result.usage.total_tokens} tokens)`);

    const parsed = parseJsonLenient<ClassificationResult>(result.content);
    if (!parsed) {
      console.error("[p1] failed to parse JSON. raw content:");
      console.error(result.content);
      console.error("reasoning:");
      console.error(result.reasoning);
      process.exit(1);
    }

    const artifact = {
      videoPath,
      videoMeta: info,
      frameCount: framePaths.length,
      model: result.model,
      classification: parsed,
      usage: result.usage,
      durationMs: Date.now() - start,
    };

    console.log(JSON.stringify(parsed, null, 2));

    const runsDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "runs");
    await mkdir(runsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const artifactPath = join(runsDir, `p1-${basename(videoPath)}-${stamp}.json`);
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    console.log(`[p1] wrote ${artifactPath}`);
  } finally {
    await rmTempDir(framesDir);
  }
}

function parseJsonLenient<T>(raw: string): T | null {
  if (!raw) return null;
  // Models sometimes wrap JSON in ```json fences despite being told not to.
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Try to find the first {...} block.
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
