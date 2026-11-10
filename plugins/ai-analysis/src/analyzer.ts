/**
 * Analyzer — the AI pipeline per video.
 *
 * Differences from the original prototype:
 *   - Runs in-process (no separate script invocation)
 *   - Persists results via the storage module
 *   - Idempotent (skips if already analyzed at a newer mtime)
 *   - Times out per stage; surfaces structured errors so the worker can retry
 *   - Records per-stage timings + outcome to ai_analysis_events so we can
 *     tune the slow stages and watch error rates without leaving the box.
 *
 * Every stage reads its parameters from the stored configuration
 * (`config.ts`): which provider and model to use, how many frames to sample
 * and where, whether to transcribe the audio, whether to canonicalize the
 * domains, whether to write the caption back and whether to update the
 * knowledge graph. The defaults reproduce the original behaviour exactly.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  chat,
  transcribe,
  RateLimitedError,
  UpstreamUnavailableError,
} from "./lib/litellm-client.js";
import { canonicalizePost, type VerifiedDecision } from "./canonicalize.js";
import { extractAudio, extractFramesAtPositions, probeVideo } from "./lib/ffmpeg.js";
import { readAiConfig } from "./configStore.js";
import {
  applyCanonicalization,
  bumpDomainEdges,
  bumpDomainNodes,
  getExistingDomainsForCanonicalization,
  getExistingLanguagesForCanonicalization,
  recomputeFolderRollup,
  recordAnalysisEvent,
  saveAnalysis,
  updateCaptionIfNull,
} from "./storage.js";
import type { IndexedVideoAsset } from "../../../server/dist/plugins/types.js";

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
  const totalStart = Date.now();
  const tmpDir = join(TMP_ROOT, `an-${asset.imageId}-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  // The configuration decides what this run does. Reading it once here means
  // a change mid-run cannot make the stages disagree with each other.
  const config = await readAiConfig();
  const pipeline = config.pipeline;

  // Per-stage timers. Reset to 0 if a stage is skipped.
  const t = {
    frameExtractMs: 0,
    audioExtractMs: 0,
    whisperMs: 0,
    llmMs: 0,
  };
  let detectedLanguage: string | null = null;
  let domainsCount: number | null = null;
  let model = config.stages.vision.model || config.providers[0]?.defaultModel || "";
  /**
   * The provider the vision stage spends from. The usage limits are per
   * provider, so the events have to name it.
   */
  const visionProviderId = config.stages.vision.providerId;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    // ----- probe -----
    const info = await probeVideo(asset.absolutePath);

    if (info.duration <= 0) {
      return { imageId: asset.imageId, status: "skipped", reason: "zero duration", durationMs: Date.now() - totalStart };
    }

    if (pipeline.minDurationSeconds > 0 && info.duration < pipeline.minDurationSeconds) {
      return {
        imageId: asset.imageId,
        status: "skipped",
        reason: `shorter than the configured minimum (${pipeline.minDurationSeconds}s)`,
        durationMs: Date.now() - totalStart
      };
    }

    if (pipeline.maxDurationSeconds > 0 && info.duration > pipeline.maxDurationSeconds) {
      return {
        imageId: asset.imageId,
        status: "skipped",
        reason: `longer than the configured maximum (${pipeline.maxDurationSeconds}s)`,
        durationMs: Date.now() - totalStart
      };
    }

    // ----- frame extraction -----
    {
      const t0 = Date.now();
      const framesDir = join(tmpDir, "frames");
      await mkdir(framesDir, { recursive: true });
      await extractFramesAtPositions(
        asset.absolutePath,
        pipeline.framePositions,
        framesDir
      );
      t.frameExtractMs = Date.now() - t0;
    }

    // ----- audio extraction + whisper transcription -----
    let transcript = "";
    if (info.hasAudio && pipeline.extractAudio) {
      const audioPath = await extractAudio(asset.absolutePath, tmpDir);
      try {
        const w0 = Date.now();
        const r = await transcribe({ filePath: audioPath });
        transcript = r.text.trim();
        detectedLanguage = (r.raw as { language?: string }).language ?? "auto";
        t.whisperMs = Date.now() - w0;
      } catch (e) {
        transcript = "";
        detectedLanguage = "unknown";
        // Audio is best-effort; vision alone can still produce a useful result.
        // Errors here will be reflected in the final 'failed' event below
        // only if no usable summary comes back.
      }
    } else {
      detectedLanguage = info.hasAudio ? "audio_disabled" : "no_audio";
    }

    // ----- LLM combined inference -----
    const positions = pipeline.framePositions
      .map((position) => `${Math.round(position * 100)}%`)
      .join(", ");
    const prompt = `You are a video librarian. You have ${pipeline.frameCount} frames (${positions} of a <1 minute video) AND an audio transcript. Produce STRICT JSON.

Audio transcript (may be empty if no speech):
"""
${transcript || "(no speech detected)"}
"""

Detected language: ${detectedLanguage}

Output JSON with this exact shape:
{
  "summary": "one sentence (≤120 chars) describing what this video is. CRITICAL: write this in the video's ORIGINAL language (the language of the audio transcript below). Do NOT translate to English.",
  "summary_en": "English translation of summary. If the source is already English, copy summary verbatim.",
  "summary_es": "Spanish translation of summary. If the source is already Spanish, copy summary verbatim.",
  "domains": ["slash notation: 'music/reggaeton', 'politics/france', 'films/scifi', etc. — write in the source language"],
  "tags": ["5-15 lowercase tags — names, places, brands, songs, events — write in the source language"],
  "language": "ISO 639-1 code of the SOURCE language (es, en, fr, de, ja, etc.), or 'unknown'",
  "sentiment": "one of: positive | negative | neutral | mixed | provocative | informative"
}

Pick domains from: arts/music, arts/film, arts/literature, comedy, education, finance, food, gaming, health, history, news, philosophy, politics, religion, science, sports, tech, travel, vlog + sub-genre/sub-region. Always at least one domain. At most 3.

REMINDER: 'summary' MUST be in the source language (matching the transcript). 'summary_en' is the English translation. 'summary_es' is the Spanish translation. Do not put English in 'summary' if the source is non-English.

Return ONLY the JSON object. No prose, no markdown.`;

    const framesDir = join(tmpDir, "frames");
    const frameNames = (await readdir(framesDir)).sort();
    const dataUrls: string[] = [];
    for (const n of frameNames) {
      const buf = await readFile(join(framesDir, n));
      dataUrls.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
    }

    let llmResult;
    try {
      const llmStart = Date.now();
      llmResult = await chat({
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
      t.llmMs = Date.now() - llmStart;
      model = llmResult.model;
      inputTokens = llmResult.usage.prompt_tokens;
      outputTokens = llmResult.usage.completion_tokens;
    } catch (e) {
      // A rate limit or an upstream outage is not a failure of this video:
      // rethrow so the worker can pause the queue and retry later instead of
      // burning through the library marking every video failed.
      const upstreamKind =
        e instanceof UpstreamUnavailableError
          ? "upstream_unavailable"
          : e instanceof RateLimitedError
            ? "rate_limited"
            : null;
      await recordAnalysisEvent({
        eventType: "failed",
        imageId: asset.imageId,
        folderId: asset.folderId,
        providerId: visionProviderId,
        language: detectedLanguage,
        domainCount: null,
        timings: {
          durationMs: Date.now() - totalStart,
          frameExtractMs: t.frameExtractMs,
          audioExtractMs: 0,
          whisperMs: t.whisperMs,
          llmMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model,
        },
        errorKind: upstreamKind ?? "llm_request_failed",
        errorMessage: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
      });
      if (upstreamKind) throw e;
      return {
        imageId: asset.imageId,
        status: "failed",
        reason: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - totalStart,
      };
    }

    const parsed = parseJsonLenient<{
      summary: string;
      summary_en?: string;
      summary_es?: string;
      domains: string[];
      tags: string[];
      language: string;
      sentiment: string;
    }>(llmResult.content);
    if (!parsed) {
      await recordAnalysisEvent({
        eventType: "failed",
        imageId: asset.imageId,
        folderId: asset.folderId,
        providerId: visionProviderId,
        language: detectedLanguage,
        domainCount: null,
        timings: {
          durationMs: Date.now() - totalStart,
          frameExtractMs: t.frameExtractMs,
          audioExtractMs: 0,
          whisperMs: t.whisperMs,
          llmMs: t.llmMs,
          inputTokens,
          outputTokens,
          model,
        },
        errorKind: "llm_json_parse_failed",
        errorMessage: llmResult.content.slice(0, 500),
      });
      return {
        imageId: asset.imageId,
        status: "failed",
        reason: "llm json parse failed",
        durationMs: Date.now() - totalStart,
      };
    }

    domainsCount = parsed.domains.length;
    detectedLanguage = parsed.language;

    // Canonicalization: laya maps the proposed domains onto the existing
    // taxonomy, then an AI check verifies the decision — laya can put a post
    // into a domain that is merely the closest one it was offered, and that
    // is a false positive worth catching. When nothing fits, the original
    // suggestion becomes a new domain instead of being forced into an
    // existing one.
    //
    // Best-effort: if laya is unreachable the raw suggestions stand.
    let canonicalDomains = parsed.domains;
    let canonicalLanguage: string | null = parsed.language;
    let canonicalDecisions: VerifiedDecision[] | null = null;
    if (config.stages.canonicalizer.enabled && config.stages.canonicalizer.url) {
      try {
        const [existingDomains, existingLanguages] = await Promise.all([
          getExistingDomainsForCanonicalization(),
          getExistingLanguagesForCanonicalization(),
        ]);
        const result = await canonicalizePost({
          imageId: asset.imageId,
          transcript,
          summary: parsed.summary,
          suggestedDomains: parsed.domains,
          suggestedLanguage: parsed.language,
          existingDomains,
          existingLanguages,
          verify: config.stages.canonicalizer.verify
        });

        // Only a canonicalizer that actually answered may change the domains.
        // When it is unreachable the raw suggestions stand — for a fresh
        // analysis that is the right answer, and it must never undo a
        // decision that was already made.
        if (result.ok && result.domains.length > 0) {
          canonicalDomains = result.domains;
          domainsCount = result.domains.length;
        }
        if (result.language) {
          canonicalLanguage = result.language;
        }
        if (result.ok) {
          canonicalDecisions = result.decisions;
        }
      } catch (e) {
        console.error('[ai-analysis] laya canonicalization failed:',
          e instanceof Error ? e.message : String(e));
      }
    }

    await saveAnalysis(asset.imageId, asset.mtimeMs, {
      summary: parsed.summary,
      summaryEn: parsed.summary_en?.trim() || null,
      summaryEs: parsed.summary_es?.trim() || null,
      domains: parsed.domains,
      tags: parsed.tags.map((t) => t.toLowerCase()),
      language: parsed.language,
      sentiment: parsed.sentiment,
      transcript,
      detectedLanguage,
      model: llmResult.model,
      usageTokens: llmResult.usage.total_tokens,
    });

    // Backfill the post's user-visible caption when it's empty. The analyzer
    // never overwrites a manual edit — users who want a fresh AI description
    // can clear the caption in the post viewer and re-trigger analysis.
    if (pipeline.writeCaption) {
      await updateCaptionIfNull(asset.imageId, parsed.summary);
    }

    // Roll up into folder knowledge + bump the domain graph. These are
    // best-effort — a failure here must not fail the analysis. We now use
    // the canonicalized names from laya rather than the LLM's raw output.
    if (pipeline.updateKnowledgeGraph) {
      try {
        await bumpDomainNodes(canonicalDomains, canonicalLanguage);
        await bumpDomainEdges(canonicalDomains);
        await recomputeFolderRollup(asset.folderId);
        if (canonicalDecisions && canonicalDecisions.length > 0) {
          await applyCanonicalization(
            asset.imageId,
            canonicalDomains,
            canonicalLanguage,
            JSON.stringify(canonicalDecisions)
          );
        }
      } catch (e) {
        // Logged but not fatal — knowledge graph maintenance is a background concern.
        console.error('[ai-analysis] knowledge graph update failed:',
          e instanceof Error ? e.message : String(e));
      }
    }

    await recordAnalysisEvent({
      eventType: "completed",
      imageId: asset.imageId,
      folderId: asset.folderId,
      providerId: visionProviderId,
      language: detectedLanguage,
      domainCount: domainsCount,
      timings: {
        durationMs: Date.now() - totalStart,
        frameExtractMs: t.frameExtractMs,
        audioExtractMs: 0,
        whisperMs: t.whisperMs,
        llmMs: t.llmMs,
        inputTokens,
        outputTokens,
        model,
      },
      errorKind: null,
      errorMessage: null,
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
      durationMs: Date.now() - totalStart,
    };
  } catch (e) {
    // Rate-limit and upstream-outage errors must propagate to the worker so
    // it can pause the queue; they are not a "failed" outcome for the video.
    if (e instanceof RateLimitedError) {
      console.log(`[ai-analysis] rate-limited during id=${asset.imageId}: ${e.message}`);
      throw e;
    }
    if (e instanceof UpstreamUnavailableError) {
      console.log(`[ai-analysis] upstream unavailable during id=${asset.imageId}: ${e.message}`);
      throw e;
    }
    await recordAnalysisEvent({
      eventType: "failed",
      imageId: asset.imageId,
      folderId: asset.folderId,
      providerId: visionProviderId,
      language: detectedLanguage,
      domainCount: domainsCount,
      timings: {
        durationMs: Date.now() - totalStart,
        frameExtractMs: t.frameExtractMs,
        audioExtractMs: 0,
        whisperMs: t.whisperMs,
        llmMs: t.llmMs,
        inputTokens,
        outputTokens,
        model,
      },
      errorKind: "unexpected_exception",
      errorMessage: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    });
    return {
      imageId: asset.imageId,
      status: "failed",
      reason: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - totalStart,
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
