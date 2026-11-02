import { describe, expect, it } from 'vitest';

import { matchesCron, nextRun, parseCron } from '../../plugins/instagram-sync/src/cron.js';

describe('instagram-sync cron matcher', () => {
  it('matches the plugin default expression on the hour it names', () => {
    expect(matchesCron('17 */6 * * *', new Date(2026, 0, 1, 6, 17))).toBe(true);
    expect(matchesCron('17 */6 * * *', new Date(2026, 0, 1, 12, 17))).toBe(true);
    expect(matchesCron('17 */6 * * *', new Date(2026, 0, 1, 18, 17))).toBe(true);
  });

  it('rejects minutes and hours outside the expression', () => {
    expect(matchesCron('17 */6 * * *', new Date(2026, 0, 1, 7, 17))).toBe(false);
    expect(matchesCron('17 */6 * * *', new Date(2026, 0, 1, 6, 18))).toBe(false);
  });

  it('supports step syntax', () => {
    expect(matchesCron('*/15 * * * *', new Date(2026, 0, 1, 0, 30))).toBe(true);
    expect(matchesCron('*/15 * * * *', new Date(2026, 0, 1, 0, 31))).toBe(false);
  });

  it('treats day-of-week 0 and 7 as Sunday', () => {
    // 2026-01-04 is a Sunday.
    expect(matchesCron('0 0 * * 0', new Date(2026, 0, 4))).toBe(true);
    expect(matchesCron('0 0 * * 7', new Date(2026, 0, 4))).toBe(true);
    // 2026-01-05 is a Monday.
    expect(matchesCron('0 0 * * 0', new Date(2026, 0, 5))).toBe(false);
  });

  it('unions day-of-month and day-of-week when both are restricted', () => {
    // 2026-01-04 is the 4th (a Sunday); 2026-01-20 is the 20th (a Tuesday).
    expect(matchesCron('0 0 20 * 0', new Date(2026, 0, 4))).toBe(true);
    expect(matchesCron('0 0 20 * 0', new Date(2026, 0, 20))).toBe(true);
    expect(matchesCron('0 0 20 * 0', new Date(2026, 0, 21))).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * *')).toThrow();
    expect(() => parseCron('99 * * * *')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
    expect(() => parseCron('a * * * *')).toThrow();
  });

  it('computes the next matching time', () => {
    const next = nextRun('17 */6 * * *', new Date(2026, 0, 1, 6, 17, 30));
    expect(next?.getHours()).toBe(12);
    expect(next?.getMinutes()).toBe(17);
  });

  it('returns null when the expression can never match', () => {
    // February 30th does not exist.
    expect(nextRun('0 0 30 2 *', new Date(2026, 0, 1))).toBeNull();
  });
});
