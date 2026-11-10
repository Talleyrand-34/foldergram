import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { createDatabaseHarness, type DatabaseHarness } from './helpers/db-harness.js';
import {
  createScratchSchema,
  dropScratchSchema,
  probePostgres,
  SCHEMA_RESET_SQL,
  type ScratchSchema
} from './helpers/dialect.js';

/**
 * Dialect parity test.
 *
 * The repository layer has to behave identically on SQLite and PostgreSQL.
 * The assertions below run the *same* code path against both dialects and
 * compare the observable results, so a dialect specific regression (a missing
 * `ON CONFLICT`, a boolean that is not rewritten, a different ordering)
 * fails loudly instead of silently shipping.
 *
 * When no PostgreSQL server is reachable the test skips with an explicit
 * message that says how to start one.
 */

interface ParitySnapshot {
  folders: {
    countNormal: number;
    bySlug: { slug: string; name: string; folderPath: string; role: string } | undefined;
    summaries: Array<{ folderPath: string; imageCount: number; videoCount: number }>;
    missingSlug: unknown;
  };
  images: {
    byRelativePath: { relativePath: string; mediaType: string; isDeleted: number; isTrashed: number } | undefined;
    feedIds: number[];
    deletedIsDeleted: number | undefined;
    trashedIsTrashed: number | undefined;
  };
  collections: {
    defaultCollection: { slug: string; name: string; isDefault: number } | undefined;
    customCollection: { slug: string; name: string; isDefault: number } | undefined;
    summaries: Array<{ slug: string; name: string; itemCount: number }>;
    imagesAsc: number[];
    imagesDesc: number[];
    isImageSaved: boolean;
    countImages: number;
  };
  likes: {
    likedIds: number[];
    countLiked: number;
    likedImageIds: number[];
    removed: boolean;
    countAfterRemove: number;
  };
  appSettings: {
    value: string | null;
    missing: string | null;
    removed: string | null;
  };
  scanRuns: {
    runId: number;
    latestStatus: string | undefined;
    latestScannedFiles: number | undefined;
    latestCompletedStatus: string | undefined;
  };
  stats: {
    mediaCount: number;
    videoCount: number;
    folderCount: number;
  };
}

async function captureSnapshot(harness: DatabaseHarness): Promise<ParitySnapshot> {
  const {
    folderRepository,
    imageRepository,
    collectionRepository,
    likeRepository,
    appSettingsRepository,
    scanRunRepository,
    statsRepository
  } = harness.repositories;

  // --- folders -------------------------------------------------------------
  const trips = await folderRepository.upsert({
    slug: 'trips',
    name: 'Trips',
    folderPath: 'Trips'
  });
  const albums = await folderRepository.upsert({
    slug: 'albums',
    name: 'Albums',
    folderPath: 'Albums'
  });

  // --- images --------------------------------------------------------------
  const photo = await imageRepository.upsert({
    folderId: trips.id,
    filename: 'photo-1.jpg',
    extension: '.jpg',
    relativePath: 'Trips/photo-1.jpg',
    absolutePath: `${harness.tempDataRoot.galleryRoot}/Trips/photo-1.jpg`,
    fileSize: 1024,
    width: 1600,
    height: 1200,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    durationMs: null,
    fingerprint: 'Trips/photo-1.jpg:1024',
    mtimeMs: 1_777_000_000_000,
    firstSeenAt: '2026-05-01T10:00:00.000Z',
    sortTimestamp: 1_777_000_000_000,
    takenAt: 1_777_000_000_000,
    takenAtSource: 'exif',
    exifJson: '{}',
    thumbnailPath: 'thumbnails/Trips/photo-1.jpg.webp',
    previewPath: 'previews/Trips/photo-1.jpg.webp'
  });

  const video = await imageRepository.upsert({
    folderId: trips.id,
    filename: 'clip-1.mp4',
    extension: '.mp4',
    relativePath: 'Trips/clip-1.mp4',
    absolutePath: `${harness.tempDataRoot.galleryRoot}/Trips/clip-1.mp4`,
    fileSize: 2048,
    width: 1920,
    height: 1080,
    mediaType: 'video',
    mimeType: 'video/mp4',
    durationMs: 4000,
    fingerprint: 'Trips/clip-1.mp4:2048',
    mtimeMs: 1_777_000_001_000,
    firstSeenAt: '2026-05-01T10:00:00.000Z',
    sortTimestamp: 1_777_000_001_000,
    takenAt: 1_777_000_001_000,
    takenAtSource: 'exif',
    exifJson: '{}',
    thumbnailPath: 'thumbnails/Trips/clip-1.mp4.webp',
    previewPath: 'previews/Trips/clip-1.mp4.webp'
  });

  await folderRepository.setAvatar(trips.id, photo.id);
  await folderRepository.updateCounts(trips.id);
  await folderRepository.updateCounts(albums.id);

  const folderSummaries = await folderRepository.getSummaryPage(0, 10);

  // --- collections ---------------------------------------------------------
  const defaultCollection = await collectionRepository.ensureDefaultCollection();
  const customCollection = await collectionRepository.create('Holiday');
  await collectionRepository.addImage(customCollection.slug, photo.id);
  await collectionRepository.addImage(customCollection.slug, video.id);
  await collectionRepository.addImage(customCollection.slug, photo.id);

  const collectionSummaries = await collectionRepository.listSummaries();
  const collectionImagesAsc = await collectionRepository.listImages(customCollection.slug, 0, 10, 'asc');
  const collectionImagesDesc = await collectionRepository.listImages(customCollection.slug, 0, 10, 'desc');

  // --- likes ---------------------------------------------------------------
  await likeRepository.upsert(photo.id);
  const likedIds = await likeRepository.listLikedIds();
  const likedImages = await likeRepository.listLikedImages(0, 10);
  const likeRemoved = await likeRepository.remove(photo.id);

  // --- app settings --------------------------------------------------------
  await appSettingsRepository.set('parity.setting', 'parity-value');
  const settingValue = await appSettingsRepository.get('parity.setting');
  const missingSetting = await appSettingsRepository.get('parity.missing');
  await appSettingsRepository.remove('parity.setting');
  const removedSetting = await appSettingsRepository.get('parity.setting');

  // --- scan runs -----------------------------------------------------------
  const runId = await scanRunRepository.start();
  await scanRunRepository.finish(runId, {
    finished_at: '2026-05-02T10:00:00.000Z',
    status: 'completed',
    scanned_files: 2,
    new_files: 2,
    updated_files: 0,
    removed_files: 0,
    error_text: null
  });
  const latestRun = await scanRunRepository.latest();
  const latestCompletedRun = await scanRunRepository.latestCompleted();

  // --- stats ---------------------------------------------------------------
  await statsRepository.refresh();

  // --- soft delete / trash (boolean columns) -------------------------------
  await imageRepository.markDeleted(video.relative_path);
  await imageRepository.moveToTrash(photo.id);
  const deletedVideo = await imageRepository.getByRelativePath(video.relative_path);
  const trashedPhoto = await imageRepository.getById(photo.id);

  return {
    folders: {
      countNormal: await folderRepository.countNormal(),
      bySlug: await folderRepository.getBySlug('trips').then((folder) =>
        folder
          ? { slug: folder.slug, name: folder.name, folderPath: folder.folder_path, role: folder.role }
          : undefined
      ),
      summaries: folderSummaries.map((summary) => ({
        folderPath: summary.folder_path,
        imageCount: Number(summary.image_count),
        videoCount: Number(summary.video_count)
      })),
      missingSlug: await folderRepository.getBySlug('does-not-exist')
    },
    images: {
      byRelativePath: await imageRepository.getByRelativePath('Trips/clip-1.mp4').then((image) =>
        image
          ? {
              relativePath: image.relative_path,
              mediaType: image.media_type,
              isDeleted: Number(image.is_deleted),
              isTrashed: Number(image.is_trashed)
            }
          : undefined
      ),
      feedIds: (await imageRepository.listFeed(0, 10)).map((image) => image.id),
      deletedIsDeleted: deletedVideo ? Number(deletedVideo.is_deleted) : undefined,
      trashedIsTrashed: trashedPhoto ? Number(trashedPhoto.is_trashed) : undefined
    },
    collections: {
      defaultCollection: {
        slug: defaultCollection.slug,
        name: defaultCollection.name,
        isDefault: Number(defaultCollection.is_default)
      },
      customCollection: {
        slug: customCollection.slug,
        name: customCollection.name,
        isDefault: Number(customCollection.is_default)
      },
      summaries: collectionSummaries.map((summary) => ({
        slug: summary.slug,
        name: summary.name,
        itemCount: Number(summary.item_count)
      })),
      imagesAsc: collectionImagesAsc.map((image) => image.id),
      imagesDesc: collectionImagesDesc.map((image) => image.id),
      isImageSaved: await collectionRepository.isImageSaved(photo.id),
      countImages: await collectionRepository.countImages(customCollection.slug)
    },
    likes: {
      likedIds,
      countLiked: await likeRepository.countLiked(),
      likedImageIds: likedImages.map((image) => image.id),
      removed: likeRemoved,
      countAfterRemove: await likeRepository.countLiked()
    },
    appSettings: {
      value: settingValue,
      missing: missingSetting,
      removed: removedSetting
    },
    scanRuns: {
      runId,
      latestStatus: latestRun?.status,
      latestScannedFiles: latestRun?.scanned_files,
      latestCompletedStatus: latestCompletedRun?.status
    },
    stats: {
      mediaCount: await statsRepository.getMediaCount(),
      videoCount: await statsRepository.getVideoCount(),
      folderCount: await statsRepository.getFolderCount()
    }
  };
}

const probe = await probePostgres();

describe('dialect parity', () => {
  // One scratch schema for the whole file: applying the migration set is
  // expensive, and a second schema would have to be migrated again.
  let scratch: ScratchSchema | null = null;

  beforeAll(async () => {
    if (!probe.available || !probe.canCreateSchema) {
      return;
    }

    scratch = await createScratchSchema(probe.connectionUrl!);
  });

  afterAll(async () => {
    if (scratch) {
      await dropScratchSchema(probe.connectionUrl!, scratch.schema);
      scratch = null;
    }
  });

  it('runs the same repository operations identically on SQLite and PostgreSQL', async (ctx) => {
    if (!probe.available) {
      ctx.skip(`PostgreSQL is not available, skipping the dialect parity check.\n${probe.reason}`);
      return;
    }

    const sqliteHarness = await createDatabaseHarness({ dialect: 'sqlite' });
    const sqliteSnapshot = await captureSnapshot(sqliteHarness);
    await sqliteHarness.close();

    const postgresHarness = await createDatabaseHarness({
      dialect: 'postgres',
      databaseUrl: scratch?.connectionUrl ?? probe.connectionUrl!
    });
    const postgresSnapshot = await captureSnapshot(postgresHarness);
    await postgresHarness.close();

    expect(postgresSnapshot).toEqual(sqliteSnapshot);
  });

  it('reports the same folder visibility rules on both dialects', async (ctx) => {
    if (!probe.available) {
      ctx.skip(`PostgreSQL is not available, skipping the dialect parity check.\n${probe.reason}`);
      return;
    }

    // The two cases share the scratch schema, so the rows of the first one
    // have to go before the second one counts the visible folders.
    if (scratch) {
      const client = new pg.Client({ connectionString: scratch.connectionUrl, connectionTimeoutMillis: 5000 });

      try {
        await client.connect();
        await client.query(SCHEMA_RESET_SQL);
      } finally {
        await client.end().catch(() => undefined);
      }
    }

    const sqliteHarness = await createDatabaseHarness({ dialect: 'sqlite' });
    const postgresHarness = await createDatabaseHarness({
      dialect: 'postgres',
      databaseUrl: scratch?.connectionUrl ?? probe.connectionUrl!
    });

    const sqliteResult = await countVisibleFolders(sqliteHarness);
    const postgresResult = await countVisibleFolders(postgresHarness);

    await sqliteHarness.close();
    await postgresHarness.close();

    expect(postgresResult).toEqual(sqliteResult);
  });
});

async function countVisibleFolders(harness: DatabaseHarness): Promise<{ visible: number; total: number }> {
  const { folderRepository, imageRepository } = harness.repositories;

  const folder = await folderRepository.upsert({
    slug: 'visible',
    name: 'Visible',
    folderPath: 'Visible'
  });
  const empty = await folderRepository.upsert({
    slug: 'empty',
    name: 'Empty',
    folderPath: 'Empty'
  });

  await imageRepository.upsert({
    folderId: folder.id,
    filename: 'photo-1.jpg',
    extension: '.jpg',
    relativePath: 'Visible/photo-1.jpg',
    absolutePath: `${harness.tempDataRoot.galleryRoot}/Visible/photo-1.jpg`,
    fileSize: 512,
    width: 800,
    height: 600,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    durationMs: null,
    fingerprint: 'Visible/photo-1.jpg:512',
    mtimeMs: 1_777_000_000_000,
    firstSeenAt: '2026-05-01T10:00:00.000Z',
    sortTimestamp: 1_777_000_000_000,
    takenAt: 1_777_000_000_000,
    takenAtSource: 'exif',
    exifJson: '{}',
    thumbnailPath: 'thumbnails/Visible/photo-1.jpg.webp',
    previewPath: 'previews/Visible/photo-1.jpg.webp'
  });

  await folderRepository.updateCounts(folder.id);
  await folderRepository.updateCounts(empty.id);

  const summaries = await folderRepository.getSummaryPage(0, 10);

  return {
    visible: summaries.length,
    total: await folderRepository.countNormal()
  };
}
