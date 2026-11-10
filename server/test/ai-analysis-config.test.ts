import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AUDIO_MODEL,
  defaultAiConfig,
  mergeAiConfig,
  normalizeAiConfig,
  normalizeFramePositions,
  resolveStage,
  slugifyProviderId,
  validateAiConfig
} from '../../plugins/ai-analysis/src/config.js';

describe('ai-analysis configuration', () => {
  it('defaults to the provider and models the plugin used before', () => {
    const config = defaultAiConfig();

    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].id).toBe('litellm');
    expect(config.providers[0].baseUrl).toBe('http://10.0.2.31:4000/v1');
    expect(config.providers[0].defaultModel).toBe('minimax/MiniMax-M3');
    // The vision stage inherits the provider's default model.
    expect(config.stages.vision.model).toBe('');
    expect(config.stages.audio.model).toBe(DEFAULT_AUDIO_MODEL);
    expect(config.stages.embed.enabled).toBe(false);
    // The canonicalizer needs a URL; without one it is inert.
    expect(config.stages.canonicalizer.url).toBe('');
  });

  it('defaults to three frames at 10%, 50% and 95%', () => {
    const config = defaultAiConfig();
    expect(config.pipeline.frameCount).toBe(3);
    expect(config.pipeline.framePositions).toEqual([0.1, 0.5, 0.95]);
    expect(config.pipeline.extractAudio).toBe(true);
    expect(config.pipeline.writeCaption).toBe(true);
    expect(config.pipeline.updateKnowledgeGraph).toBe(true);
  });

  it('falls back to the defaults for a corrupt value', () => {
    expect(normalizeAiConfig(null)).toEqual(defaultAiConfig());
    expect(normalizeAiConfig('nonsense')).toEqual(defaultAiConfig());
    expect(normalizeAiConfig({})).toEqual(defaultAiConfig());
  });

  it('clamps the numbers into their supported range', () => {
    const config = normalizeAiConfig({
      stages: {
        vision: { maxTokens: 1, timeoutMs: 1 },
        audio: { timeoutMs: 999_999_999 }
      },
      pipeline: { frameCount: 500, minDurationSeconds: -5 }
    });

    expect(config.stages.vision.maxTokens).toBe(128);
    expect(config.stages.vision.timeoutMs).toBe(1000);
    expect(config.stages.audio.timeoutMs).toBe(30 * 60_000);
    expect(config.pipeline.frameCount).toBe(12);
    expect(config.pipeline.minDurationSeconds).toBe(0);
  });

  it('slugifies provider ids and drops duplicates', () => {
    const config = normalizeAiConfig({
      providers: [
        { id: 'My Provider', label: 'A', baseUrl: 'http://a/v1' },
        { id: 'my-provider', label: 'B', baseUrl: 'http://b/v1' },
        { id: 'Second', label: 'C', baseUrl: 'http://c/v1' }
      ]
    });

    expect(config.providers).toHaveLength(2);
    expect(config.providers[0].id).toBe('my-provider');
    expect(config.providers[1].id).toBe('second');
    expect(slugifyProviderId('  Weird Name!! ')).toBe('weird-name');
    expect(slugifyProviderId('')).toBe('provider');
  });

  it('keeps the frame positions sorted and inside (0, 1]', () => {
    expect(normalizeFramePositions([0.9, 0.1, 0.5], 3)).toEqual([0.1, 0.5, 0.9]);
    expect(normalizeFramePositions([0, 2], 2)).toEqual([0.01, 1]);
    // No positions at all — derive evenly spaced ones.
    expect(normalizeFramePositions([], 3)).toHaveLength(3);
    expect(normalizeFramePositions(undefined, 1)).toEqual([0.5]);
  });

  it('only takes the fields a patch actually carries', () => {
    const current = defaultAiConfig();
    const patched = mergeAiConfig(current, { stages: { vision: { maxTokens: 4096 } } });

    expect(patched.stages.vision.maxTokens).toBe(4096);
    // Everything else is untouched.
    expect(patched.stages.vision.providerId).toBe(current.stages.vision.providerId);
    expect(patched.stages.audio.model).toBe(current.stages.audio.model);
    expect(patched.pipeline.frameCount).toBe(current.pipeline.frameCount);
    expect(patched.providers).toHaveLength(current.providers.length);
  });

  it('resolves a stage to its provider and model', () => {
    const config = normalizeAiConfig({
      providers: [
        { id: 'litellm', baseUrl: 'http://a/v1', defaultModel: 'model-a' },
        { id: 'ollama', baseUrl: 'http://b/v1', defaultModel: 'llama3' }
      ],
      stages: {
        vision: { providerId: 'ollama' },
        audio: { providerId: 'litellm', model: 'whisper-1' }
      }
    });

    const vision = resolveStage(config, 'vision');
    expect(vision?.provider.id).toBe('ollama');
    // An empty model means "the provider's default".
    expect(vision?.model).toBe('llama3');

    const audio = resolveStage(config, 'audio');
    expect(audio?.model).toBe('whisper-1');

    // A stage pointing at a provider that is not configured resolves to null.
    const broken = normalizeAiConfig({ stages: { vision: { providerId: 'nope' } } });
    expect(resolveStage(broken, 'vision')).toBeNull();
  });

  it('reports every problem, not just the first', () => {
    const config = normalizeAiConfig({
      providers: [{ id: 'p', baseUrl: 'not-a-url' }],
      stages: {
        vision: { providerId: 'missing' }
      },
      pipeline: { minDurationSeconds: 100, maxDurationSeconds: 50 }
    });

    const errors = validateAiConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.includes('base URL'))).toBe(true);
    expect(errors.some((e) => e.includes('vision stage'))).toBe(true);
    expect(errors.some((e) => e.includes('minimum duration'))).toBe(true);
  });

  it('accepts a healthy configuration', () => {
    expect(validateAiConfig(defaultAiConfig())).toEqual([]);
  });

  it('does not require a canonicalizer URL when the stage is off', () => {
    const config = normalizeAiConfig({
      stages: { canonicalizer: { enabled: false, url: '' } }
    });
    expect(validateAiConfig(config)).toEqual([]);
  });

  it('treats a canonicalizer without a URL as inert rather than broken', () => {
    // This is the state a fresh install starts in: the stage is on, but
    // without a service URL it simply does not run.
    const config = defaultAiConfig();
    expect(config.stages.canonicalizer.enabled).toBe(true);
    expect(config.stages.canonicalizer.url).toBe('');
    expect(validateAiConfig(config)).toEqual([]);
  });
});
