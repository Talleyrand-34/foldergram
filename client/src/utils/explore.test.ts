import { describe, expect, it } from 'vitest';

import { shuffleWithSeed, sortExploreItemsByUpdated } from './explore';
import type { FeedItem } from '../types/api';

function createItem(id: number, sortTimestamp: number): FeedItem {
  return {
    id,
    folderId: 11,
    folderSlug: 'album',
    folderName: 'Album',
    folderPath: 'album',
    folderBreadcrumb: null,
    filename: `photo-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp,
    takenAt: sortTimestamp,
    isSaved: true
  };
}

describe('the explore order', () => {
  it('puts the newest first', () => {
    const items = [
      createItem(1, 1_000),
      createItem(2, 3_000),
      createItem(3, 2_000)
    ];

    expect(sortExploreItemsByUpdated(items).map((item) => item.id)).toEqual([2, 3, 1]);
  });

  it('leaves the list it was given alone', () => {
    const items = [createItem(1, 1_000), createItem(2, 3_000)];
    sortExploreItemsByUpdated(items);
    expect(items.map((item) => item.id)).toEqual([1, 2]);
  });

  it('shuffles without losing or duplicating anything', () => {
    const items = Array.from({ length: 20 }, (_, index) => createItem(index, index));
    const shuffled = shuffleWithSeed(items, 12345);

    expect(shuffled).toHaveLength(items.length);
    expect(shuffled.map((item) => item.id).sort((a, b) => a - b)).toEqual(
      items.map((item) => item.id)
    );
    // A shuffle of twenty items is very unlikely to be the identity.
    expect(shuffled.map((item) => item.id)).not.toEqual(items.map((item) => item.id));
  });

  it('keeps the same order for the same seed', () => {
    // The order must not change while the page is open.
    const items = Array.from({ length: 10 }, (_, index) => createItem(index, index));
    expect(shuffleWithSeed(items, 99).map((item) => item.id)).toEqual(
      shuffleWithSeed(items, 99).map((item) => item.id)
    );
    expect(shuffleWithSeed(items, 99).map((item) => item.id)).not.toEqual(
      shuffleWithSeed(items, 100).map((item) => item.id)
    );
  });

  it('breaks a tie on the id, so the order is stable', () => {
    const items = [createItem(5, 1_000), createItem(2, 1_000)];
    expect(sortExploreItemsByUpdated(items).map((item) => item.id)).toEqual([5, 2]);
  });
});
