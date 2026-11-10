import { describe, expect, it } from 'vitest';

import {
  EMPTY_COLLECTION_STATE,
  type CollectionState,
  type CollectionStates
} from '../../plugins/instagram-sync/src/collectionState.js';

/**
 * The status map is stored as one JSON blob in `app_settings`. These tests
 * cover the parsing rules so a corrupt or partial value can never make the
 * UI show nonsense.
 */
function parseStates(raw: string): CollectionStates {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const states: CollectionStates = {};
  for (const [id, value] of Object.entries(parsed)) {
    const entry = (value ?? {}) as Partial<CollectionState>;
    states[id] = {
      name: typeof entry.name === 'string' ? entry.name : '',
      mediaCount: typeof entry.mediaCount === 'number' ? entry.mediaCount : 0,
      syncedCount: typeof entry.syncedCount === 'number' ? entry.syncedCount : 0,
      missingCount: typeof entry.missingCount === 'number' ? entry.missingCount : 0,
      addedCount: typeof entry.addedCount === 'number' ? entry.addedCount : 0,
      status:
        entry.status === 'ok' || entry.status === 'partial' || entry.status === 'failed'
          ? entry.status
          : 'never',
      lastSyncedAt: typeof entry.lastSyncedAt === 'string' ? entry.lastSyncedAt : null,
      lastError: typeof entry.lastError === 'string' ? entry.lastError : null
    };
  }
  return states;
}

describe('instagram-sync collection status', () => {
  it('round-trips a collection status', () => {
    const states = parseStates(
      JSON.stringify({
        '18098245637107833': {
          name: 'arte',
          mediaCount: 47,
          syncedCount: 47,
          missingCount: 0,
          addedCount: 47,
          status: 'ok',
          lastSyncedAt: '2026-11-03T00:00:00.000Z',
          lastError: null
        }
      })
    );

    expect(states['18098245637107833'].name).toBe('arte');
    expect(states['18098245637107833'].mediaCount).toBe(47);
    expect(states['18098245637107833'].syncedCount).toBe(47);
    expect(states['18098245637107833'].status).toBe('ok');
  });

  it('falls back to a never-synced state for a partial record', () => {
    const states = parseStates(JSON.stringify({ abc: { name: 'x' } }));
    expect(states.abc.status).toBe('never');
    expect(states.abc.mediaCount).toBe(0);
    expect(states.abc.lastSyncedAt).toBeNull();
  });

  it('ignores an unknown status', () => {
    const states = parseStates(JSON.stringify({ abc: { status: 'bogus' } }));
    expect(states.abc.status).toBe('never');
  });

  it('has an empty default state', () => {
    expect(EMPTY_COLLECTION_STATE.status).toBe('never');
    expect(EMPTY_COLLECTION_STATE.syncedCount).toBe(0);
    expect(EMPTY_COLLECTION_STATE.lastError).toBeNull();
  });
});
