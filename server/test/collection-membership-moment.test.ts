import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AppConfigModule = typeof import('../src/config/env.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');

/**
 * When a media joined a collection.
 *
 * The moment is what the collections are ordered by ("the collection with
 * the last added post comes up"), and what the collection view shows. It has
 * to survive a re-add — and the mirror re-adds the whole collection on every
 * poll, so a re-add that restamped the moment would leave every collection
 * with the poll's timestamp.
 */
describe.sequential('the moment a media joined a collection', () => {
  let tempRoot = '';
  let appConfig: AppConfigModule['appConfig'];
  let collectionRepository: RepositoriesModule['collectionRepository'];
  let imageRepository: RepositoriesModule['imageRepository'];
  let folderRepository: RepositoriesModule['folderRepository'];

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-moment-'));

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATA_ROOT', path.join(tempRoot, 'data'));
    vi.stubEnv('GALLERY_ROOT', path.join(tempRoot, 'gallery'));
    vi.stubEnv('DB_DIR', path.join(tempRoot, 'db'));
    vi.stubEnv('THUMBNAILS_DIR', path.join(tempRoot, 'thumbnails'));
    vi.stubEnv('PREVIEWS_DIR', path.join(tempRoot, 'previews'));
  });

  beforeEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    vi.resetModules();
    ({ appConfig } = await import('../src/config/env.js'));
    ({ collectionRepository, folderRepository, imageRepository } = await import(
      '../src/db/repositories.js'
    ));
    await (await import('../src/db/repositories.js')).initRepositories();

    await Promise.all([
      fs.mkdir(appConfig.galleryRoot, { recursive: true }),
      fs.mkdir(appConfig.thumbnailsDir, { recursive: true }),
      fs.mkdir(appConfig.previewsDir, { recursive: true })
    ]);
  });

  afterAll(async () => {
    // The storage paths are stubbed for this file - they have to be restored,
    // otherwise the next test file in the same worker process would inherit a
    // DATA_ROOT that points at a directory that no longer exists.
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  /** A folder with one indexed image in it. */
  async function seedImage(name: string): Promise<number> {
    const folder = await folderRepository.upsert({
      slug: name,
      name,
      folderPath: name,
      role: 'normal' as never
    });

    const relativePath = `${name}/${name}.jpg`;
    const absolutePath = path.join(appConfig.galleryRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `source:${relativePath}`);

    const image = await imageRepository.upsert({
      folderId: folder.id,
      filename: `${name}.jpg`,
      extension: '.jpg',
      relativePath,
      absolutePath,
      fileSize: 2_048,
      width: 1_600,
      height: 1_200,
      mediaType: 'image' as never,
      mimeType: 'image/jpeg',
      durationMs: null,
      isAnimated: false,
      fingerprint: `fingerprint-${name}`,
      mtimeMs: 1_700_000_000_000,
      firstSeenAt: new Date(1_700_000_000_000).toISOString(),
      sortTimestamp: 1_700_000_000_000,
      takenAt: 1_700_000_000_000,
      takenAtSource: 'mtime',
      exifJson: '{}',
      thumbnailPath: `thumbnails/${name}.webp`,
      previewPath: `previews/${name}.webp`,
    } as never);

    return image.id;
  }

  it('keeps the moment when the same media is added again', async () => {
    const imageId = await seedImage('album');

    const collection = await collectionRepository.create('Travel');
    await collectionRepository.addImage(collection.slug, imageId);

    const summaries = await collectionRepository.listSummaries();
    const first = summaries.find((entry) => entry.slug === collection.slug);
    const addedAt = first?.last_added_at;
    expect(addedAt).toBeTruthy();

    // The mirror adds the whole collection again on every poll.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collectionRepository.addImage(collection.slug, imageId);

    const after = await collectionRepository.listSummaries();
    const second = after.find((entry) => entry.slug === collection.slug);

    // The moment is the same — the media did not join again.
    expect(second?.last_added_at).toBe(addedAt);
    // And the collection itself did not change either.
    expect(second?.updated_at).toBe(first?.updated_at);
  });

  it('moves the collection up when a media really joins it', async () => {
    const firstImageId = await seedImage('first');
    const secondImageId = await seedImage('second');

    const collection = await collectionRepository.create('Travel');
    await collectionRepository.addImage(collection.slug, firstImageId);

    const before = await collectionRepository.listSummaries();
    const beforeEntry = before.find((entry) => entry.slug === collection.slug);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await collectionRepository.addImage(collection.slug, secondImageId);

    const after = await collectionRepository.listSummaries();
    const afterEntry = after.find((entry) => entry.slug === collection.slug);

    expect(afterEntry?.last_added_at).not.toBe(beforeEntry?.last_added_at);
    expect(
      Date.parse(afterEntry?.last_added_at ?? '') >
        Date.parse(beforeEntry?.last_added_at ?? '')
    ).toBe(true);
    expect(afterEntry?.item_count).toBe(2);
  });

  it('lists the media of a collection in the order it joined, and can invert it', async () => {
    const firstImageId = await seedImage('first');
    const secondImageId = await seedImage('second');
    const thirdImageId = await seedImage('third');

    const collection = await collectionRepository.create('Travel');
    await collectionRepository.addImage(collection.slug, firstImageId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collectionRepository.addImage(collection.slug, secondImageId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collectionRepository.addImage(collection.slug, thirdImageId);

    const newestFirst = await collectionRepository.listImages(collection.slug, 0, 10);
    expect(newestFirst.map((image) => image.id)).toEqual([
      thirdImageId,
      secondImageId,
      firstImageId
    ]);

    const oldestFirst = await collectionRepository.listImages(collection.slug, 0, 10, 'asc');
    expect(oldestFirst.map((image) => image.id)).toEqual([
      firstImageId,
      secondImageId,
      thirdImageId
    ]);
  });
});
