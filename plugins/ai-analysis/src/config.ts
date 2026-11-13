/**
 * The AI analysis configuration — providers and pipeline stages.
 *
 * The plugin used to hardcode one LiteLLM proxy and one model per call site,
 * read from the environment at import time. That made "which provider?" and
 * "which model?" a restart-and-edit affair, and it meant the *pipeline* (how
 * many frames, whether audio runs, whether the caption is written back) was
 * not adjustable at all.
 *
 * This module is the pure shape of that configuration: the types, the
 * defaults, and the normalisation. The persistence lives in `configStore.ts`.
 *
 * Two ideas:
 *
 *   - a **provider** is an endpoint plus credentials plus a default model.
 *     Only the OpenAI-compatible dialect is supported, which covers LiteLLM,
 *     Ollama, vLLM, OpenAI, Groq, Together and OpenRouter through one code
 *     path.
 *   - a **stage** is one step of the pipeline that talks to a provider:
 *     vision (the combined frame+transcript inference), audio (transcription),
 *     embeddings, and the canonicalizer.
 *
 * The defaults reproduce the previous behaviour exactly, so an existing
 * deployment keeps working with no stored configuration at all.
 */

/**
 * How to talk to the provider.
 *
 * `openai-compatible` is the plain OpenAI shape — one code path covers
 * LiteLLM, Ollama, vLLM, OpenAI, Groq, Together and OpenRouter.
 *
 * `minimax` is the same shape with MiniMax's differences: it wants
 * `max_completion_tokens` instead of the deprecated `max_tokens`, it does not
 * accept `response_format`, and it understands the thinking controls.
 */
export type AiProviderDialect = "openai-compatible" | "minimax";

export interface AiProvider {
  /** Stable slug, unique within the config. */
  id: string;
  /** Display name. */
  label: string;
  dialect: AiProviderDialect;
  /** Base URL including the version prefix, e.g. `http://10.0.2.31:4000/v1`. */
  baseUrl: string;
  /** API key. Never leaves the server — the API masks it. */
  apiKey: string;
  /** The model used when a stage does not name one. */
  defaultModel: string;
  /** Extra headers some gateways require. */
  headers: Record<string, string>;
  /**
   * MiniMax thinking depth: `low`, `medium`, `high`, `xhigh` or `max`.
   * Empty means "the API's default", which is `max`.
   */
  reasoningEffort: string;
  /**
   * MiniMax thinking mode: `adaptive` or `disabled`. Empty means "the API's
   * default", which is `adaptive`.
   */
  thinkingType: string;
  /**
   * This provider's own usage limits.
   *
   * Per provider, because the providers' allowances differ: a plan can count
   * over a 5-hour window, a local model over nothing at all.
   */
  usageLimits: AiProviderUsageLimits;
}

/** A stage's choice of provider and model. */
export interface AiStageTarget {
  /** The id of the provider this stage talks to. */
  providerId: string;
  /** The model. Empty means "the provider's default model". */
  model: string;
}

export interface AiVisionStage extends AiStageTarget {
  /** Max tokens for the combined inference. Reasoning models need a lot. */
  maxTokens: number;
  /** Total request timeout in ms. */
  timeoutMs: number;
  /** Ask for a JSON object back (`response_format`). */
  jsonMode: boolean;
}

export interface AiAudioStage extends AiStageTarget {
  /** Total request timeout in ms. */
  timeoutMs: number;
  /** Force an ISO 639-1 code, or null to let the model detect it. */
  language: string | null;
}

export interface AiEmbedStage extends AiStageTarget {
  /** Embeddings are not used by the current pipeline; kept for future work. */
  enabled: boolean;
  timeoutMs: number;
}

export interface AiCanonicalizerStage {
  /** The laya canonicalization service. */
  enabled: boolean;
  /** Its base URL. Empty disables the stage, exactly as before. */
  url: string;
  timeoutMs: number;
  /**
   * Check laya's decision with the AI.
   *
   * laya is a similarity match: it can put a post into a domain that is
   * merely the closest one it was offered. The check catches that, and
   * proposes a new domain when nothing fits.
   */
  verify: boolean;
}

/**
 * One usage window.
 *
 * The length is free-form, because a provider's own allowance is not: a plan
 * can count tokens over a rolling 5-hour window, a calendar week, or
 * anything else. `hours` is the window's length; `percent` is the share of
 * the budget that window may spend.
 */
export interface AiUsageWindowRule {
  /** The window's length, in hours. 1 = hourly, 24 = daily, 168 = weekly. */
  hours: number;
  /** The share of the budget this window may use, as a percentage. */
  percent: number;
}

/**
 * How the queue decides to stop.
 *
 *   - `hard` — the operator's own windows stop it. The queue keeps using the
 *     provider until a window's share is spent.
 *   - `smart` — the **shared pool** decides. A provider's plan is often shared
 *     with somebody else, and the pool reports what *everybody* has used. In
 *     smart mode the queue yields to the other user and takes the pool only
 *     when nobody else is using it.
 */
export type AiUsageMode = "hard" | "smart";

/**
 * The smart mode's settings.
 *
 * The pool is read from a read-only endpoint. MiniMax's Token Plan publishes
 * one — `/v1/token_plan/remains` — and it reports, per model and per window,
 * how much of the plan is used **by everybody**. That is what makes the
 * difference between "the pool is mine" and "somebody else is in here"
 * observable at all.
 */
export interface AiSmartUsageLimits {
  /**
   * The read-only endpoint that reports the pool.
   *
   * Empty means "derive it": for a MiniMax provider it is
   * `{baseUrl}/token_plan/remains`, which is the documented endpoint.
   */
  probeUrl: string;
  /**
   * The key sent to the probe.
   *
   * Empty means "use the provider's own key". A provider that reaches
   * MiniMax through a gateway needs the key itself here, because the gateway
   * is the one holding it.
   */
  probeApiKey: string;
  /** Which of the pool's windows to watch for contention. */
  watch: "interval" | "weekly" | "both";
  /** How often to read the pool, in minutes. */
  pollMinutes: number;
  /**
   * The share of the pool the queue may take while nobody else is using it.
   *
   * 100 means "use it until max" — the pool's own wall is then the only limit.
   */
  idlePercent: number;
  /**
   * The share of the pool the queue may take while somebody else is using it.
   *
   * 0 means "get out of the way": the queue stops until the pool is free
   * again or the window rolls over.
   */
  yieldPercent: number;
  /**
   * The share of the pool's drain that must be ours for the pool to count as
   * free. Above it, somebody else is using the plan.
   */
  contentionPercent: number;
  /**
   * Ignore the operator's own windows and let the pool's wall be the only
   * limit. Off means the windows still cap the spend; the smart mode only
   * adds the yielding.
   */
  ignoreHardWindows: boolean;
}

/**
 * A provider's usage limits.
 *
 * The limits are **per provider** because the providers' own allowances
 * differ: one plan counts over a 5-hour window, another over a calendar
 * month, a local model over nothing at all. The windows are **rolling** — "in
 * the last 5 hours" — because a window with an arbitrary length has no
 * calendar boundary to align to.
 */
export interface AiProviderUsageLimits {
  /** Enforce the limits at all. */
  enabled: boolean;
  /** The total token budget the percentages are shares of. */
  budget: number;
  /** The windows. */
  windows: AiUsageWindowRule[];
  /** Which rule decides when the queue stops. */
  mode: AiUsageMode;
  /** The smart mode's settings. Used when `mode` is `smart`. */
  smart: AiSmartUsageLimits;
}

/** The knobs of the per-video pipeline itself. */
export interface AiPipelineStageConfig {
  /** How many frames to sample. */
  frameCount: number;
  /** Where to sample them, as a fraction of the duration (0..1). */
  framePositions: number[];
  /**
   * The widest a frame is sent at, in pixels.
   *
   * The cost of a frame in tokens goes with its area, so this is the
   * biggest lever on how fast the queue can go: the provider counts the
   * tokens of every minute it gives, and the frames are most of them.
   */
  frameWidth: number;
  /** Extract audio and transcribe it. */
  extractAudio: boolean;
  /** Write the AI summary into the post's caption when it is empty. */
  writeCaption: boolean;
  /** Update the domain graph and the folder rollup. */
  updateKnowledgeGraph: boolean;
  /** Skip videos shorter than this (seconds). 0 disables the check. */
  minDurationSeconds: number;
  /** Skip videos longer than this (seconds). 0 disables the check. */
  maxDurationSeconds: number;
}

export interface AiAnalysisConfig {
  providers: AiProvider[];
  stages: {
    vision: AiVisionStage;
    audio: AiAudioStage;
    embed: AiEmbedStage;
    canonicalizer: AiCanonicalizerStage;
  };
  pipeline: AiPipelineStageConfig;
}

/** The id of the provider seeded from the environment. */
export const DEFAULT_PROVIDER_ID = "litellm";

/** The endpoints and models the plugin used before the configuration existed. */
export const DEFAULT_LITELLM_BASE_URL = "http://10.0.2.31:4000/v1";
export const DEFAULT_VISION_MODEL = "minimax/MiniMax-M3";
export const DEFAULT_AUDIO_MODEL = "whisper-1";
export const DEFAULT_EMBED_MODEL = "ollama/bge-m3:latest";

/** MiniMax's own API — reachable directly, without a gateway. */
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
/** The thinking depths MiniMax accepts. */
export const MINIMAX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** The thinking modes MiniMax accepts. */
export const MINIMAX_THINKING_TYPES = ["adaptive", "disabled"] as const;

export const MIN_FRAMES = 1;
export const MAX_FRAMES = 12;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
/** The narrowest a frame may be sent at: too small and the model sees nothing. */
export const MIN_FRAME_WIDTH = 256;
/** The widest a frame may be sent at. */
export const MAX_FRAME_WIDTH = 4096;

export const MIN_TOKENS = 128;
export const MAX_TOKENS = 64_000;
/** The share of a budget a window may use, as a percentage. */
export const MIN_USAGE_THRESHOLD_PERCENT = 1;
export const MAX_USAGE_THRESHOLD_PERCENT = 100;
/** The shortest and longest usage window, in hours. */
export const MIN_USAGE_WINDOW_HOURS = 1;
export const MAX_USAGE_WINDOW_HOURS = 24 * 365;
/** The largest token budget a window can hold (a million tokens is plenty). */
export const MAX_USAGE_LIMIT = 1_000_000_000;
/** The shortest and longest gap between two pool readings, in minutes. */
export const MIN_SMART_POLL_MINUTES = 1;
export const MAX_SMART_POLL_MINUTES = 60;

/** The configuration a fresh install starts with. */
export function defaultAiConfig(): AiAnalysisConfig {
  return {
    providers: [
      {
        id: DEFAULT_PROVIDER_ID,
        label: "LiteLLM",
        dialect: "openai-compatible",
        baseUrl: DEFAULT_LITELLM_BASE_URL,
        apiKey: "",
        defaultModel: DEFAULT_VISION_MODEL,
        headers: {},
        reasoningEffort: "",
        thinkingType: "",
        usageLimits: defaultProviderUsageLimits()
      }
    ],
    stages: {
      vision: {
        providerId: DEFAULT_PROVIDER_ID,
        model: "",
        // The model sometimes thinks at length before answering, and the
        // answer was being cut in the middle: the JSON never closed and
        // seven per cent of the calls were thrown away.
        maxTokens: 4000,
        timeoutMs: 120_000,
        jsonMode: true
      },
      audio: {
        providerId: DEFAULT_PROVIDER_ID,
        model: DEFAULT_AUDIO_MODEL,
        timeoutMs: 300_000,
        language: null
      },
      embed: {
        providerId: DEFAULT_PROVIDER_ID,
        model: DEFAULT_EMBED_MODEL,
        enabled: false,
        timeoutMs: 60_000
      },
      canonicalizer: {
        enabled: true,
        url: "",
        timeoutMs: 30_000,
        verify: true
      }
    },
    pipeline: {
      frameCount: 3,
      framePositions: defaultFramePositions(3),
      frameWidth: 1280,
      extractAudio: true,
      writeCaption: true,
      updateKnowledgeGraph: true,
      minDurationSeconds: 0,
      maxDurationSeconds: 0
    }
  };
}

/**
 * A ready-made MiniMax provider.
 *
 * The foldergram server can reach `api.minimax.io` directly, so a MiniMax
 * provider does not need the local gateway at all.
 */
export function minimaxProvider(id = "minimax"): AiProvider {
  return {
    id: slugifyProviderId(id),
    label: "MiniMax",
    dialect: "minimax",
    baseUrl: MINIMAX_BASE_URL,
    apiKey: "",
    defaultModel: MINIMAX_DEFAULT_MODEL,
    headers: {},
    reasoningEffort: "",
    thinkingType: "",
    usageLimits: defaultProviderUsageLimits()
  };
}

/** A slug usable as a provider id. */
export function slugifyProviderId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "provider";
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.round(toNumber(value, fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue !== "string") continue;
    const name = key.trim();
    if (!name) continue;
    headers[name] = headerValue;
  }
  return headers;
}

/**
 * The frame positions a configuration uses when it does not name any.
 *
 * Three frames land at 10%, 50% and 95% — the original hardcoded choice,
 * which catches the opening, the middle and the end of a clip. Any other
 * count is spread evenly across the same range.
 */
export function defaultFramePositions(frameCount: number): number[] {
  if (frameCount <= 1) return [0.5];
  if (frameCount === 3) return [0.1, 0.5, 0.95];

  const positions: number[] = [];
  for (let index = 0; index < frameCount; index++) {
    positions.push(0.1 + (0.85 * index) / (frameCount - 1));
  }
  return positions;
}

/** Clamp the frame positions into (0, 1] and keep them sorted. */
export function normalizeFramePositions(value: unknown, frameCount: number): number[] {
  if (!Array.isArray(value)) {
    return defaultFramePositions(frameCount);
  }

  const positions = value
    .map((entry) => toNumber(entry, 0.5))
    .filter((entry) => Number.isFinite(entry))
    .map((entry) => Math.min(1, Math.max(0.01, entry)))
    .sort((a, b) => a - b);

  if (positions.length === 0) {
    return defaultFramePositions(frameCount);
  }
  return positions;
}

function normalizeProvider(raw: unknown, index: number): AiProvider {
  const value = (raw ?? {}) as Partial<AiProvider>;
  const id = slugifyProviderId(toString(value.id, `provider-${index + 1}`));
  const dialect: AiProviderDialect = value.dialect === "minimax" ? "minimax" : "openai-compatible";

  const effort = toString(value.reasoningEffort).trim().toLowerCase();
  const thinking = toString(value.thinkingType).trim().toLowerCase();

  return {
    id,
    label: toString(value.label, id).slice(0, 120) || id,
    dialect,
    baseUrl: toString(value.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: toString(value.apiKey),
    defaultModel: toString(value.defaultModel).trim(),
    headers: toHeaderMap(value.headers),
    // Only the values MiniMax accepts; anything else means "the API default".
    reasoningEffort: (MINIMAX_REASONING_EFFORTS as readonly string[]).includes(effort) ? effort : "",
    thinkingType: (MINIMAX_THINKING_TYPES as readonly string[]).includes(thinking) ? thinking : "",
    usageLimits: normalizeProviderUsageLimits(value.usageLimits)
  };
}

/** Normalize a provider's usage limits. */
export function normalizeProviderUsageLimits(raw: unknown): AiProviderUsageLimits {
  const fallback = defaultProviderUsageLimits();
  if (!raw || typeof raw !== "object") return fallback;

  const value = raw as Partial<AiProviderUsageLimits>;
  const windows: AiUsageWindowRule[] = [];
  const seenHours = new Set<number>();

  for (const entry of Array.isArray(value.windows) ? value.windows : []) {
    if (!entry || typeof entry !== "object") continue;
    const rule = entry as Partial<AiUsageWindowRule>;

    // A window with no length is meaningless — it is dropped rather than
    // clamped to the shortest window, which would silently tighten a limit.
    const rawHours = toNumber(rule.hours, 0);
    if (!Number.isFinite(rawHours) || rawHours <= 0) continue;
    const hours = clampInt(rawHours, MIN_USAGE_WINDOW_HOURS, MAX_USAGE_WINDOW_HOURS, rawHours);

    // One window per length: a second rule for the same length is a
    // duplicate, not a second limit.
    if (seenHours.has(hours)) continue;
    seenHours.add(hours);

    windows.push({
      hours,
      percent: clampInt(rule.percent, MIN_USAGE_THRESHOLD_PERCENT, MAX_USAGE_THRESHOLD_PERCENT, 100)
    });
  }

  windows.sort((a, b) => a.hours - b.hours);

  return {
    enabled: toBoolean(value.enabled, fallback.enabled),
    budget: clampInt(value.budget, 0, MAX_USAGE_LIMIT, 0),
    windows,
    mode: value.mode === "smart" ? "smart" : "hard",
    smart: normalizeSmartUsageLimits(value.smart)
  };
}

/** Normalize the smart mode's settings. */
export function normalizeSmartUsageLimits(raw: unknown): AiSmartUsageLimits {
  const fallback = defaultSmartUsageLimits();
  if (!raw || typeof raw !== "object") return fallback;

  const value = raw as Partial<AiSmartUsageLimits>;
  const watch =
    value.watch === "weekly" || value.watch === "both"
      ? value.watch
      : fallback.watch;

  return {
    probeUrl: toString(value.probeUrl).trim(),
    probeApiKey: toString(value.probeApiKey).trim(),
    watch,
    pollMinutes: clampInt(value.pollMinutes, MIN_SMART_POLL_MINUTES, MAX_SMART_POLL_MINUTES, fallback.pollMinutes),
    idlePercent: clampInt(value.idlePercent, 0, 100, fallback.idlePercent),
    yieldPercent: clampInt(value.yieldPercent, 0, 100, fallback.yieldPercent),
    contentionPercent: clampInt(value.contentionPercent, 0, 100, fallback.contentionPercent),
    ignoreHardWindows: toBoolean(value.ignoreHardWindows, fallback.ignoreHardWindows)
  };
}

/** The usage limits a fresh provider starts with: off. */
export function defaultProviderUsageLimits(): AiProviderUsageLimits {
  return {
    enabled: false,
    budget: 0,
    windows: [],
    mode: "hard",
    smart: defaultSmartUsageLimits()
  };
}

/**
 * The smart mode's defaults.
 *
 * The pool is read every two minutes: the shorter the gap, the less of the
 * pool the other user loses before the queue notices them. The queue takes
 * the whole pool while it is alone ("use it until max") and nothing at all
 * while somebody else is in it ("get out of the way").
 */
export function defaultSmartUsageLimits(): AiSmartUsageLimits {
  return {
    probeUrl: "",
    probeApiKey: "",
    watch: "interval",
    pollMinutes: 2,
    idlePercent: 100,
    yieldPercent: 0,
    contentionPercent: 5,
    ignoreHardWindows: false
  };
}

/**
 * Turn anything into a valid configuration.
 *
 * The stored value is user input, so every field is validated rather than
 * trusted. Nothing here throws — an unreadable value falls back to the
 * default.
 */
export function normalizeAiConfig(raw: unknown): AiAnalysisConfig {
  const fallback = defaultAiConfig();
  if (!raw || typeof raw !== "object") return fallback;

  const value = raw as Partial<AiAnalysisConfig>;
  const rawProviders = Array.isArray(value.providers) ? value.providers : [];
  const providers: AiProvider[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of rawProviders.entries()) {
    const provider = normalizeProvider(entry, index);
    // A duplicate id would make a stage ambiguous; keep the first one.
    if (seenIds.has(provider.id)) continue;
    seenIds.add(provider.id);
    providers.push(provider);
  }
  if (providers.length === 0) providers.push(...fallback.providers);

  const rawStages = (value.stages ?? {}) as Partial<AiAnalysisConfig["stages"]>;
  const rawVision = (rawStages.vision ?? {}) as Partial<AiVisionStage>;
  const rawAudio = (rawStages.audio ?? {}) as Partial<AiAudioStage>;
  const rawEmbed = (rawStages.embed ?? {}) as Partial<AiEmbedStage>;
  const rawCanonicalizer = (rawStages.canonicalizer ?? {}) as Partial<AiCanonicalizerStage>;

  const frameCount = clampInt(
    (value.pipeline ?? {})?.frameCount,
    MIN_FRAMES,
    MAX_FRAMES,
    fallback.pipeline.frameCount
  );

  const rawPipeline = (value.pipeline ?? {}) as Partial<AiPipelineStageConfig>;

  return {
    providers,
    stages: {      vision: {
        providerId: toString(rawVision.providerId, fallback.stages.vision.providerId),
        model: toString(rawVision.model),
        maxTokens: clampInt(rawVision.maxTokens, MIN_TOKENS, MAX_TOKENS, fallback.stages.vision.maxTokens),
        timeoutMs: clampInt(rawVision.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, fallback.stages.vision.timeoutMs),
        jsonMode: toBoolean(rawVision.jsonMode, fallback.stages.vision.jsonMode)
      },
      audio: {
        providerId: toString(rawAudio.providerId, fallback.stages.audio.providerId),
        model: toString(rawAudio.model, fallback.stages.audio.model),
        timeoutMs: clampInt(rawAudio.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, fallback.stages.audio.timeoutMs),
        language:
          rawAudio.language === null || rawAudio.language === undefined
            ? null
            : toString(rawAudio.language).trim() || null
      },
      embed: {
        providerId: toString(rawEmbed.providerId, fallback.stages.embed.providerId),
        model: toString(rawEmbed.model, fallback.stages.embed.model),
        enabled: toBoolean(rawEmbed.enabled, fallback.stages.embed.enabled),
        timeoutMs: clampInt(rawEmbed.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, fallback.stages.embed.timeoutMs)
      },
      canonicalizer: {
        enabled: toBoolean(rawCanonicalizer.enabled, fallback.stages.canonicalizer.enabled),
        url: toString(rawCanonicalizer.url).trim().replace(/\/+$/, ""),
        timeoutMs: clampInt(
          rawCanonicalizer.timeoutMs,
          MIN_TIMEOUT_MS,
          MAX_TIMEOUT_MS,
          fallback.stages.canonicalizer.timeoutMs
        ),
        verify: toBoolean(rawCanonicalizer.verify, fallback.stages.canonicalizer.verify)
      }
    },
    pipeline: {
      frameCount,
      framePositions: normalizeFramePositions(rawPipeline.framePositions, frameCount),
      frameWidth: clampInt(rawPipeline.frameWidth, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH, fallback.pipeline.frameWidth),
      extractAudio: toBoolean(rawPipeline.extractAudio, fallback.pipeline.extractAudio),
      writeCaption: toBoolean(rawPipeline.writeCaption, fallback.pipeline.writeCaption),
      updateKnowledgeGraph: toBoolean(
        rawPipeline.updateKnowledgeGraph,
        fallback.pipeline.updateKnowledgeGraph
      ),
      minDurationSeconds: clampInt(rawPipeline.minDurationSeconds, 0, 24 * 3600, 0),
      maxDurationSeconds: clampInt(rawPipeline.maxDurationSeconds, 0, 24 * 3600, 0)
    }
  };
}

/**
 * Check the configuration for the problems that would break a run.
 *
 * Returns every problem rather than the first, so the UI can show them all.
 */
export function validateAiConfig(config: AiAnalysisConfig): string[] {
  const errors: string[] = [];

  if (config.providers.length === 0) {
    errors.push("at least one provider is required");
  }

  const ids = new Set<string>();
  for (const provider of config.providers) {
    if (ids.has(provider.id)) {
      errors.push(`duplicate provider id "${provider.id}"`);
    }
    ids.add(provider.id);

    if (!provider.baseUrl) {
      errors.push(`provider "${provider.label}" has no base URL`);
    } else if (!/^https?:\/\//i.test(provider.baseUrl)) {
      errors.push(`provider "${provider.label}" has an invalid base URL`);
    }
  }

  const checkStage = (
    name: string,
    providerId: string,
    enabled: boolean,
    requiresModel: boolean
  ): void => {
    if (!enabled) return;
    if (!providerId) {
      errors.push(`the ${name} stage has no provider selected`);
      return;
    }
    if (!ids.has(providerId)) {
      errors.push(`the ${name} stage points at an unknown provider "${providerId}"`);
    }
  };

  checkStage("vision", config.stages.vision.providerId, true, true);
  checkStage("audio", config.stages.audio.providerId, config.pipeline.extractAudio, true);
  checkStage("embeddings", config.stages.embed.providerId, config.stages.embed.enabled, true);

  // The canonicalizer needs a URL to do anything; without one it is inert,
  // which is the state a fresh install starts in. That is not an error — the
  // stage simply does not run.
  if (
    config.pipeline.minDurationSeconds > 0 &&
    config.pipeline.maxDurationSeconds > 0 &&
    config.pipeline.minDurationSeconds >= config.pipeline.maxDurationSeconds
  ) {
    errors.push("the minimum duration must be smaller than the maximum duration");
  }

  return errors;
}

/** A stage resolved against the provider list. */
export interface ResolvedStage {
  provider: AiProvider;
  model: string;
}

/**
 * Resolve a stage to a concrete provider and model.
 *
 * Returns null when the stage points at a provider that is not configured —
 * the caller then treats the stage as unavailable rather than guessing.
 */
export function resolveStage(
  config: AiAnalysisConfig,
  stage: "vision" | "audio" | "embed"
): ResolvedStage | null {
  const target = config.stages[stage];
  const provider = config.providers.find((candidate) => candidate.id === target.providerId);
  if (!provider) return null;

  const model = target.model.trim() || provider.defaultModel.trim();
  return { provider, model };
}

/**
 * Merge a list of providers into the current ones.
 *
 * The patch names the providers it changes. The ones it does not name are
 * **kept**: a patch that changes one provider's limits must not silently
 * delete the others, which is exactly the kind of accident a settings page
 * should never be able to cause.
 *
 * A provider the browser sends without an id is a new one, and it is given an
 * id that does not collide with an existing name.
 */
function mergeProviders(current: AiProvider[], incoming: unknown[]): AiProvider[] {
  const merged = new Map<string, AiProvider>();
  const assigned = new Set<string>();
  const taken = new Set(current.map((provider) => provider.id));

  const uniqueId = (): string => {
    let index = 1;
    let id = "provider";
    while (taken.has(id) || assigned.has(id)) {
      index += 1;
      id = `provider-${index}`;
    }
    return id;
  };

  for (const [index, entry] of incoming.entries()) {
    const raw = (entry ?? {}) as Partial<AiProvider>;
    const rawId = toString(raw.id).trim();

    let id = rawId ? slugifyProviderId(rawId) : "";
    // A blank id means "a provider that is being added", and a repeated id
    // means the patch names the same provider twice.
    if (!id || assigned.has(id)) id = uniqueId();
    assigned.add(id);

    const existing = current.find((provider) => provider.id === id);
    const baseLimits = existing?.usageLimits ?? defaultProviderUsageLimits();
    const incomingLimits = raw.usageLimits as
      | Partial<AiProviderUsageLimits>
      | undefined;

    // The smart settings are merged on their own, so a patch that only
    // changes the mode does not wipe the probe's settings.
    const usageLimits: AiProviderUsageLimits =
      incomingLimits === undefined
        ? baseLimits
        : {
            ...baseLimits,
            ...incomingLimits,
            smart:
              incomingLimits.smart === undefined
                ? baseLimits.smart
                : { ...baseLimits.smart, ...incomingLimits.smart }
          };

    // The blanks are filled in by the normalizer, which every saved
    // configuration goes through anyway.
    merged.set(id, {
      ...(existing ?? {}),
      ...raw,
      id,
      usageLimits
    } as AiProvider);
  }

  // The stored order is kept, and the providers that are new are appended.
  const result: AiProvider[] = current.map(
    (provider) => merged.get(provider.id) ?? provider
  );
  for (const [id, provider] of merged) {
    if (!current.some((stored) => stored.id === id)) result.push(provider);
  }

  return result;
}

/**
 * Merge a patch into the current configuration.
 *
 * Only the fields the patch actually carries are taken — a request that
 * leaves a field out must not reset it.
 */
export function mergeAiConfig(current: AiAnalysisConfig, patch: unknown): AiAnalysisConfig {
  const raw = (patch ?? {}) as Record<string, unknown>;
  const pick = <T>(key: string): T | undefined =>
    raw[key] === undefined ? undefined : (raw[key] as T);

  const providers = pick<unknown[]>("providers");
  const removed = pick<unknown[]>("removeProviders");
  const stages = (pick<Record<string, unknown>>("stages") ?? {}) as Record<string, unknown>;
  const pipeline = (pick<Record<string, unknown>>("pipeline") ?? {}) as Record<string, unknown>;

  const mergedStages: Record<string, unknown> = {
    vision: { ...current.stages.vision, ...(stages.vision as object ?? {}) },
    audio: { ...current.stages.audio, ...(stages.audio as object ?? {}) },
    embed: { ...current.stages.embed, ...(stages.embed as object ?? {}) },
    canonicalizer: {
      ...current.stages.canonicalizer,
      ...(stages.canonicalizer as object ?? {})
    }
  };

  // The providers are merged one by one, so a patch that only changes one
  // provider's limits leaves the others alone. A provider the patch does not
  // mention is kept — a patch must never delete one. A deletion has to be
  // asked for by name.
  const removedIds = new Set(
    (Array.isArray(removed) ? removed : [])
      .map((id) => slugifyProviderId(toString(id)))
      .filter((id) => id !== "")
  );

  let mergedProviders =
    providers === undefined ? current.providers : mergeProviders(current.providers, providers);

  if (removedIds.size > 0) {
    mergedProviders = mergedProviders.filter((provider) => !removedIds.has(provider.id));
  }

  return normalizeAiConfig({
    providers: mergedProviders,
    stages: mergedStages,
    pipeline: { ...current.pipeline, ...pipeline }
  });
}
