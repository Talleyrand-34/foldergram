/**
 * Shared LiteLLM client for the AI-analysis scratch prototypes.
 *
 * All prototypes talk to one URL: http://10.0.2.31:4000/v1 (the LiteLLM proxy
 * on minisforum). LiteLLM routes vision through minimax/MiniMax-M3 and audio
 * transcription through our local whisper-server on :11114.
 *
 * This is intentionally minimal — Bun-style fetch, no SDK, no retries beyond
 * one explicit attempt. Real retry/idempotency logic belongs in the
 * graduation plugin, not the prototypes.
 */

import { readFile } from "node:fs/promises";

/**
 * Thrown when an upstream rate-limits us. The worker catches this and
 * pauses the queue until the Retry-After window expires.
 */
export class RateLimitedError extends Error {
  readonly name = "RateLimitedError";
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message?: string) {
    super(message ?? `upstream rate-limited; resume in ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Thrown when the upstream service is unusable for a reason that has nothing
 * to do with the video being analysed: an expired/invalid API key (401/402/
 * 403), a missing model (404), a gateway error (5xx) or a network/DNS
 * failure.
 *
 * The LiteLLM proxy answers 500 for both "upstream unreachable" and most
 * "bad key" cases, so a 5xx here means "our configuration is broken", not
 * "this video is bad". The worker pauses the queue on this error instead of
 * walking the whole library and marking every video failed.
 */
export class UpstreamUnavailableError extends Error {
  readonly name = "UpstreamUnavailableError";
  /** HTTP status of the upstream response; null for network failures. */
  readonly status: number | null;
  /** Which upstream call failed: 'chat' | 'transcribe' | 'embed'. */
  readonly operation: string;
  /** The upstream's own message, extracted from the JSON body when possible. */
  readonly detail: string;

  constructor(operation: string, status: number | null, detail: string) {
    super(formatUpstreamMessage(operation, status, detail));
    this.operation = operation;
    this.status = status;
    this.detail = detail;
  }
}

/** Appended to every upstream error: what the operator should actually do. */
const UPSTREAM_HINT = "the configured model or API key is not usable";

function formatUpstreamMessage(operation: string, status: number | null, detail: string): string {
  const what =
    status === null
      ? `${operation} unreachable`
      : `${operation} returned ${status}`;
  const shown = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
  return `upstream unavailable: ${what} (${shown}): ${UPSTREAM_HINT}`;
}

/**
 * HTTP statuses that mean "the upstream/config is broken", not "this video is
 * bad". 400 stays out on purpose: a rejected request is a per-video problem.
 */
function isUpstreamFaultStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 404 || status >= 500;
}

/** Pull the human-readable part out of a LiteLLM/OpenAI-style error body. */
function extractUpstreamDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "(empty response body)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed; // not JSON — the raw body is all we have
  }
  if (typeof parsed !== "object" || parsed === null) return trimmed;
  if ("error" in parsed) {
    const error = parsed.error;
    if (typeof error === "string") return error.trim();
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message.trim();
    }
  }
  if ("message" in parsed && typeof parsed.message === "string") return parsed.message.trim();
  if ("detail" in parsed && typeof parsed.detail === "string") return parsed.detail.trim();
  return trimmed;
}

/** Describe a fetch rejection (DNS failure, refused connection, timeout). */
function describeNetworkError(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause;
    if (cause instanceof Error) return `${e.message} (${cause.message})`;
    if (typeof cause === "string") return `${e.message} (${cause})`;
    return e.message;
  }
  return String(e);
}

/**
 * fetch() that maps every rejection (DNS, refused connection, timeout abort)
 * onto the upstream-fault taxonomy. A hanging gateway is an upstream problem
 * too — retrying it per video would burn the whole library.
 */
async function fetchUpstream(operation: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new UpstreamUnavailableError(operation, null, describeNetworkError(e));
  }
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date). */
function parseRetryAfter(value: string | null, fallbackSec = 60): number {
  if (!value) return fallbackSec;
  const trimmed = value.trim();
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum) && asNum >= 0) return Math.floor(asNum);
  // HTTP-date form
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
  }
  return fallbackSec;
}

export const LITELLM_BASE = process.env.LITELLM_BASE ?? "http://10.0.2.31:4000/v1";
export const VISION_MODEL = process.env.AI_VISION_MODEL ?? "minimax/MiniMax-M3";
export const AUDIO_MODEL = process.env.AI_AUDIO_MODEL ?? "whisper-1";
export const EMBED_MODEL = process.env.AI_EMBED_MODEL ?? "ollama/bge-m3:latest";

export interface ChatMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessageContentPart[];
}

export interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
  /** Max tokens for the final answer. Reasoning models need a lot — 1500+ for m3. */
  maxTokens?: number;
  /** Force JSON output via response_format if the model supports it. */
  json?: boolean;
  /** Total request timeout in ms. Default 120s for vision, 300s for transcripts. */
  timeoutMs?: number;
}

export interface ChatResponse {
  content: string;
  reasoning?: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: opts.model ?? VISION_MODEL,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1500,
    stream: false,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const r = await fetchUpstream('chat', `${LITELLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 429) {
        throw new RateLimitedError(
          parseRetryAfter(r.headers.get('retry-after')),
          `chat 429: ${text.slice(0, 200)}`,
        );
      }
      if (isUpstreamFaultStatus(r.status)) {
        throw new UpstreamUnavailableError('chat', r.status, extractUpstreamDetail(text));
      }
      throw new Error(`chat ${r.status}: ${text.slice(0, 500)}`);
    }
    const data = (await r.json()) as {
      model: string;
      choices: Array<{
        message: {
          content: string;
          reasoning_content?: string;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const msg = data.choices[0]?.message;
    return {
      content: msg?.content ?? "",
      reasoning: msg?.reasoning_content,
      model: data.model,
      usage: data.usage,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscriptionOptions {
  filePath: string;
  language?: string; // ISO code, or omit to auto-detect
  model?: string;
  timeoutMs?: number;
}

export async function transcribe(opts: TranscriptionOptions): Promise<{ text: string; raw: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 300_000);
  try {
    const filename = opts.filePath.split("/").pop() ?? "audio";
    const mime = mimeForFilename(filename);
    const buf = await readFile(opts.filePath);
    const blob = new Blob([buf], { type: mime });
    const file = new File([blob], filename, { type: mime });
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("model", opts.model ?? AUDIO_MODEL);
    fd.append("response_format", "json");
    if (opts.language) fd.append("language", opts.language);

    const r = await fetchUpstream('transcribe', `${LITELLM_BASE}/audio/transcriptions`, {
      method: "POST",
      body: fd,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 429) {
        throw new RateLimitedError(
          parseRetryAfter(r.headers.get('retry-after')),
          `transcribe 429: ${text.slice(0, 200)}`,
        );
      }
      if (isUpstreamFaultStatus(r.status)) {
        throw new UpstreamUnavailableError('transcribe', r.status, extractUpstreamDetail(text));
      }
      throw new Error(`transcribe ${r.status}: ${text.slice(0, 500)}`);
    }
    const data = (await r.json()) as { text: string };
    return { text: data.text ?? "", raw: data };
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbedOptions {
  input: string | string[];
  model?: string;
  timeoutMs?: number;
}

export async function embed(opts: EmbedOptions): Promise<{ vectors: number[][]; model: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const r = await fetchUpstream('embed', `${LITELLM_BASE}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? EMBED_MODEL,
        input: opts.input,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 429) {
        throw new RateLimitedError(
          parseRetryAfter(r.headers.get('retry-after')),
          `embed 429: ${text.slice(0, 200)}`,
        );
      }
      if (isUpstreamFaultStatus(r.status)) {
        throw new UpstreamUnavailableError('embed', r.status, extractUpstreamDetail(text));
      }
      throw new Error(`embed ${r.status}: ${text.slice(0, 500)}`);
    }
    const data = (await r.json()) as { model: string; data: Array<{ embedding: number[] }> };
    return {
      vectors: data.data.map((d) => d.embedding),
      model: data.model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a file as base64 for use in image_url data URIs. */
export async function fileToDataUrl(filePath: string, mime = "image/jpeg"): Promise<string> {
  const buf = await readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function mimeForFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm")) return "video/mp4";
  return "application/octet-stream";
}
