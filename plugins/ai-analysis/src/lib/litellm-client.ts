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
    const r = await fetch(`${LITELLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
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

    const r = await fetch(`${LITELLM_BASE}/audio/transcriptions`, {
      method: "POST",
      body: fd,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
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
    const r = await fetch(`${LITELLM_BASE}/embeddings`, {
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
