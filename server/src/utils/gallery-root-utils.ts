import fs from 'node:fs/promises';

import { isSupportedMediaFile } from './image-utils.js';
import { isHiddenPath } from './path-utils.js';

/**
 * How long the count of the media files in the gallery root is kept.
 *
 * The gallery root is read over the network on a NAS, and the number is
 * asked for by the status page — which the browser polls. The files that
 * sit directly in the root change when the gallery is rearranged, which
 * happens now and then and not every second.
 */
const COUNT_TTL_MS = 30_000;

/** The last count, and when it was taken. */
let cached: { at: number; count: number } | null = null;

async function countFiles(galleryRoot: string): Promise<number> {
  try {
    const entries = await fs.readdir(galleryRoot, { withFileTypes: true });

    return entries.reduce((count, entry) => {
      if (isHiddenPath(entry.name)) {
        return count;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        return count;
      }

      return isSupportedMediaFile(entry.name) ? count + 1 : count;
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * The media files that sit directly in the gallery root.
 *
 * The count is read from the filesystem, not from the database, so it is
 * kept for a while: the status page asks for it on every poll, and the
 * answer only changes when the gallery root is rearranged.
 */
export async function countSupportedRootMediaFiles(galleryRoot: string): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.at < COUNT_TTL_MS) {
    return cached.count;
  }

  const count = await countFiles(galleryRoot);
  cached = { at: now, count };
  return count;
}

/** Forgets the count. Used by the tests. */
export function resetRootMediaCount(): void {
  cached = null;
}
