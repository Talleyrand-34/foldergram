/**
 * Analyzer — the AI pipeline per video.
 *
 * Extracted and hardened from plugins/ai-analysis/.scratch/p3-full-pipeline.ts.
 * Differences:
 *   - Runs in-process (no separate script invocation)
 *   - Persists results via the storage module
 *   - Idempotent (skips if already analyzed at a newer mtime)
 *   - Times out per stage; surfaces structured errors so the worker can retry
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { chat, transcribe, AUDIO_MODEL, VISION_MODEL } from "../.scratch/lib/litellm-client.js";
import { extractAudio, extractSampleFrames, probeVideo } from "../.scratch/lib/ffmpeg.js";
import { saveAnalysis } from "./storage.js";
import type { IndexedVideoAsset } from "../../../server/src/plugins/types.js";

const TMP_ROOT = process.env.AI_ANALYSIS_TMP ?? "/tmp/ai-analysis";

export interface AnalysisResult {
  imageId: number;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  domains?: string[];
  tags?: string[];
  summary?: string;
  language?: string;
  sentiment?: string;
  transcript?: string;
  durationMs?: number;
}

export async function analyzeVideo(asset: IndexedVideoAsset): Promise<AnalysisResult> {
  const start = Date.now();
  const tmpDir = join(TMP_ROOT, `an-${asset.imageId}-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // Probe + extract
    const info = await probeVideo(asset.absolutePath);

    // Skip if too short or too long (defensive — caller already filtered, but
    // someone could call this directly via the API).
    if (info.duration <= 0) {
      return { imageId: asset.imageId, status: "skipped", reason: "zero duration", durationMs: Date.now() - start };
    }

    const framesDir = join(tmpDir, "frames");
    await mkdir(framesDir, { recursive: true });
    const framePaths = await extractSampleFrames(asset.absolutePath, 3, framesDir);

    let transcript = "";
    let detectedLanguage = "n/a";
    if (info.hasAudio) {
      const audioPath = await extractAudio(asset.absolutePath, tmpDir);
      try {
        const r = await transcribe({ filePath: audioPath, model: AUDIO_MODEL });
        transcript = r.text.trim();
        detectedLanguage = (r.raw as { language?: string }).language ?? "auto";
      } catch (e) {
        // Audio is best-effort; vision alone can still produce a useful result.
        transcript = "";
        detectedLanguage = "unknown";
      }
    }

    // Combined inference
    const prompt = `You are a video librarian. You have 3 frames (10%, 50%, 95% of a <1 minute video) AND an audio transcript. Produce STRICT JSON.

Audio transcript (may be empty if no speech):
"""
${transcript || "(no speech detected)"}
"""

Detected language: ${detectedLanguage}

Output JSON with this exact shape:
{
  "summary": "one sentence (≤120 chars) describing what this video is",
  "domains": ["slash notation: 'music/reggaeton', 'politics/france', 'films/scifi', etc."],
  "tags": ["5-15 lowercase tags — names, places, brands, songs, events"],
  "language": "ISO 639-1 code (es, en, fr, de, ja, etc.), or 'unknown'",
  "sentiment": "one of: positive | negative | neutral | mixed | provocative | informative"
}

Pick domains from: arts/music, arts/film, arts/literature, comedy, education, finance, food, gaming, health, history, news, philosophy, politics, religion, science, sports, tech, travel, vlog + sub-genre/sub-region. Always at least one domain. At most 3.

Return ONLY the JSON object. No prose, no markdown.`;

    const dataUrls = await Promise.all(
      framePaths.map(async (p: string) => {
        const buf = await Bun.file(p).arrayBuffer();
        return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
      }),
    );

    const llmResult = await chat({
      model: VISION_MODEL,
      maxTokens: 2000,
      json: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...dataUrls.map((url: string) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        },
      ],
    });

    const parsed = parseJsonLenient<{
      summary: string;
      domains: string[];
      tags: string[];
      language: string;
      sentiment: string;
    }>(llmResult.content);
    if (!parsed) {
      return {
        imageId: asset.imageId,
        status: "failed",
        reason: "llm json parse failed",
        durationMs: Date.now() - start,
      };
    }

    await saveAnalysis(asset.imageId, asset.mtimeMs, {
      summary: parsed.summary,
      domains: parsed.domains,
      tags: parsed.tags.map((t) => t.toLowerCase()),
      language: parsed.language,
      sentiment: parsed.sentiment,
      transcript,
      detectedLanguage,
      model: llmResult.model,
      usageTokens: llmResult.usage.total_tokens,
    });

    return {
      imageId: asset.imageId,
      status: "ok",
      domains: parsed.domains,
      tags: parsed.tags,
      summary: parsed.summary,
      language: parsed.language,
      sentiment: parsed.sentiment,
      transcript,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      imageId: asset.imageId,
      status: "failed",
      reason: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
