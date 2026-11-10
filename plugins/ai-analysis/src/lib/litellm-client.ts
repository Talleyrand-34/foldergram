/**
 * The OpenAI-compatible provider client.
 *
 * The plugin used to talk to exactly one hardcoded LiteLLM proxy, with the
 * base URL and the models read from the environment at import time. This
 * version resolves the provider and the model from the stored configuration
 * on every call, so a provider can be added, changed or swapped without
 * touching the environment or restarting the server.
 *
 * Only the OpenAI-compatible dialect is supported: `/chat/completions`,
 * `/audio/transcriptions` and `/embeddings` with `Authorization: Bearer`.
 * That one shape covers LiteLLM, Ollama, vLLM, OpenAI, Groq, Together and
 * OpenRouter.
 */

import { readFile } from "node:fs/promises";

import { readAiConfig } from "../configStore.js";
import { resolveStage, type ResolvedStage } from "../config.js";
import { noteProviderRequest } from "./request-counter.js";

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
 * What kind of upstream fault this is.
 *
 * The distinction decides whether the queue waits or stops for good:
 *
 *   - `quota` — the credit or the allowance ran out. It may come back on its
 *     own (a top-up, a quota window), so the queue waits and retries.
 *   - `unreachable` — the service could not be reached, or answered with a
 *     gateway error. That clears on its own, so the queue waits too.
 *   - `configuration` — the credentials or the model are wrong. Only a human
 *     can fix that, so the queue stops until an operator resumes it.
 */
export type UpstreamFaultKind = "quota" | "unreachable" | "configuration";

/**
 * Thrown when the upstream service is unusable for a reason that has nothing
 * to do with the video being analysed: an expired/invalid API key, a missing
 * model, an exhausted quota, a gateway error or a network/DNS failure.
 *
 * The proxy wraps the provider's error, so the status alone is not enough:
 * an exhausted balance arrives as a **500** with the real reason in the body.
 * The body is what decides the kind.
 */
export class UpstreamUnavailableError extends Error {
  readonly name = "UpstreamUnavailableError";
  /** HTTP status of the upstream response; null for network failures. */
  readonly status: number | null;
  /** Which upstream call failed: 'chat' | 'transcribe' | 'embed'. */
  readonly operation: string;
  /** The upstream's own message, extracted from the JSON body when possible. */
  readonly detail: string;
  /** Whether the fault may clear on its own, or needs a human. */
  readonly kind: UpstreamFaultKind;

  constructor(
    operation: string,
    status: number | null,
    detail: string,
    kind: UpstreamFaultKind = "configuration"
  ) {
    super(formatUpstreamMessage(operation, status, detail, kind));
    this.operation = operation;
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

/**
 * Markers of a spent quota or credit.
 *
 * The gateway wraps the provider's error, so the status alone is not enough:
 * an exhausted balance arrives as a **500** with the real reason in the body.
 */
const QUOTA_MARKERS = [
  "insufficient_balance",
  "insufficient balance",
  "usage limit has been reached",
  "insufficient_quota",
  "exceeded your current quota",
  "quota exceeded",
  "payment required",
  "resource_exhausted"
];

/**
 * Markers of a fault only a human can fix: bad credentials or a missing
 * model.
 */
const CONFIGURATION_MARKERS = [
  "invalid api key",
  "incorrect api key",
  "authentication_error",
  "unauthorized",
  "permission denied",
  "model_not_found"
];

/**
 * Is this a quota that ran out, rather than a broken configuration?
 *
 * A quota can come back on its own, so the queue waits instead of stopping.
 */
export function isQuotaFault(detail: string, status: number | null): boolean {
  // 402 is "Payment Required" — the credit is gone.
  if (status === 402) return true;

  const text = detail.toLowerCase();
  return QUOTA_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Classify an upstream fault.
 *
 * The order matters: a quota is checked first, because the gateway reports
 * it as a 500 and it must not be mistaken for a broken configuration.
 */
export function classifyUpstreamFault(
  detail: string,
  status: number | null
): UpstreamFaultKind {
  // A network failure: DNS, refused connection, timeout.
  if (status === null) return "unreachable";

  if (isQuotaFault(detail, status)) return "quota";

  // 401/403 = the key is rejected; 404 = the model does not exist.
  if (status === 401 || status === 403 || status === 404) return "configuration";

  const text = detail.toLowerCase();
  if (CONFIGURATION_MARKERS.some((marker) => text.includes(marker))) {
    return "configuration";
  }

  // Anything else — a gateway error, an unknown status — is treated as
  // transient: the queue waits rather than stopping for good.
  return "unreachable";
}

/** Appended to every upstream error: what the operator should actually do. */
const UPSTREAM_HINTS: Record<UpstreamFaultKind, string> = {
  quota: "the upstream's credit or allowance ran out — it may come back on its own",
  unreachable: "the upstream could not be reached — it may come back on its own",
  configuration: "the configured model or API key is not usable"
};

function formatUpstreamMessage(
  operation: string,
  status: number | null,
  detail: string,
  kind: UpstreamFaultKind
): string {
  const what =
    status === null
      ? `${operation} unreachable`
      : `${operation} returned ${status}`;
  const shown = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
  return `upstream unavailable: ${what} (${shown}): ${UPSTREAM_HINTS[kind]}`;
}

/**
 * HTTP statuses that mean "the upstream/config is broken", not "this video is
 * bad". 400 stays out on purpose: a rejected request is a per-video problem.
 */
export function isUpstreamFaultStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 404 || status >= 500;
}

/** Pull the human-readable part out of an OpenAI-style error body. */
export function extractUpstreamDetail(text: string): string {
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
    const error = (parsed as { error: unknown }).error;
    if (typeof error === "string") return error.trim();
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      return (error as { message: string }).message.trim();
    }
  }
  if ("message" in parsed && typeof (parsed as { message: unknown }).message === "string") {
    return (parsed as { message: string }).message.trim();
  }
  if ("detail" in parsed && typeof (parsed as { detail: unknown }).detail === "string") {
    return (parsed as { detail: string }).detail.trim();
  }
  return trimmed;
}

/** Describe a fetch rejection (DNS failure, refused connection, timeout). */
export function describeNetworkError(e: unknown): string {
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
    throw new UpstreamUnavailableError(
      operation,
      null,
      describeNetworkError(e),
      "unreachable"
    );
  }
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date). */
export function parseRetryAfter(value: string | null, fallbackSec = 60): number {
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

/**
 * The headers a provider call carries.
 *
 * The API key is sent as a bearer token when the provider has one — most
 * gateways need it, and the local ones (Ollama, a bare LiteLLM) do not, so
 * an empty key sends no header at all.
 */
export function buildProviderHeaders(
  provider: ResolvedStage["provider"],
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { ...provider.headers, ...(extra ?? {}) };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

/**
 * Build the chat request body for a provider.
 *
 * The two dialects differ in three ways:
 *
 *   - MiniMax wants `max_completion_tokens`; `max_tokens` is deprecated
 *     there (it still works on the OpenAI-shaped gateways).
 *   - MiniMax does not document `response_format`, so it is not sent — the
 *     prompt already demands strict JSON and the parser copes with prose.
 *   - MiniMax understands the thinking controls, so they are passed on when
 *     the provider configures them.
 */
export function buildChatBody(
  provider: ResolvedStage["provider"],
  opts: {
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    json: boolean;
  }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false
  };

  if (provider.dialect === "minimax") {
    body.max_completion_tokens = opts.maxTokens;
    if (provider.thinkingType) {
      body.thinking = { type: provider.thinkingType };
    }
    if (provider.reasoningEffort) {
      body.reasoning_effort = provider.reasoningEffort;
    }
    // The thinking content is returned separately rather than wrapped in the
    // answer; the analyzer reads it from `reasoning_content`.
    body.reasoning_split = true;
  } else {
    body.max_tokens = opts.maxTokens;
    if (opts.json) body.response_format = { type: "json_object" };
  }

  return body;
}

/** Join the provider's base URL with an endpoint path. */
export function providerUrl(provider: ResolvedStage["provider"], path: string): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Resolve the provider and model a stage uses.
 *
 * Throws when the stage points at a provider that is not configured: that is
 * a configuration mistake, and failing loudly beats calling a random URL.
 */
export async function resolveStageProvider(
  stage: "vision" | "audio" | "embed"
): Promise<ResolvedStage> {
  const config = await readAiConfig();
  const resolved = resolveStage(config, stage);
  if (!resolved) {
    throw new UpstreamUnavailableError(
      stage,
      null,
      `the ${stage} stage points at a provider that is not configured`,
      "configuration"
    );
  }
  if (!resolved.provider.baseUrl) {
    throw new UpstreamUnavailableError(
      stage,
      null,
      `provider "${resolved.provider.label}" has no base URL`,
      "configuration"
    );
  }
  if (!resolved.model) {
    throw new UpstreamUnavailableError(
      stage,
      null,
      `provider "${resolved.provider.label}" has no model`,
      "configuration"
    );
  }
  return resolved;
}

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
  messages: ChatMessage[];
  /** Override the configured model. */
  model?: string;
  /** Override the configured max tokens. */
  maxTokens?: number;
  /** Override the configured timeout. */
  timeoutMs?: number;
  /** Force JSON output via response_format if the model supports it. */
  json?: boolean;
}

export interface ChatResponse {
  content: string;
  reasoning?: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const config = await readAiConfig();
  const resolved = await resolveStageProvider("vision");
  const model = opts.model ?? resolved.model;

  const wantsJson = opts.json ?? config.stages.vision.jsonMode;
  const body = buildChatBody(resolved.provider, {
    model,
    messages: opts.messages,
    maxTokens: opts.maxTokens ?? config.stages.vision.maxTokens,
    json: wantsJson
  });

  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? config.stages.vision.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // The request is counted before it is sent: what the plan sees is what
    // we sent, not what came back.
    noteProviderRequest(resolved.provider.id);
    const r = await fetchUpstream("chat", providerUrl(resolved.provider, "/chat/completions"), {
      method: "POST",
      headers: buildProviderHeaders(resolved.provider, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 429) {
        throw new RateLimitedError(
          parseRetryAfter(r.headers.get("retry-after")),
          `chat 429: ${text.slice(0, 200)}`
        );
      }
      if (isUpstreamFaultStatus(r.status)) {
        throw new UpstreamUnavailableError(
          "chat",
          r.status,
          extractUpstreamDetail(text),
          classifyUpstreamFault(extractUpstreamDetail(text), r.status)
        );
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
      model: data.model || model,
      usage: data.usage
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscriptionOptions {
  filePath: string;
  /** ISO code, or omit to auto-detect. */
  language?: string | null;
  /** Override the configured model. */
  model?: string;
  /** Override the configured timeout. */
  timeoutMs?: number;
}

export async function transcribe(
  opts: TranscriptionOptions
): Promise<{ text: string; raw: unknown; model: string }> {
  const config = await readAiConfig();
  const resolved = await resolveStageProvider("audio");
  const model = opts.model ?? resolved.model;
  const language = opts.language ?? config.stages.audio.language;

  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? config.stages.audio.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const filename = opts.filePath.split("/").pop() ?? "audio";
    const mime = mimeForFilename(filename);
    const buf = await readFile(opts.filePath);
    const blob = new Blob([buf], { type: mime });
    const file = new File([blob], filename, { type: mime });
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("model", model);
    fd.append("response_format", "json");
    if (language) fd.append("language", language);

    noteProviderRequest(resolved.provider.id);
    const r = await fetchUpstream(
      "transcribe",
      providerUrl(resolved.provider, "/audio/transcriptions"),
      {
        method: "POST",
        headers: buildProviderHeaders(resolved.provider),
        body: fd,
        signal: ctrl.signal
      }
    );
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 429) {
        throw new RateLimitedError(
          parseRetryAfter(r.headers.get("retry-after")),
          `transcribe 429: ${text.slice(0, 200)}`
        );
      }
      if (isUpstreamFaultStatus(r.status)) {
        throw new UpstreamUnavailableError(
          "transcribe",
          r.status,
          extractUpstreamDetail(text),
          classifyUpstreamFault(extractUpstreamDetail(text), r.status)
        );
      }
      throw new Error(`transcribe ${r.status}: ${text.slice(0, 500)}`);
    }
    const data = (await r.json()) as { text: string; model?: string };
    return { text: data.text ?? "", raw: data, model: data.model || model };
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbedOptions {
  input: string | string[];
  /** Override the configured model. */
  model?: string;
  /** Override the configured timeout. */
  timeoutMs?: number;
}

export async function embed(
  opts: EmbedOptions
): Promise<{ vectors: number[][]; model: string }> {
  const config = await readAiConfig();
  const resolved = await resolveStageProvider("embed");
  const model = opts.model ?? resolved.model;

  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? config.stages.embed.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    noteProviderRequest(resolved.provider.id);
    const r = await fetchUpstream("embed", providerUrl(resolved.provider, "/embeddings"), {
      method: "POST",
      headers: buildProviderHeaders(resolved.provider, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model,
        input: opts.input
      }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 429) {
        throw new RateLimitedError(
          parseRetryAfter(r.headers.get("retry-after")),
          `embed 429: ${text.slice(0, 200)}`
        );
      }
      if (isUpstreamFaultStatus(r.status)) {
        throw new UpstreamUnavailableError(
          "embed",
          r.status,
          extractUpstreamDetail(text),
          classifyUpstreamFault(extractUpstreamDetail(text), r.status)
        );
      }
      throw new Error(`embed ${r.status}: ${text.slice(0, 500)}`);
    }
    const data = (await r.json()) as { model: string; data: Array<{ embedding: number[] }> };
    return {
      vectors: data.data.map((d) => d.embedding),
      model: data.model || model
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
