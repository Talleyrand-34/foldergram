import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { countSupportedRootMediaFiles, resetRootMediaCount } from '../src/utils/gallery-root-utils.js';

describe('gallery root media detection', () => {
  let tempRoot = '';

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-gallery-root-utils-'));
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('counts supported media directly in the gallery root and ignores nested or hidden entries', async () => {
    await fs.mkdir(path.join(tempRoot, 'album-one'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(tempRoot, 'photo-1.jpg'), 'a'),
      fs.writeFile(path.join(tempRoot, 'clip-1.mp4'), 'b'),
      fs.writeFile(path.join(tempRoot, 'notes.txt'), 'c'),
      fs.writeFile(path.join(tempRoot, '.hidden.jpg'), 'd'),
      fs.writeFile(path.join(tempRoot, 'album-one', 'nested-photo.jpg'), 'e')
    ]);

    resetRootMediaCount();
    expect(await countSupportedRootMediaFiles(tempRoot)).toBe(2);
  });

  it('returns zero when the gallery root does not exist', async () => {
    resetRootMediaCount();
    expect(await countSupportedRootMediaFiles(path.join(tempRoot, 'missing-root'))).toBe(0);
  });

  it('keeps the count for a while instead of reading the folder again', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-gallery-root-count-'));
    try {
      await fs.writeFile(path.join(root, 'photo-1.jpg'), 'a');
      resetRootMediaCount();

      expect(await countSupportedRootMediaFiles(root)).toBe(1);

      // The file is gone, but the count is kept: the status page asks for it
      // on every poll, and the gallery root is on a network disk.
      await fs.rm(path.join(root, 'photo-1.jpg'));
      expect(await countSupportedRootMediaFiles(root)).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
