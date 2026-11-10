/**
 * Listing the models a provider offers.
 *
 * The model names are the easiest thing to get wrong: a typo means the
 * upstream answers "model not found", and the operator sees a queue that
 * refuses to start. So the names are *read* from the provider rather than
 * typed, and the UI offers them as a choice.
 *
 * Not every gateway publishes a model list — the endpoint is a convenience,
 * not a requirement. A provider that does not answer still works; the UI
 * falls back to typing the name.
 */

import { buildProviderHeaders, providerUrl } from "./litellm-client.js";
import type { AiProvider } from "../config.js";

/** What a provider offers. */
export interface ProviderModels {
  /** The provider the list belongs to. */
  providerId: string;
  /** The model names, as the provider spells them. */
  models: string[];
  /** How many the provider advertises in total. */
  modelCount: number;
  /** Why the list could not be read, if it could not. */
  error: string | null;
}

/** A short-lived cache, so a settings page does not hammer the gateway. */
const cache = new Map<string, { at: number; result: ProviderModels }>();
const CACHE_MS = 30_000;

/** Forget the cached lists. Used when the configuration changes. */
export function invalidateModelCache(): void {
  cache.clear();
}

/**
 * Read the model names a provider offers.
 *
 * The list is read from the *stored* provider, so the key is the one the
 * server holds and never has to travel to the browser.
 */
export async function listProviderModels(
  provider: AiProvider,
  now: number = Date.now()
): Promise<ProviderModels> {
  const cached = cache.get(provider.id);
  if (cached && now - cached.at < CACHE_MS) return cached.result;

  const result = await fetchProviderModels(provider);
  cache.set(provider.id, { at: now, result });
  return result;
}

/** Read the model names, without the cache. */
export async function fetchProviderModels(
  provider: AiProvider
): Promise<ProviderModels> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    return {
      providerId: provider.id,
      models: [],
      modelCount: 0,
      error: "the provider has no endpoint"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(providerUrl(provider, "/models"), {
      method: "GET",
      headers: buildProviderHeaders(provider, {}),
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        providerId: provider.id,
        models: [],
        modelCount: 0,
        error: `the provider answered ${response.status}`
      };
    }

    // Some gateways answer with a plain array, others with the OpenAI
    // shape. Both are read.
    let models: string[] = [];
    try {
      const parsed = JSON.parse(text) as {
        data?: Array<{ id?: string }>;
        models?: Array<{ id?: string }>;
      };
      const rows = parsed.data ?? parsed.models ?? [];
      models = rows
        .map((entry) => entry?.id ?? "")
        .filter((modelId): modelId is string => modelId !== "");
    } catch {
      models = [];
    }

    return {
      providerId: provider.id,
      models: models.slice(0, 500),
      modelCount: models.length,
      error: null
    };
  } catch (e) {
    return {
      providerId: provider.id,
      models: [],
      modelCount: 0,
      error: e instanceof Error ? e.message : String(e)
    };
  } finally {
    clearTimeout(timer);
  }
}
