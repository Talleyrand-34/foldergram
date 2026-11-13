import { describe, expect, it } from 'vitest';

import { rateLimitAttribution } from '../../plugins/ai-analysis/src/worker.js';

describe('who the rate limit belongs to', () => {
  it('is ours when the plan drains more slowly once we slow down', () => {
    // The plan was being spent at 4 points an hour and now it is at 1.5:
    // it drained more slowly when the queue slowed down, so the queue is
    // what was filling it.
    expect(rateLimitAttribution(1.5, 4)).toBe('ours');
  });

  it('is the other user when the plan keeps draining at the same speed', () => {
    // The queue halved its pace and the plan is still going at the same
    // speed: somebody else is filling it.
    expect(rateLimitAttribution(3.8, 4)).toBe('theirs');
  });

  it('is the other user when the plan is draining even faster', () => {
    expect(rateLimitAttribution(6, 4)).toBe('theirs');
  });

  it('cannot be told without a reading to compare with', () => {
    expect(rateLimitAttribution(null, 4)).toBe('unknown');
    expect(rateLimitAttribution(4, null)).toBe('unknown');
    expect(rateLimitAttribution(null, null)).toBe('unknown');
  });
});
