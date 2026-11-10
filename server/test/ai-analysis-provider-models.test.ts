import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mergeAiConfig,
  normalizeAiConfig,
  type AiAnalysisConfig
} from '../../plugins/ai-analysis/src/config.js';
import {
  fetchProviderModels,
  invalidateModelCache,
  listProviderModels
} from '../../plugins/ai-analysis/src/lib/provider-models.js';

/** A configuration with two providers. */
function twoProviders(): AiAnalysisConfig {
  return normalizeAiConfig({
    providers: [
      {
        id: 'litellm',
        label: 'LiteLLM',
        baseUrl: 'http://10.0.2.31:4000/v1',
        defaultModel: 'minimax/MiniMax-M3'
      },
      {
        id: 'minimax',
        label: 'MiniMax',
        dialect: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        defaultModel: 'MiniMax-M3'
      }
    ],
    stages: { vision: { providerId: 'minimax' } }
  });
}

describe('ai-analysis the provider merge', () => {
  it('keeps the providers a patch does not name', () => {
    // The bug this guards against: a patch that changes one provider used to
    // delete the others.
    const current = twoProviders();
    const merged = mergeAiConfig(current, {
      providers: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          dialect: 'openai-compatible',
          baseUrl: 'http://10.0.2.31:4000/v1',
          defaultModel: 'minimax/MiniMax-M3'
        }
      ]
    });

    expect(merged.providers.map((provider) => provider.id)).toEqual([
      'litellm',
      'minimax'
    ]);
  });

  it('keeps the order and appends the new providers', () => {
    const current = twoProviders();
    const merged = mergeAiConfig(current, {
      providers: [
        { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1' },
        { id: 'extra', label: 'Extra', baseUrl: 'http://extra.local/v1' }
      ]
    });

    expect(merged.providers.map((provider) => provider.id)).toEqual([
      'litellm',
      'minimax',
      'extra'
    ]);
  });

  it('gives a provider without an id a name of its own', () => {
    const current = twoProviders();
    const merged = mergeAiConfig(current, {
      providers: [
        { id: '', label: 'New one', baseUrl: 'http://new.local/v1' },
        { id: '', label: 'Another one', baseUrl: 'http://other.local/v1' }
      ]
    });

    const ids = merged.providers.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The two new ones do not collide with the stored names either.
    expect(ids).toContain('litellm');
    expect(ids).toContain('minimax');
  });

  it('deletes a provider only when it is named', () => {
    const current = twoProviders();
    const merged = mergeAiConfig(current, {
      providers: [{ id: 'litellm', label: 'LiteLLM', baseUrl: 'http://10.0.2.31:4000/v1' }],
      removeProviders: ['minimax']
    });

    expect(merged.providers.map((provider) => provider.id)).toEqual(['litellm']);
  });

  it('leaves the limits of a provider alone when the patch does not mention them', () => {
    const current = normalizeAiConfig({
      providers: [
        {
          id: 'minimax',
          baseUrl: 'https://api.minimax.io/v1',
          usageLimits: {
            enabled: true,
            budget: 10_000_000,
            windows: [{ hours: 5, percent: 20 }],
            mode: 'smart'
          }
        }
      ]
    });

    const merged = mergeAiConfig(current, {
      providers: [
        {
          id: 'minimax',
          label: 'MiniMax',
          baseUrl: 'https://api.minimax.io/v1'
        }
      ]
    });

    expect(merged.providers[0].usageLimits.enabled).toBe(true);
    expect(merged.providers[0].usageLimits.windows).toEqual([
      { hours: 5, percent: 20 }
    ]);
    expect(merged.providers[0].usageLimits.mode).toBe('smart');
  });
});

describe('ai-analysis the model list', () => {
  afterEach(() => {
    invalidateModelCache();
    vi.unstubAllGlobals();
  });

  it('reads the models the provider offers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'minimax/MiniMax-M3' }, { id: 'whisper-1' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const provider = twoProviders().providers[0];
    const result = await fetchProviderModels(provider);

    expect(result.models).toEqual(['minimax/MiniMax-M3', 'whisper-1']);
    expect(result.modelCount).toBe(2);
    expect(result.error).toBeNull();
  });

  it('reports a gateway that does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    );

    const provider = twoProviders().providers[0];
    const result = await fetchProviderModels(provider);

    expect(result.models).toEqual([]);
    expect(result.error).toContain('404');
  });

  it('reads the list only once for a while', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = twoProviders().providers[0];
    await listProviderModels(provider);
    await listProviderModels(provider);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
