/**
 * Mirroring an Instagram saved collection into a Foldergram collection.
 *
 * The media of an Instagram collection are already in the library — the sync
 * downloaded them — so mirroring is a matter of putting the matching rows into
 * a Foldergram collection of the same name.
 *
 * The mapping is exact: gallery-dl lays media out as
 * `<author>/<media_id>.<ext>`, and Foldergram's `images.relative_path` has
 * exactly that shape, so no translation is needed.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { databaseManager } from "../../../server/dist/db/database.js";
import { collectionRepository } from "../../../server/dist/db/repositories.js";
import type { IDbDriver } from "../../../server/dist/db/driver/types.js";

import type { InstagramCollection } from "./instagramCollections.js";

export interface CollectionMirrorResult {
  name: string;
  instagramId: string;
  /** The Foldergram collection the media was put into. */
  collectionSlug: string | null;
  /** True when the Foldergram collection was created by this mirror. */
  collectionCreated: boolean;
  /** Media the collection holds according to Instagram. */
  mediaCount: number;
  /** How many of those are indexed in the library. */
  matchedCount: number;
  /** Media that is not in the library (not downloaded, or not indexed yet). */
  missingCount: number;
  /** A sample of the relative paths that could not be matched. */
  missingPaths: string[];
  /** How many images were added to the collection. */
  addedCount: number;
}

let cachedDriver: IDbDriver | null = null;

async function getDriver(): Promise<IDbDriver> {
  if (cachedDriver) return cachedDriver;
  cachedDriver = await databaseManager.getConnection();
  return cachedDriver;
}

/**
 * Find the library rows for the given relative paths.
 * The list is chunked so the parameter count stays within the driver's limits.
 */
export async function findImagesByRelativePaths(
  relativePaths: string[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (relativePaths.length === 0) return found;

  const driver = await getDriver();
  const CHUNK = 500;

  for (let start = 0; start < relativePaths.length; start += CHUNK) {
    const chunk = relativePaths.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const { rows } = await driver.query<{ relative_path: string; id: number }>(
      `SELECT id, relative_path FROM images
       WHERE is_deleted = ${driver.dialect === "postgres" ? "false" : "0"}
         AND relative_path IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      found.set(row.relative_path, row.id);
    }
  }

  return found;
}

/**
 * Index media that is on disk but not in the library yet.
 *
 * The startup scan is skipped when the library already has folders, so media
 * that arrived outside the plugin (a manual gallery-dl run, a copy into the
 * gallery) can sit on disk unindexed. Scanning the affected folders is cheap
 * and makes the mirror self-healing.
 */
async function indexMissingMedia(galleryRoot: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;

  const scanner = await import("../../../server/dist/services/scanner-service.js");
  const folders = new Set(
    relativePaths.map((relativePath) => relativePath.split("/").slice(0, -1).join("/"))
  );

  const existingFolders = new Set<string>();
  for (const folder of folders) {
    if (!folder) continue;
    const absolute = path.join(galleryRoot, folder);
    const present = await fs.access(absolute).then(
      () => true,
      () => false
    );
    if (present) existingFolders.add(folder);
  }

  // The scanner wants FILE paths — it filters on the file extension — and
  // then rescans the whole source folder of each one.
  const scannable = relativePaths.filter((relativePath) => {
    const folder = relativePath.split("/").slice(0, -1).join("/");
    return existingFolders.has(folder);
  });
  if (scannable.length === 0) return;

  await scanner.scannerService.scanChangedPaths(scannable, "instagram-sync");
}

/**
 * The mirror's job state.
 *
 * Mirroring one collection takes minutes — Instagram enumerating the
 * collection's media is the slow part — so the work runs in the background and
 * the client polls for the result. A synchronous request that takes three
 * minutes just looks like a failure.
 */
export interface MirrorJobState {
  running: boolean;
  /** The collection being mirrored, or null when idle. */
  name: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  results: CollectionMirrorResult[];
  error: string | null;
}

const idleMirrorJob: MirrorJobState = {
  running: false,
  name: null,
  startedAt: null,
  finishedAt: null,
  results: [],
  error: null
};

let mirrorJob: MirrorJobState = { ...idleMirrorJob };

export function getMirrorJob(): MirrorJobState {
  return mirrorJob;
}

export function isMirrorRunning(): boolean {
  return mirrorJob.running;
}

/**
 * Mirror collections in the background.
 * Resolves when the job is done; the state is polled via `getMirrorJob()`.
 */
export async function runMirrorJob(
  listCollections: () => Promise<InstagramCollection[]>,
  listMedia: (collection: InstagramCollection) => Promise<string[]>,
  galleryRoot: string,
  requestedName: string | null,
  onCollectionDone?: (result: CollectionMirrorResult) => void
): Promise<void> {
  mirrorJob = {
    ...idleMirrorJob,
    running: true,
    name: requestedName,
    startedAt: new Date().toISOString()
  };

  const results: CollectionMirrorResult[] = [];

  try {
    const collections = await listCollections();
    const selected = requestedName
      ? collections.filter(
          (collection) =>
            collection.name.toLocaleLowerCase() === requestedName.toLocaleLowerCase()
        )
      : collections.filter((collection) => !collection.isAuto);

    if (requestedName && selected.length === 0) {
      throw new Error(`no Instagram collection named "${requestedName}"`);
    }

    for (const collection of selected) {
      const media = await listMedia(collection);
      const result = await mirrorCollection(collection, media, galleryRoot);
      results.push(result);
      onCollectionDone?.(result);
      // Publish partial results as they arrive so the UI can show progress.
      mirrorJob = { ...mirrorJob, results: [...results] };
    }

    mirrorJob = {
      ...mirrorJob,
      running: false,
      results,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    mirrorJob = {
      ...mirrorJob,
      running: false,
      results,
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString()
    };
  }
}

/**
 * Merge a second lookup into the first.
 *
 * The mirror looks the media up twice: once for what is already indexed, and
 * again for what it just indexed. The second lookup must be MERGED — replacing
 * the map would drop everything that was already matched, and the mirror would
 * then add only the freshly indexed media.
 */
export function mergeImageLookups(
  base: Map<string, number>,
  extra: Map<string, number>
): Map<string, number> {
  const merged = new Map(base);
  for (const [relativePath, imageId] of extra) {
    merged.set(relativePath, imageId);
  }
  return merged;
}

/**
 * Mirror one Instagram collection into a Foldergram collection.
 *
 * The Foldergram collection is matched by name, case-insensitively — that is
 * how `collectionRepository.create` decides whether a name is taken. An
 * existing collection with the same name is reused and the media is added to it.
 */
export async function mirrorCollection(
  collection: InstagramCollection,
  relativePaths: string[],
  galleryRoot: string
): Promise<CollectionMirrorResult> {
  let images = await findImagesByRelativePaths(relativePaths);
  let missingPaths = relativePaths.filter((relativePath) => !images.has(relativePath));

  // Media that is on disk but not indexed yet: index it, then look again.
  if (missingPaths.length > 0) {
    await indexMissingMedia(galleryRoot, missingPaths);

    // MERGE the newly indexed rows into the map. Replacing it would drop
    // everything that was already matched, and the mirror would then add
    // only the freshly indexed media and under-report the rest.
    images = mergeImageLookups(images, await findImagesByRelativePaths(missingPaths));
  }

  missingPaths = relativePaths.filter((relativePath) => !images.has(relativePath));

  const summaries = await collectionRepository.listSummaries();
  const existing = summaries.find(
    (summary) =>
      summary.name.trim().toLocaleLowerCase() === collection.name.trim().toLocaleLowerCase()
  );

  let slug = existing?.slug ?? null;
  let created = false;

  if (!slug) {
    const createdCollection = await collectionRepository.create(collection.name);
    slug = createdCollection.slug;
    created = true;
  }

  let addedCount = 0;
  if (slug) {
    for (const relativePath of relativePaths) {
      const imageId = images.get(relativePath);
      if (imageId === undefined) continue;
      await collectionRepository.addImage(slug, imageId);
      addedCount += 1;
    }
  }

  return {
    name: collection.name,
    instagramId: collection.id,
    collectionSlug: slug,
    collectionCreated: created,
    mediaCount: relativePaths.length,
    matchedCount: relativePaths.length - missingPaths.length,
    missingCount: missingPaths.length,
    missingPaths: missingPaths.slice(0, 25),
    addedCount
  };
}
