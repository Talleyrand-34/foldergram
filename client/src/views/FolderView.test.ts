import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { useAuthStore } from '../stores/auth';
import { useFolderStoriesStore } from '../stores/folder-stories';
import { useFoldersStore } from '../stores/folders';
import { useLikesStore } from '../stores/likes';
import type { FeedItem, FolderSummary, LikesMode } from '../types/api';
import FolderView from './FolderView.vue';

const FOLDER_SLUG = 'animal-planet';

function createFeedItem(id: number, folderSlug = FOLDER_SLUG): FeedItem {
  return {
    id,
    folderId: folderSlug === FOLDER_SLUG ? 1 : 2,
    folderSlug,
    folderName: folderSlug,
    folderPath: folderSlug,
    folderBreadcrumb: null,
    filename: `post-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id
  };
}

const folder: FolderSummary = {
  id: 1,
  slug: FOLDER_SLUG,
  name: 'Animal Planet',
  description: null,
  folderPath: FOLDER_SLUG,
  breadcrumb: null,
  imageCount: 4,
  videoCount: 0,
  latestImageMtimeMs: 123,
  avatarImageId: null,
  avatarUrl: null
};

async function mountFolder(
  likedItems: FeedItem[] = [],
  path = `/f/${FOLDER_SLUG}`,
  mode: LikesMode = 'shared'
) {
  const pinia = createPinia();
  setActivePinia(pinia);

  useAuthStore().$patch({ likesMode: mode });

  const likesStore = useLikesStore();
  likesStore.syncFromItems(likedItems, mode);
  likesStore.initialized = true;

  const foldersStore = useFoldersStore();
  vi.spyOn(foldersStore, 'loadFolder').mockImplementation(async () => {
    foldersStore.currentFolder = folder;
    foldersStore.currentImages = [createFeedItem(11), createFeedItem(12)];
    foldersStore.currentHasMore = false;
  });
  vi.spyOn(useFolderStoriesStore(), 'fetchStories').mockResolvedValue();

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/f/:slug', name: 'folder', component: FolderView, props: true }
    ]
  });
  await router.push(path);
  await router.isReady();

  const wrapper = mount(FolderView, {
    props: { slug: FOLDER_SLUG },
    global: {
      plugins: [pinia, router],
      stubs: {
        Avatar: true,
        EmptyState: {
          props: ['title', 'description'],
          template: '<div data-test="empty-state"><h2>{{ title }}</h2><p>{{ description }}</p></div>'
        },
        ErrorState: true,
        FolderGrid: {
          props: ['items', 'variant'],
          template: '<div data-test="folder-grid" :data-variant="variant">{{ items.map(item => item.id).join(",") }}</div>'
        },
        FolderHeader: true,
        InfiniteLoader: {
          template: '<div data-test="infinite-loader" />'
        },
        StoriesModal: true
      }
    }
  });
  await flushPromises();

  return { wrapper, router, likesStore };
}

describe('FolderView Likes tab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the Likes tab only when the folder has liked posts', async () => {
    const { wrapper } = await mountFolder([createFeedItem(100, 'other-folder')]);

    expect(wrapper.find('button[aria-label="Likes"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Reels"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="infinite-loader"]').exists()).toBe(true);

    const likesStore = useLikesStore();
    likesStore.syncFromItems([createFeedItem(21)], 'shared');
    await flushPromises();

    expect(wrapper.find('button[aria-label="Likes"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="Likes"]').attributes('aria-pressed')).toBe('false');
  });

  it('lists only the liked posts of the folder in the Likes tab', async () => {
    const { wrapper, router } = await mountFolder([
      createFeedItem(21),
      createFeedItem(100, 'other-folder'),
      createFeedItem(23)
    ]);

    await wrapper.get('button[aria-label="Likes"]').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.query.tab).toBe('likes');
    expect(wrapper.get('button[aria-label="Likes"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-test="folder-grid"]').text()).toBe('21,23');
    expect(wrapper.find('[data-test="infinite-loader"]').exists()).toBe(false);
  });

  it('keeps the Likes tab selected when it is opened through the query parameter', async () => {
    const { wrapper } = await mountFolder(
      [createFeedItem(21), createFeedItem(100, 'other-folder')],
      `/f/${FOLDER_SLUG}?tab=likes`
    );

    expect(wrapper.get('button[aria-label="Likes"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-test="folder-grid"]').text()).toBe('21');
    expect(wrapper.find('[data-test="infinite-loader"]').exists()).toBe(false);
  });

  it('shows the likes empty state when the folder has no liked posts', async () => {
    const { wrapper } = await mountFolder(
      [createFeedItem(100, 'other-folder')],
      `/f/${FOLDER_SLUG}?tab=likes`
    );

    const emptyState = wrapper.get('[data-test="empty-state"]');
    expect(emptyState.text()).toContain('No liked posts yet');
    expect(emptyState.text()).toContain('Tap the heart under any post and it will appear here.');
    expect(wrapper.find('[data-test="folder-grid"]').exists()).toBe(false);
  });
});
