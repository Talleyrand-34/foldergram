import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLL_INTERVAL_MINUTES,
  MAX_POLL_INTERVAL_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
  clampIntervalMinutes,
  defaultPollConfig,
  isValidIntervalMinutes,
  mergePollConfig,
  normalizePollConfig,
  pollCollectionSelection
} from '../../plugins/instagram-sync/src/pollConfig.js';
import {
  describeSelection,
  selectCollections,
  type MirrorSelection
} from '../../plugins/instagram-sync/src/collectionSelection.js';
import type { InstagramCollection } from '../../plugins/instagram-sync/src/instagramCollections.js';

const COLLECTIONS: InstagramCollection[] = [
  { id: '1', name: 'repo', type: 'MediaCollection', isAuto: false },
  { id: '2', name: 'Travel', type: 'MediaCollection', isAuto: false },
  { id: '3', name: 'recipes', type: 'MediaCollection', isAuto: false },
  { id: 'auto', name: 'All posts', type: 'IGAllMediaAutoCollection', isAuto: true }
];

describe('instagram-sync polling configuration', () => {
  it('starts with the library and the collections polled every four hours', () => {
    const config = defaultPollConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalMinutes).toBe(DEFAULT_POLL_INTERVAL_MINUTES);
    expect(DEFAULT_POLL_INTERVAL_MINUTES).toBe(240);
    expect(config.library).toBe(true);
    expect(config.collections).toBe(true);
    expect(config.collectionMode).toBe('all');
  });

  it('clamps the interval into the supported range', () => {
    expect(clampIntervalMinutes(1)).toBe(MIN_POLL_INTERVAL_MINUTES);
    expect(clampIntervalMinutes(10 ** 9)).toBe(MAX_POLL_INTERVAL_MINUTES);
    expect(clampIntervalMinutes(240)).toBe(240);
    expect(clampIntervalMinutes('240')).toBe(240);
    expect(clampIntervalMinutes('nonsense')).toBe(DEFAULT_POLL_INTERVAL_MINUTES);
    expect(clampIntervalMinutes(undefined)).toBe(DEFAULT_POLL_INTERVAL_MINUTES);
  });

  it('rejects an interval outside the range instead of clamping it', () => {
    expect(isValidIntervalMinutes(240)).toBe(true);
    expect(isValidIntervalMinutes(MIN_POLL_INTERVAL_MINUTES)).toBe(true);
    expect(isValidIntervalMinutes(MAX_POLL_INTERVAL_MINUTES)).toBe(true);
    expect(isValidIntervalMinutes(1)).toBe(false);
    expect(isValidIntervalMinutes(MAX_POLL_INTERVAL_MINUTES + 1)).toBe(false);
    expect(isValidIntervalMinutes('nonsense')).toBe(false);
  });

  it('falls back to the defaults for a corrupt or empty value', () => {
    expect(normalizePollConfig(null)).toEqual(defaultPollConfig());
    expect(normalizePollConfig('nonsense')).toEqual(defaultPollConfig());
    expect(normalizePollConfig({ intervalMinutes: 'nonsense' }).intervalMinutes).toBe(
      DEFAULT_POLL_INTERVAL_MINUTES
    );
  });

  it('keeps only the fields it knows about', () => {
    const config = normalizePollConfig({
      enabled: false,
      intervalMinutes: 60,
      library: false,
      collections: true,
      collectionMode: 'selected',
      collectionIds: ['1', '2', '2', '  ', 7],
      collectionNames: ['repo', 'Travel'],
      somethingElse: 'ignored'
    });

    expect(config.enabled).toBe(false);
    expect(config.intervalMinutes).toBe(60);
    expect(config.library).toBe(false);
    expect(config.collections).toBe(true);
    expect(config.collectionMode).toBe('selected');
    // Duplicates and blanks are dropped; a non-string entry is ignored.
    expect(config.collectionIds).toEqual(['1', '2']);
    expect(config.collectionNames).toEqual(['repo', 'Travel']);
    expect('somethingElse' in config).toBe(false);
  });

  it('only takes the fields a patch actually carries', () => {
    const current = defaultPollConfig();
    const patched = mergePollConfig(current, { library: false });

    expect(patched.library).toBe(false);
    // Everything else is untouched.
    expect(patched.enabled).toBe(current.enabled);
    expect(patched.intervalMinutes).toBe(current.intervalMinutes);
    expect(patched.collections).toBe(current.collections);
    expect(patched.collectionMode).toBe(current.collectionMode);
  });

  it('maps the configuration onto the collections the poll mirrors', () => {
    const all = defaultPollConfig();
    expect(pollCollectionSelection(all)).toBeNull();

    const noCollections = { ...all, collections: false };
    expect(pollCollectionSelection(noCollections)).toBeNull();

    const selected = {
      ...all,
      collectionMode: 'selected' as const,
      collectionIds: ['1'],
      collectionNames: ['repo']
    };
    expect(pollCollectionSelection(selected)).toEqual({
      ids: ['1'],
      names: ['repo']
    });
  });
});

describe('instagram-sync collection selection', () => {
  it('mirrors every collection but the catch-all when nothing is selected', () => {
    const selected = selectCollections(COLLECTIONS, null);
    expect(selected.map((collection) => collection.name)).toEqual(['repo', 'Travel', 'recipes']);
  });

  it('narrows the mirror down to the selected ids', () => {
    const selection: MirrorSelection = { ids: ['2'] };
    const selected = selectCollections(COLLECTIONS, selection);
    expect(selected.map((collection) => collection.name)).toEqual(['Travel']);
  });

  it('matches names case-insensitively', () => {
    const selection: MirrorSelection = { names: ['travel'] };
    const selected = selectCollections(COLLECTIONS, selection);
    expect(selected.map((collection) => collection.name)).toEqual(['Travel']);
  });

  it('mirrors nothing when the selection is empty', () => {
    expect(selectCollections(COLLECTIONS, { ids: [], names: [] })).toEqual([]);
    expect(selectCollections(COLLECTIONS, { ids: ['   '] })).toEqual([]);
  });

  it('never mirrors the catch-all collection', () => {
    const selection: MirrorSelection = { ids: ['auto'] };
    expect(selectCollections(COLLECTIONS, selection)).toEqual([]);
  });

  it('describes a selection for the log', () => {
    expect(describeSelection(null)).toBe('all collections');
    expect(describeSelection({ names: ['repo', 'Travel'] })).toBe('repo, Travel');
    expect(describeSelection({ ids: ['1'] })).toBe('1');
    expect(describeSelection({})).toBe('no collection');
  });
});
