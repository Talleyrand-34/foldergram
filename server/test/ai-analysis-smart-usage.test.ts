import { describe, expect, it } from 'vitest';

import {
  defaultSmartUsageLimits,
  normalizeAiConfig,
  normalizeSmartUsageLimits,
  type AiProvider
} from '../../plugins/ai-analysis/src/config.js';
import {
  parsePoolState,
  resolveProbeKey,
  resolveProbeUrl
} from '../../plugins/ai-analysis/src/lib/pool-probe.js';
import { detectContention } from '../../plugins/ai-analysis/src/lib/smart-usage.js';
import {
  noteProviderRequest,
  providerRequestsBetween,
  providerRequestsSince,
  resetProviderRequests
} from '../../plugins/ai-analysis/src/lib/request-counter.js';

/** A provider as the configuration stores it. */
function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  const base = normalizeAiConfig({
    providers: [
      {
        id: 'minimax',
        label: 'MiniMax',
        dialect: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        defaultModel: 'MiniMax-M3'
      }
    ]
  }).providers[0];

  return { ...base, ...overrides };
}

describe('ai-analysis the shared plan', () => {
  it('reads the plan the way MiniMax publishes it', () => {
    const body = {
      model_remains: [
        {
          model_name: 'MiniMax-M3',
          start_time: 1788264000000,
          end_time: 1788282000000,
          current_interval_total_count: 100000,
          current_interval_usage_count: 91000,
          current_interval_remaining_percent: 91,
          weekly_start_time: 1787688000000,
          weekly_end_time: 1788292800000,
          current_weekly_total_count: 300000,
          current_weekly_usage_count: 210000,
          current_weekly_remaining_percent: 70
        }
      ]
    };

    const state = parsePoolState('minimax', body, 'MiniMax-M3');
    expect(state.ok).toBe(true);
    expect(state.model).toBe('MiniMax-M3');
    expect(state.windows).toHaveLength(2);

    const interval = state.windows.find((w) => w.kind === 'interval')!;
    expect(interval.total).toBe(100000);
    expect(interval.used).toBe(91000);
    expect(interval.remainingPercent).toBe(91);
    // The plan's window is five hours long.
    expect(interval.endTime - interval.startTime).toBe(5 * 3600 * 1000);

    const weekly = state.windows.find((w) => w.kind === 'weekly')!;
    expect(weekly.total).toBe(300000);
    expect(weekly.used).toBe(210000);
    expect(weekly.endTime - weekly.startTime).toBe(7 * 24 * 3600 * 1000);
  });

  it('refuses a plan that reports no windows', () => {
    const state = parsePoolState('minimax', { model_remains: [] }, 'MiniMax-M3');
    expect(state.ok).toBe(false);
    expect(state.error).toContain('no windows');
  });

  it('derives the plan endpoint for a MiniMax provider', () => {
    expect(resolveProbeUrl(provider())).toBe(
      'https://api.minimax.io/v1/token_plan/remains'
    );
  });

  it('takes the plan endpoint from the settings when it is given', () => {
    const configured = provider({
      usageLimits: {
        ...provider().usageLimits,
        smart: { ...defaultSmartUsageLimits(), probeUrl: 'http://plan.local/remains' }
      }
    });
    expect(resolveProbeUrl(configured)).toBe('http://plan.local/remains');
  });

  it('uses the provider own key when the plan has none of its own', () => {
    expect(resolveProbeKey(provider({ apiKey: 'sk-test' }))).toBe('sk-test');

    const withOwn = provider({
      apiKey: 'sk-test',
      usageLimits: {
        ...provider().usageLimits,
        smart: { ...defaultSmartUsageLimits(), probeApiKey: 'sk-plan' }
      }
    });
    expect(resolveProbeKey(withOwn)).toBe('sk-plan');
  });
});

describe('ai-analysis contention', () => {
  it('calls the plan free when everything it used was ours', () => {
    const verdict = detectContention(100, 100, 0, 5);
    expect(verdict.contended).toBe(false);
    expect(verdict.residual).toBe(0);
    expect(verdict.unit).toBe('requests');
  });

  it('calls the plan shared when somebody else used it', () => {
    // The plan moved by 100 and we only sent 60: 40 are somebody else's.
    const verdict = detectContention(100, 60, 0, 5);
    expect(verdict.contended).toBe(true);
    expect(verdict.residual).toBe(40);
  });

  it('calls the plan shared when it moved while we were idle', () => {
    const verdict = detectContention(12, 0, 0, 5);
    expect(verdict.contended).toBe(true);
    expect(verdict.residual).toBe(12);
  });

  it('calls the plan free when nobody used it at all', () => {
    const verdict = detectContention(0, 0, 0, 5);
    expect(verdict.contended).toBe(false);
  });

  it('falls back to the tokens when the plan counts more than requests', () => {
    // Our requests exceed the plan's drain, so the plan cannot be counting
    // requests — it counts tokens, and the tokens explain the drain.
    const verdict = detectContention(500, 800, 480, 5);
    expect(verdict.unit).toBe('tokens');
    expect(verdict.contended).toBe(false);
  });

  it('prefers the tokens when they explain the drain far better', () => {
    // A plan that counts tokens leaves a huge residual behind the requests.
    // Only the tokens clear it.
    const verdict = detectContention(9000, 6, 9000, 5);
    expect(verdict.unit).toBe('tokens');
    expect(verdict.contended).toBe(false);
  });

  it('keeps the requests when the plan counts them', () => {
    // The plan moved by 30 and we sent 6. The tokens are far too many to
    // fit, so the requests are the ones to compare.
    const verdict = detectContention(30, 6, 9000, 5);
    expect(verdict.unit).toBe('requests');
    expect(verdict.contended).toBe(true);
  });
});

describe('ai-analysis the smart settings', () => {
  it('starts in the hard mode', () => {
    const limits = defaultSmartUsageLimits();
    expect(limits.pollMinutes).toBe(2);
    // Use the plan until it is empty, and get out of the way when it is
    // not ours alone.
    expect(limits.idlePercent).toBe(100);
    expect(limits.yieldPercent).toBe(0);
  });

  it('keeps the mode and the smart settings on the provider', () => {
    const config = normalizeAiConfig({
      providers: [
        {
          id: 'minimax',
          baseUrl: 'https://api.minimax.io/v1',
          usageLimits: {
            enabled: true,
            budget: 100,
            windows: [],
            mode: 'smart',
            smart: {
              probeUrl: 'https://api.minimax.io/v1/token_plan/remains',
              watch: 'both',
              pollMinutes: 5,
              idlePercent: 80,
              yieldPercent: 10,
              contentionPercent: 20,
              ignoreHardWindows: true
            }
          }
        }
      ]
    });

    const limits = config.providers[0].usageLimits;
    expect(limits.mode).toBe('smart');
    expect(limits.smart.watch).toBe('both');
    expect(limits.smart.pollMinutes).toBe(5);
    expect(limits.smart.idlePercent).toBe(80);
    expect(limits.smart.yieldPercent).toBe(10);
    expect(limits.smart.contentionPercent).toBe(20);
    expect(limits.smart.ignoreHardWindows).toBe(true);
  });

  it('falls back to the hard mode for an unknown mode', () => {
    const limits = normalizeSmartUsageLimits({ mode: 'wild' } as never);
    expect(limits.watch).toBe('interval');
  });
});

describe('ai-analysis the request counter', () => {
  it('counts what was sent', () => {
    resetProviderRequests();
    noteProviderRequest('minimax');
    noteProviderRequest('minimax');
    noteProviderRequest('other');

    expect(providerRequestsSince('minimax', 0)).toBe(2);
    expect(providerRequestsSince('other', 0)).toBe(1);
    expect(providerRequestsSince('nobody', 0)).toBe(0);
  });

  it('counts only what falls inside the span', () => {
    resetProviderRequests();
    noteProviderRequest('minimax');
    const now = Date.now();
    expect(providerRequestsBetween('minimax', now + 60_000, now + 120_000)).toBe(0);
    expect(providerRequestsBetween('minimax', now - 60_000, now + 60_000)).toBe(1);
  });
});
