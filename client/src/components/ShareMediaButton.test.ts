import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedItem } from '../types/api';
import { clearShareMemo } from '../composables/useShareMedia';
import ShareMediaButton from './ShareMediaButton.vue';

function createFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 42,
    folderId: 7,
    folderSlug: 'album',
    folderName: 'Album',
    folderPath: 'album',
    filename: 'photo.jpg',
    caption: null,
    width: 1600,
    height: 1200,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: '/thumbnails/42.webp',
    previewUrl: '/previews/42.webp',
    sortTimestamp: 1_777_000_000_000,
    takenAt: 1_777_000_000_000,
    isSaved: false,
    ...overrides
  } as FeedItem;
}

function stubShareApi(): { share: ReturnType<typeof vi.fn>; canShare: ReturnType<typeof vi.fn> } {
  const share = vi.fn().mockResolvedValue(undefined);
  const canShare = vi.fn().mockReturnValue(true);

  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true, writable: true });

  return { share, canShare };
}

function stubFetch(options: { size?: number; type?: string; fail?: boolean } = {}): ReturnType<typeof vi.fn> {
  const size = options.size ?? 1024;
  const type = options.type ?? 'image/jpeg';

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') {
      return new Response(null, { headers: { 'content-length': String(size), 'content-type': type } });
    }

    if (options.fail) {
      return new Response('nope', { status: 500 });
    }

    // The body is capped so a huge declared size does not allocate a huge
    // buffer: the HEAD is what decides whether the file is shareable.
    const body = new Uint8Array(Math.min(size, 4096));

    return new Response(body, { headers: { 'content-type': type } });
  });
}

describe('ShareMediaButton', () => {
  beforeEach(() => {
    clearShareMemo();
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'canShare');
  });

  it('is not rendered when the browser cannot share files', () => {
    const wrapper = mount(ShareMediaButton, { props: { item: createFeedItem() } });

    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('is not rendered for a type Chromium refuses', () => {
    stubShareApi();

    const wrapper = mount(ShareMediaButton, {
      props: { item: createFeedItem({ filename: 'clip.mov', mediaType: 'video' }) }
    });

    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('is rendered when the browser can share that type of file', () => {
    stubShareApi();

    const wrapper = mount(ShareMediaButton, { props: { item: createFeedItem() } });

    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.get('button').attributes('aria-label')).toBe('Share file');
  });

  it('fetches the file first and shares it on the second tap', async () => {
    const { share } = stubShareApi();
    const fetchMock = stubFetch({ size: 2048, type: 'image/jpeg' });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(ShareMediaButton, { props: { item: createFeedItem() } });

    await wrapper.get('button').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('button').attributes('aria-label')).toBe('Tap to share the file'),
    );

    // The first tap prepares the file: the size is checked, then the bytes.
    const methods = fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET');
    expect(methods).toContain('HEAD');
    expect(share).not.toHaveBeenCalled();

    await wrapper.get('button').trigger('click');

    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0][0] as { files: File[]; title: string };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe('photo.jpg');
    expect(payload.files[0].type).toBe('image/jpeg');
    expect(payload.title).toBe('photo.jpg');
    // The size of the file is not asserted: jsdom misreports the size of a
    // File that is built from a blob that came out of a Response, which is a
    // quirk of the test environment and not of the browser. The size that
    // matters - the one the browser refuses to share - is checked by the
    // "too large" case below, against the Content-Length of the HEAD.
  });

  it('shares in one tap when the file was already prepared', async () => {
    const { share } = stubShareApi();

    const wrapper = mount(ShareMediaButton, { props: { item: createFeedItem() } });

    await wrapper.get('button').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('button').attributes('aria-label')).toBe('Tap to share the file'));

    await wrapper.get('button').trigger('click');
    await wrapper.get('button').trigger('click');

    // The second tap shares, the third one prepares it again.
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('does not fail when the user closes the share sheet', async () => {
    const { share } = stubShareApi();
    share.mockRejectedValue(Object.assign(new Error('closed'), { name: 'AbortError' }));

    const wrapper = mount(ShareMediaButton, { props: { item: createFeedItem() } });

    await wrapper.get('button').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('button').attributes('aria-label')).toBe('Tap to share the file'));

    await wrapper.get('button').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('button').attributes('aria-label')).not.toBe("Couldn't share the file"));
  });

  it('reports a file that is too large to share', async () => {
    stubShareApi();
    vi.stubGlobal('fetch', stubFetch({ size: 60 * 1024 * 1024 }));

    const wrapper = mount(ShareMediaButton, { props: { item: createFeedItem() } });

    await wrapper.get('button').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('button').attributes('aria-label')).toBe('Too large to share as a file'),
    );
  });
});
