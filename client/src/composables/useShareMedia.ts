import { ref, type Ref } from 'vue';

import { getOriginalMediaUrl } from '../utils/original-media';
import {
  buildShareFileName,
  resolveShareMimeType,
  SHARE_MAX_BYTES
} from '../utils/share-media';

export type ShareOutcome = 'shared' | 'cancelled' | 'error';

export type ShareState = 'idle' | 'preparing' | 'ready' | 'too-large' | 'failed';

/** How many prepared files are kept in memory at the same time. */
const MEMO_LIMIT = 3;

/**
 * The files that were already fetched, by media id.
 *
 * A file of tens of megabytes must not pile up, so the memo is small and
 * nothing above the size cap is ever cached.
 */
const memo = new Map<number, File>();

function memoize(id: number, file: File): void {
  memo.delete(id);
  memo.set(id, file);

  while (memo.size > MEMO_LIMIT) {
    const oldest = memo.keys().next();

    if (oldest.done) {
      break;
    }

    memo.delete(oldest.value);
  }
}

export function forgetSharedFile(id: number): void {
  memo.delete(id);
}

/** Drops every prepared file. Used by the tests and when the library changes. */
export function clearShareMemo(): void {
  memo.clear();
}

export interface ShareMediaOptions {
  /** The id of the media to share. */
  readonly id: number;
  /** The stored file name, used for the shared file name. */
  readonly filename: string;
  /** The MIME type of the media, when the caller knows it. */
  readonly mimeType?: string | null;
}

export interface ShareMediaController {
  readonly state: Ref<ShareState>;
  /** Whether the file is already in memory and can be shared right away. */
  readonly isReady: Ref<boolean>;
  /** Whether the file is bigger than the browser is willing to share. */
  readonly isTooLarge: Ref<boolean>;
  /** Prepares the file, or shares it when it is already prepared. */
  share(): Promise<ShareOutcome>;
}

/**
 * Shares a media file with the OS share sheet.
 *
 * The browser only opens the share sheet inside a live user gesture, and that
 * gesture lives for five seconds. Downloading the file first and sharing it
 * later would break that rule, so the button has two states: the first tap
 * fetches the file and the second one opens the sheet.
 */
export function useShareMedia(options: ShareMediaOptions): ShareMediaController {
  const state = ref<ShareState>('idle');
  const isReady = ref(false);
  const isTooLarge = ref(false);

  async function fetchFile(): Promise<File | null> {
    const response = await fetch(getOriginalMediaUrl(options.id), {
      credentials: 'same-origin'
    });

    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();
    const name = buildShareFileName(options.filename);
    const type = resolveShareMimeType(options.filename, blob.type || options.mimeType);

    return new File([blob], name, { type });
  }

  async function prepare(): Promise<ShareOutcome> {
    const cached = memo.get(options.id);

    if (cached) {
      return openSheet(cached);
    }

    state.value = 'preparing';

    try {
      // The size is checked before the bytes are fetched: a file that the
      // browser would refuse to share must not be downloaded first.
      const head = await fetch(getOriginalMediaUrl(options.id), {
        method: 'HEAD',
        credentials: 'same-origin'
      });

      const length = Number(head.headers.get('content-length') ?? '0');

      if (Number.isFinite(length) && length > SHARE_MAX_BYTES) {
        isTooLarge.value = true;
        state.value = 'too-large';
        return 'error';
      }

      const file = await fetchFile();

      if (!file) {
        state.value = 'failed';
        return 'error';
      }

      memoize(options.id, file);
      isReady.value = true;
      state.value = 'ready';

      // The gesture is still alive when the file was small and fast enough,
      // so the sheet can open right away.
      if (typeof navigator !== 'undefined' && navigator.userActivation?.isActive) {
        return openSheet(file);
      }

      return 'cancelled';
    } catch {
      state.value = 'failed';
      return 'error';
    }
  }

  async function openSheet(file: File): Promise<ShareOutcome> {
    try {
      await navigator.share({ files: [file], title: file.name });
      forgetSharedFile(options.id);
      state.value = 'idle';
      isReady.value = false;
      return 'shared';
    } catch (error) {
      const name = (error as DOMException)?.name;

      if (name === 'AbortError') {
        // The user closed the sheet: not a failure.
        return 'cancelled';
      }

      if (name === 'NotAllowedError') {
        // Either the gesture expired or the payload is too big.
        state.value = 'failed';
        return 'error';
      }

      state.value = 'failed';
      return 'error';
    }
  }

  async function share(): Promise<ShareOutcome> {
    if (isReady.value) {
      const cached = memo.get(options.id);

      if (cached) {
        return openSheet(cached);
      }
    }

    return prepare();
  }

  return {
    state,
    isReady,
    isTooLarge,
    share
  };
}
