import { describe, expect, it } from 'vitest';

import { CacheService } from '../src/services/cache-service.js';

/**
 * The cache is optional, so the fallback has to be as good as the server:
 * an answer that is kept is given back, an answer that is not there is
 * computed once — even when several callers ask for it at the same time.
 */
describe('cache service', () => {
  it('keeps an answer and gives it back', async () => {
    const cache = new CacheService();

    await cache.set('a', { value: 1 }, 60_000);

    expect(await cache.get<{ value: number }>('a')).toEqual({ value: 1 });
    expect(cache.stats.hits).toBe(1);
  });

  it('has nothing for a key it never saw', async () => {
    const cache = new CacheService();

    expect(await cache.get('missing')).toBeNull();
    expect(cache.stats.misses).toBe(1);
  });

  it('forgets an answer when it is invalidated', async () => {
    const cache = new CacheService();

    await cache.set('a', 'value', 60_000);
    await cache.invalidate('a');

    expect(await cache.get('a')).toBeNull();
  });

  it('forgets every answer that starts with a prefix', async () => {
    const cache = new CacheService();

    await cache.set('ai:one', 1, 60_000);
    await cache.set('ai:two', 2, 60_000);
    await cache.set('other', 3, 60_000);

    await cache.invalidatePrefix('ai:');

    expect(await cache.get('ai:one')).toBeNull();
    expect(await cache.get('ai:two')).toBeNull();
    expect(await cache.get('other')).toBe(3);
  });

  it('computes an answer it does not have', async () => {
    const cache = new CacheService();
    let calls = 0;

    const load = async () => {
      calls += 1;
      return 'computed';
    };

    expect(await cache.getOrLoad('key', 60_000, load)).toBe('computed');
    expect(await cache.getOrLoad('key', 60_000, load)).toBe('computed');
    expect(calls).toBe(1);
  });

  it('computes an answer once when several callers ask for it at once', async () => {
    const cache = new CacheService();
    let calls = 0;

    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'computed';
    };

    const answers = await Promise.all([
      cache.getOrLoad('key', 60_000, load),
      cache.getOrLoad('key', 60_000, load),
      cache.getOrLoad('key', 60_000, load)
    ]);

    expect(answers).toEqual(['computed', 'computed', 'computed']);
    expect(calls).toBe(1);
  });

  it('keeps a zero, and not only a truthy answer', async () => {
    const cache = new CacheService();

    await cache.set('zero', 0, 60_000);

    expect(await cache.get('zero')).toBe(0);
  });

  it('runs in the process when there is no cache server', () => {
    const cache = new CacheService();

    expect(cache.backend).toBe('memory');
  });

  it('uses the cache server when there is one', () => {
    const cache = new CacheService({ valkeyUrl: 'valkey://127.0.0.1:6379' });

    expect(cache.backend).toBe('valkey');
  });

  it('falls back to the process when the cache server cannot be reached', async () => {
    // Nothing listens on this port, so the server is not there.
    const cache = new CacheService({ valkeyUrl: 'valkey://127.0.0.1:6399' });

    await cache.set('a', 'value', 60_000);

    expect(await cache.get('a')).toBe('value');
    expect(cache.stats.errors).toBeGreaterThan(0);
  });
});
