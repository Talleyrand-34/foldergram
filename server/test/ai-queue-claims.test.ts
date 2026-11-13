import { describe, expect, it } from 'vitest';

import { createDatabaseHarness, type DatabaseHarness } from './helpers/db-harness.js';

/**
 * The queue of the AI analysis has two properties that are easy to lose:
 *
 *  1. a video is only worked on once — two workers that pick the same video
 *     pay for the same analysis twice and wait for each other's lock,
 *  2. the scanner asks the database for many files at once, instead of once
 *     per file.
 *
 * Both are checked here against a real database.
 */

type StorageModule = typeof import('../../plugins/ai-analysis/src/storage.js');
type RepositoriesModule = typeof import('../src/db/repositories.js');
type DriverModule = typeof import('../src/db/driver/types.js');

type Driver = DriverModule['IDbDriver'];

/**
 * The harness follows the environment: PostgreSQL when a connection string is
 * there, SQLite otherwise.
 */
async function createHarness(): Promise<DatabaseHarness> {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    return createDatabaseHarness();
  }

  return createDatabaseHarness({ dialect: 'postgres', databaseUrl });
}

async function insertFolder(driver: Driver, slug: string): Promise<number> {
  const existing = await driver.queryOne<{ id: number }>(`SELECT id FROM folders WHERE slug = ?`, [slug]);
  if (existing) return existing.id;

  await driver.execute(
    `INSERT INTO folders (slug, name, folder_path, role, updated_at)
     VALUES (?, ?, ?, 'normal', CURRENT_TIMESTAMP)`,
    [slug, slug, `/gallery/${slug}`]
  );

  const row = await driver.queryOne<{ id: number }>(`SELECT id FROM folders WHERE slug = ?`, [slug]);
  return row?.id ?? 0;
}

async function insertVideo(
  driver: Driver,
  relativePath: string,
  options: { folderId?: number; mediaType?: string; aiStatus?: string | null } = {}
): Promise<number> {
  const folderId = options.folderId ?? (await insertFolder(driver, relativePath.split('/')[0] ?? 'a'));
  const mediaType = options.mediaType ?? 'video';
  const aiStatus = options.aiStatus === undefined ? 'pending' : options.aiStatus;

  await driver.execute(
    `INSERT INTO images (
       folder_id, filename, extension, relative_path, absolute_path, file_size, width, height,
       media_type, mime_type, checksum_or_fingerprint, mtime_ms, first_seen_at, sort_timestamp,
       thumbnail_path, preview_path, ai_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      folderId,
      relativePath.split('/').pop() ?? relativePath,
      'mp4',
      relativePath,
      `/gallery/${relativePath}`,
      1024,
      1920,
      1080,
      mediaType,
      'video/mp4',
      `fingerprint-${relativePath}`,
      1_700_000_000_000,
      '2026-01-01T00:00:00.000Z',
      1_700_000_000_000,
      `thumbnails/${relativePath}.jpg`,
      `previews/${relativePath}.jpg`,
      aiStatus
    ]
  );

  const row = await driver.queryOne<{ id: number }>(`SELECT id FROM images WHERE relative_path = ?`, [
    relativePath
  ]);
  return row?.id ?? 0;
}

describe('the queue claims a video once', () => {
  it('gives two workers two different videos', async () => {
    const harness = await createHarness();
    try {
      const { databaseManager } = await import('../src/db/database.js');
      const driver = await databaseManager.getConnection();
      const storage: StorageModule = await import('../../plugins/ai-analysis/src/storage.js');

      await insertVideo(driver, 'a/first.mp4');
      await insertVideo(driver, 'a/second.mp4');
      await insertVideo(driver, 'a/third.mp4');

      const [first, second] = await Promise.all([
        storage.claimNextPending(),
        storage.claimNextPending()
      ]);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The same video twice would mean the same analysis is paid for twice.
      expect(first?.imageId).not.toBe(second?.imageId);

      // And the claim marks the video, so the next round does not pick it.
      const rows = await driver.query<{ ai_status: string }>(`SELECT ai_status FROM images ORDER BY id`);
      const running = rows.rows.filter((row) => row.ai_status === 'running');
      expect(running).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('has nothing to claim when every video is done', async () => {
    const harness = await createHarness();
    try {
      const { databaseManager } = await import('../src/db/database.js');
      const driver = await databaseManager.getConnection();
      const storage: StorageModule = await import('../../plugins/ai-analysis/src/storage.js');

      await insertVideo(driver, 'b/done.mp4', { aiStatus: 'ok' });

      expect(await storage.claimNextPending()).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('leaves a video that is not a video alone', async () => {
    const harness = await createHarness();
    try {
      const { databaseManager } = await import('../src/db/database.js');
      const driver = await databaseManager.getConnection();
      const storage: StorageModule = await import('../../plugins/ai-analysis/src/storage.js');

      await insertVideo(driver, 'c/photo.jpg', { mediaType: 'image' });

      expect(await storage.claimNextPending()).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

describe('the scanner looks the files up in one go', () => {
  it('answers for many paths at once', async () => {
    const harness = await createHarness();
    try {
      const { databaseManager } = await import('../src/db/database.js');
      const driver = await databaseManager.getConnection();
      const repositories: RepositoriesModule = await import('../src/db/repositories.js');

      await insertVideo(driver, 'd/one.jpg', { mediaType: 'image' });
      await insertVideo(driver, 'd/two.jpg', { mediaType: 'image' });

      const state = await repositories.imageRepository.getScanStateByRelativePaths([
        'd/one.jpg',
        'd/two.jpg',
        'd/three.jpg'
      ]);

      expect(state.size).toBe(2);
      expect(state.get('d/one.jpg')?.folderId).toBe(1);
      expect(state.get('d/one.jpg')?.isDeleted).toBe(false);
      expect(state.has('d/three.jpg')).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('answers with nothing when there is nothing to ask for', async () => {
    const harness = await createHarness();
    try {
      const repositories: RepositoriesModule = await import('../src/db/repositories.js');

      const state = await repositories.imageRepository.getScanStateByRelativePaths([]);

      expect(state.size).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
