import { describe, expect, it } from 'vitest';

import {
  defaultProviderUsageLimits,
  normalizeProviderUsageLimits,
  normalizeAiConfig,
  resolveStage
} from '../../plugins/ai-analysis/src/config.js';
import { windowBudget } from '../../plugins/ai-analysis/src/usage.js';
import {
  classifyUpstreamFault,
  isQuotaFault
} from '../../plugins/ai-analysis/src/lib/litellm-client.js';

describe('ai-analysis per-provider usage limits', () => {
  it('starts switched off', () => {
    const limits = defaultProviderUsageLimits();
    expect(limits.enabled).toBe(false);
    expect(limits.budget).toBe(0);
    expect(limits.windows).toEqual([]);
  });

  it('keeps a window of any length', () => {
    // A MiniMax plan counts over a rolling 5-hour window, not a whole day.
    const limits = normalizeProviderUsageLimits({
      enabled: true,
      budget: 10_000_000,
      windows: [
        { hours: 5, percent: 20 },
        { hours: 168, percent: 80 }
      ]
    });

    expect(limits.enabled).toBe(true);
    expect(limits.budget).toBe(10_000_000);
    expect(limits.windows).toEqual([
      { hours: 5, percent: 20 },
      { hours: 168, percent: 80 }
    ]);
  });

  it('sorts the windows by length and drops a duplicate length', () => {
    const limits = normalizeProviderUsageLimits({
      windows: [
        { hours: 168, percent: 80 },
        { hours: 5, percent: 20 },
        { hours: 168, percent: 50 }
      ]
    });

    expect(limits.windows).toEqual([
      { hours: 5, percent: 20 },
      { hours: 168, percent: 80 }
    ]);
  });

  it('rejects a window that is not a length', () => {
    const limits = normalizeProviderUsageLimits({
      windows: [{ hours: 0, percent: 20 }, { hours: -5, percent: 20 }]
    });
    expect(limits.windows).toEqual([]);
  });

  it('clamps a share to a percentage', () => {
    const limits = normalizeProviderUsageLimits({
      windows: [{ hours: 5, percent: 500 }]
    });
    expect(limits.windows[0].percent).toBe(100);
  });

  it('turns a window share into a token budget', () => {
    const limits = { hours: 5, percent: 20 };
    // 20 % of a 10M budget.
    expect(windowBudget(10_000_000, limits)).toBe(2_000_000);
    // A window without a share has no budget.
    expect(windowBudget(10_000_000, { hours: 5, percent: 0 })).toBe(0);
    expect(windowBudget(0, limits)).toBe(0);
  });

  it('keeps the limits on the provider, not at the top level', () => {
    const config = normalizeAiConfig({
      providers: [
        {
          id: 'minimax',
          baseUrl: 'https://api.minimax.io/v1',
          defaultModel: 'MiniMax-M3',
          usageLimits: {
            enabled: true,
            budget: 10_000_000,
            windows: [{ hours: 5, percent: 20 }, { hours: 168, percent: 80 }]
          }
        }
      ]
    });

    expect(config.providers[0].usageLimits.enabled).toBe(true);
    expect(config.providers[0].usageLimits.windows).toHaveLength(2);
    // There is no shared budget any more.
    expect('usageLimits' in config).toBe(false);
  });

  it('leaves the limits of a provider alone when a patch does not mention them', () => {
    const config = normalizeAiConfig({
      providers: [
        {
          id: 'minimax',
          baseUrl: 'https://api.minimax.io/v1',
          usageLimits: { enabled: true, budget: 500, windows: [{ hours: 5, percent: 20 }] }
        }
      ],
      stages: { vision: { providerId: 'minimax' } }
    });

    const resolved = resolveStage(config, 'vision');
    expect(resolved?.provider.usageLimits.enabled).toBe(true);
    expect(resolved?.provider.usageLimits.windows).toEqual([
      { hours: 5, percent: 20 }
    ]);
  });
});

describe('ai-analysis upstream fault classification', () => {
  it('recognises a spent quota, even behind a gateway 500', () => {
    // The gateway wraps the provider's error, so the status is a 500 and the
    // real reason is in the body.
    const detail =
      'litellm.APIConnectionError: MinimaxException - {"type":"error",' +
      '"error":{"type":"insufficient_balance_error","message":"The Token Plan ' +
      'usage limit has been reached."}}';

    expect(isQuotaFault(detail, 500)).toBe(true);
    expect(classifyUpstreamFault(detail, 500)).toBe('quota');
  });

  it('recognises a 402 as a quota', () => {
    expect(classifyUpstreamFault('payment required', 402)).toBe('quota');
  });

  it('recognises the other quota wordings', () => {
    expect(isQuotaFault('insufficient_quota', 429)).toBe(true);
    expect(isQuotaFault('You exceeded your current quota', 500)).toBe(true);
    expect(isQuotaFault('resource_exhausted', 429)).toBe(true);
  });

  it('treats a rejected key as a configuration fault', () => {
    expect(classifyUpstreamFault('invalid api key', 401)).toBe('configuration');
    expect(classifyUpstreamFault('authentication_error', 403)).toBe('configuration');
    expect(classifyUpstreamFault('model_not_found', 404)).toBe('configuration');
    // Even behind a gateway 500.
    expect(classifyUpstreamFault('invalid api key', 500)).toBe('configuration');
  });

  it('treats an unreachable service as transient', () => {
    expect(classifyUpstreamFault('getaddrinfo ENOTFOUND', null)).toBe('unreachable');
    expect(classifyUpstreamFault('Internal Server Error', 500)).toBe('unreachable');
  });
});
