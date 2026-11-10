/**
 * Persistence for the AI analysis configuration.
 *
 * The configuration lives in the existing `app_settings` key/value store as
 * one JSON blob — the same pattern the instagram-sync plugin uses for its
 * polling configuration. No server migration is needed, and the plugin keeps
 * working with no stored configuration at all: the defaults reproduce the
 * previous behaviour.
 *
 * The API keys live in this blob. They are never returned to the browser:
 * the read path replaces them with a mask, and the write path distinguishes
 * "absent" (keep the stored key) from "empty" (clear it).
 */

import { appSettingsRepository } from "../../../server/dist/db/repositories.js";

import {
  DEFAULT_AUDIO_MODEL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_LITELLM_BASE_URL,
  DEFAULT_PROVIDER_ID,
  DEFAULT_VISION_MODEL,
  mergeAiConfig,
  normalizeAiConfig,
  slugifyProviderId,
  type AiAnalysisConfig,
  type AiProvider,
  type AiProviderUsageLimits,
  type AiSmartUsageLimits
} from "./config.js";

export const AI_ANALYSIS_CONFIG_SETTING_KEY = "ai_analysis.config";

let cached: AiAnalysisConfig | null = null;

/**
 * The configuration as it is in memory, or null before it has been read.
 */
export function cachedAiConfig(): AiAnalysisConfig | null {
  return cached;
}

/** Replace the in-memory copy without touching the database. */
export function setCachedAiConfig(config: AiAnalysisConfig): void {
  cached = normalizeAiConfig(config);
}

/**
 * Read the configuration.
 *
 * The result is cached — the UI is the only writer, and it writes through
 * this module.
 */
export async function readAiConfig(): Promise<AiAnalysisConfig> {
  if (cached) return cached;

  const raw = await appSettingsRepository.get(AI_ANALYSIS_CONFIG_SETTING_KEY);
  if (!raw) {
    cached = seedFromEnv();
    return cached;
  }

  try {
    cached = normalizeAiConfig(JSON.parse(raw));
  } catch {
    cached = seedFromEnv();
  }
  return cached;
}

/** Persist the configuration and refresh the in-memory copy. */
export async function writeAiConfig(config: AiAnalysisConfig): Promise<AiAnalysisConfig> {
  const normalized = normalizeAiConfig(config);
  await appSettingsRepository.set(
    AI_ANALYSIS_CONFIG_SETTING_KEY,
    JSON.stringify(normalized)
  );
  cached = normalized;
  return normalized;
}

/**
 * The configuration a fresh install starts with, seeded from the environment.
 *
 * The environment variables the plugin already read are kept as the initial
 * values, so an existing deployment behaves identically before anyone opens
 * the settings page.
 */
export function seedFromEnv(): AiAnalysisConfig {
  const base = normalizeAiConfig(null);

  const provider: AiProvider = {
    ...base.providers[0],
    baseUrl: (process.env.LITELLM_BASE ?? DEFAULT_LITELLM_BASE_URL).trim().replace(/\/+$/, ""),
    apiKey: process.env.AI_API_KEY ?? "",
    defaultModel: (process.env.AI_VISION_MODEL ?? DEFAULT_VISION_MODEL).trim()
  };

  return normalizeAiConfig({
    ...base,
    providers: [provider],
    stages: {
      ...base.stages,
      vision: { ...base.stages.vision, model: "" },
      audio: {
        ...base.stages.audio,
        model: (process.env.AI_AUDIO_MODEL ?? DEFAULT_AUDIO_MODEL).trim()
      },
      embed: {
        ...base.stages.embed,
        model: (process.env.AI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL).trim()
      },
      canonicalizer: {
        ...base.stages.canonicalizer,
        url: (process.env.LAYA_CLASSIFIER_URL ?? "").trim().replace(/\/+$/, "")
      }
    }
  });
}

/**
 * Merge a patch into the current configuration and persist it.
 *
 * The browser never receives an API key, so a provider arrives here without
 * one. An **absent** `apiKey` means "keep the stored key"; an explicit empty
 * string means "clear it"; any other string replaces it.
 */
export async function saveAiConfigPatch(patch: unknown): Promise<AiAnalysisConfig> {
  const current = await readAiConfig();
  const merged = mergeAiConfig(current, patch);

  const rawProviders = (patch as { providers?: unknown })?.providers;
  if (Array.isArray(rawProviders)) {
    const storedKeys = new Map(current.providers.map((p) => [p.id, p.apiKey]));
    const storedProbeKeys = new Map(
      current.providers.map((p) => [p.id, p.usageLimits.smart.probeApiKey])
    );
    const incomingById = new Map<string, Record<string, unknown>>();
    for (const entry of rawProviders) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const rawId = typeof record.id === "string" ? record.id : "";
      if (!rawId) continue;
      incomingById.set(slugifyProviderId(rawId), record);
    }

    merged.providers = merged.providers.map((provider) => {
      const incoming = incomingById.get(provider.id);
      if (!incoming) return provider;

      // The probe's key is a secret too, and it behaves the same way: an
      // absent key keeps the stored one, an empty one clears it.
      const incomingSmart = incoming.usageLimits as
        | { smart?: { probeApiKey?: unknown } }
        | undefined;
      const incomingProbeKey = incomingSmart?.smart?.probeApiKey;
      const probeKey =
        incomingProbeKey === undefined || incomingProbeKey === null
          ? (storedProbeKeys.get(provider.id) ?? "")
          : String(incomingProbeKey);

      const withKey =
        incoming.apiKey === undefined || incoming.apiKey === null
          ? { ...provider, apiKey: storedKeys.get(provider.id) ?? "" }
          : { ...provider, apiKey: String(incoming.apiKey) };

      return {
        ...withKey,
        usageLimits: {
          ...withKey.usageLimits,
          smart: { ...withKey.usageLimits.smart, probeApiKey: probeKey }
        }
      };
    });
  }

  return writeAiConfig(merged);
}

/**
 * The configuration as the browser may see it.
 *
 * The API key is replaced by a flag and a short mask — enough for the UI to
 * show "a key is set" without ever sending the secret out.
 */
/**
 * The smart mode's settings as the browser may see them.
 *
 * The probe's key is a secret like any other: it is replaced by a flag and a
 * short mask.
 */
export interface AiSmartUsageView extends Omit<AiSmartUsageLimits, "probeApiKey"> {
  /** True when a key is stored for the probe. */
  hasProbeApiKey: boolean;
  /** The last few characters of the stored probe key, for identification. */
  probeApiKeyMasked: string;
}

/** The usage limits as the browser may see them. */
export interface AiProviderUsageLimitsView
  extends Omit<AiProviderUsageLimits, "smart"> {
  smart: AiSmartUsageView;
}

export interface AiProviderView
  extends Omit<AiProvider, "apiKey" | "usageLimits"> {
  /** True when a key is stored for this provider. */
  hasApiKey: boolean;
  /** The last few characters of the stored key, for identification. */
  apiKeyMasked: string;
  /** This provider's usage limits, with the probe's key masked. */
  usageLimits: AiProviderUsageLimitsView;
}

export interface AiConfigView {
  providers: AiProviderView[];
  stages: AiAnalysisConfig["stages"];
  pipeline: AiAnalysisConfig["pipeline"];
}

/** Mask an API key: keep the last four characters, hide the rest. */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "*".repeat(apiKey.length);
  return `${"*".repeat(Math.min(16, apiKey.length - 4))}${apiKey.slice(-4)}`;
}

/** Strip the secrets from a configuration. */
export function toConfigView(config: AiAnalysisConfig): AiConfigView {
  return {
    providers: config.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      dialect: provider.dialect,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      headers: provider.headers,
      reasoningEffort: provider.reasoningEffort,
      thinkingType: provider.thinkingType,
      usageLimits: {
        enabled: provider.usageLimits.enabled,
        budget: provider.usageLimits.budget,
        windows: provider.usageLimits.windows,
        mode: provider.usageLimits.mode,
        smart: {
          probeUrl: provider.usageLimits.smart.probeUrl,
          hasProbeApiKey: provider.usageLimits.smart.probeApiKey !== "",
          probeApiKeyMasked: maskApiKey(provider.usageLimits.smart.probeApiKey),
          watch: provider.usageLimits.smart.watch,
          pollMinutes: provider.usageLimits.smart.pollMinutes,
          idlePercent: provider.usageLimits.smart.idlePercent,
          yieldPercent: provider.usageLimits.smart.yieldPercent,
          contentionPercent: provider.usageLimits.smart.contentionPercent,
          ignoreHardWindows: provider.usageLimits.smart.ignoreHardWindows
        }
      },
      hasApiKey: provider.apiKey !== "",
      apiKeyMasked: maskApiKey(provider.apiKey)
    })),
    stages: config.stages,
    pipeline: config.pipeline
  };
}
