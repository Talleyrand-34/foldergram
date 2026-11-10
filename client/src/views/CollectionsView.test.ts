import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionSummary, FeedItem } from '../types/api';
import { useAppStore } from '../stores/app';
import { useCollectionsStore } from '../stores/collections';
import CollectionsView from './CollectionsView.vue';

function createFeedItem(id: number): FeedItem {
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
    sortTimestamp: 1_800_000_000_000 + id,
    takenAt: 1_800_000_000_000 + id,
    isSaved: true
  };
}

function createCollection(
  slug: string,
  name: string,
  isDefault = false,
  previewImages: FeedItem[] = [],
  updatedAt = '2026-04-28T00:00:00.000Z',
  lastAddedAt: string | null = null
): CollectionSummary {
  return {
    id: isDefault ? 1 : Math.abs(slug.length * 17),
    slug,
    name,
    isDefault,
    itemCount: isDefault ? 4 : 2,
    coverImage: previewImages[0] ?? null,
    previewImages,
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt,
    lastAddedAt
  };
}

describe('CollectionsView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('shows All Posts as the first collection card without the synthetic tabs UI', async () => {
    const collectionsStore = useCollectionsStore();
    collectionsStore.$patch({
      loading: false,
      error: null,
      initialized: true,
      items: [
        createCollection('saved', 'Saved', true, [1, 2, 3, 4].map(createFeedItem)),
        createCollection('travel', 'Travel', false, [createFeedItem(9)])
      ]
    });
    vi.spyOn(collectionsStore, 'initialize').mockResolvedValue(undefined);

    const wrapper = mount(CollectionsView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a :data-to="JSON.stringify(to)"><slot /></a>'
          },
          ResilientImage: {
            props: ['src', 'alt'],
            template: '<img data-test="cover" :src="src" :alt="alt" />'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.find('[aria-label="Collections sections"]').exists()).toBe(false);
    const cards = wrapper.findAll('a[data-to]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.text()).toContain('All Posts');
    expect(cards[0]?.attributes('data-to')).toContain('"slug":"saved"');
    expect(cards[0]?.findAll('img[data-test="cover"]')).toHaveLength(4);
    expect(cards[1]?.text()).toContain('Travel');
    expect(cards[1]?.findAll('img[data-test="cover"]')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('Default Collection');
  });

  it('orders by when the last post joined, not by the collection row', async () => {
    // The collection row's own timestamp does not move when a post is
    // added, so the order has to come from the last added post.
    const collectionsStore = useCollectionsStore();
    collectionsStore.$patch({
      loading: false,
      error: null,
      initialized: true,
      items: [
        createCollection(
          'stale',
          'Stale',
          false,
          [createFeedItem(1)],
          '2026-06-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        ),
        createCollection(
          'fresh',
          'Fresh',
          false,
          [createFeedItem(2)],
          '2026-01-01T00:00:00.000Z',
          '2026-06-01T00:00:00.000Z'
        )
      ]
    });
    vi.spyOn(collectionsStore, 'initialize').mockResolvedValue(undefined);

    const appStore = useAppStore();
    appStore.setCollectionsSort('updated');

    const wrapper = mount(CollectionsView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a :data-to="JSON.stringify(to)"><slot /></a>'
          },
          ResilientImage: {
            props: ['src', 'alt'],
            template: '<img data-test="cover" :src="src" :alt="alt" />'
          }
        }
      }
    });

    await flushPromises();

    const names = wrapper.findAll('a[data-to]').map((card) => card.text());
    // The collection that received a post last comes first.
    expect(names[0]).toContain('Fresh');
    expect(names[1]).toContain('Stale');
  });

  it('orders the collections by the chosen rule', async () => {
    const collectionsStore = useCollectionsStore();
    collectionsStore.$patch({
      loading: false,
      error: null,
      initialized: true,
      items: [
        createCollection('zulu', 'Zulu', false, [createFeedItem(1)], '2026-01-01T00:00:00.000Z'),
        createCollection('alpha', 'Alpha', false, [createFeedItem(2)], '2026-06-01T00:00:00.000Z')
      ]
    });
    vi.spyOn(collectionsStore, 'initialize').mockResolvedValue(undefined);

    const appStore = useAppStore();
    appStore.setCollectionsSort('updated');

    const wrapper = mount(CollectionsView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a :data-to="JSON.stringify(to)"><slot /></a>'
          },
          ResilientImage: {
            props: ['src', 'alt'],
            template: '<img data-test="cover" :src="src" :alt="alt" />'
          }
        }
      }
    });

    await flushPromises();

    let names = wrapper.findAll('a[data-to]').map((card) => card.text());
    // The newest comes first.
    expect(names[0]).toContain('Alpha');
    expect(names[1]).toContain('Zulu');

    // And the other rule puts them in order.
    appStore.setCollectionsSort('name');
    await flushPromises();

    names = wrapper.findAll('a[data-to]').map((card) => card.text());
    expect(names[0]).toContain('Alpha');
    expect(names[1]).toContain('Zulu');
  });
});
