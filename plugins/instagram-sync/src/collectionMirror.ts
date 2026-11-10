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
import type { CollectionSummaryRecord } from "../../../server/dist/types/models.js";

import { readCollectionStates, writeCollectionState } from "./collectionState.js";
import {
  describeSelection,
  selectCollections,
  type MirrorSelection
} from "./collectionSelection.js";
import type {
  CollectionListing,
  InstagramCollection
} from "./instagramCollections.js";

export { describeSelection, selectCollections, type MirrorSelection };

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
  /**
   * True when the listing stopped early.
   *
   * The collection was then only partly enumerated, so its membership is
   * incomplete — the media that were not reached were neither added nor
   * reported as missing.
   */
  stoppedEarly: boolean;
}

let cachedDriver: IDbDriver | null = null;

async function getDriver(): Promise<IDbDriver> {
  if (cachedDriver) return cachedDriver;
  cachedDriver = await databaseManager.getConnection();
  return cachedDriver;
}

/**
 * The identity of a media: the file name without its extension.
 *
 * The extension is not part of the identity: Instagram serves the same post
 * as a `.jpg` one day and as a `.heic` the next, and the library keeps the
 * file it downloaded first. Matching the whole path therefore misses the
 * media whose extension changed — they are in the library and never in the
 * collection.
 *
 * For the saved posts the name is Instagram's media id, which does not
 * change.
 */
export function mediaIdOf(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Escape the wildcards of a LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Find the library rows for the given media.
 *
 * The result is keyed by the **media id**, not by the path: the listing
 * prints the extension Instagram serves today, and the library may hold a
 * different one for the very same media.
 *
 * The list is chunked so the parameter count stays within the driver's limits.
 */
export async function findImagesByRelativePaths(
  relativePaths: string[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (relativePaths.length === 0) return found;

  const driver = await getDriver();
  const CHUNK = 400;

  for (let start = 0; start < relativePaths.length; start += CHUNK) {
    const chunk = relativePaths.slice(start, start + CHUNK);
    const ids = [...new Set(chunk.map(mediaIdOf))];
    if (ids.length === 0) continue;

    // The media is found by its id, whatever extension it has today. The
    // wildcards in a name are escaped, so they cannot widen the match.
    const patterns = ids.map((id) => `${escapeLike(id)}.%`);
    // Every pattern needs its own comparison: a bare "?" after an "OR" is
    // read as a boolean by PostgreSQL.
    const placeholders = patterns.map(() => "filename LIKE ?").join(" OR ");
    const { rows } = await driver.query<{ filename: string; id: number }>(
      `SELECT id, filename FROM images
       WHERE is_deleted = ${driver.dialect === "postgres" ? "false" : "0"}
         AND (${placeholders})`,
      patterns
    );
    for (const row of rows) {
      found.set(mediaIdOf(row.filename), row.id);
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
  /** What the job covers: "All collections" or a list of names. */
  selection: string | null;
  /** The collection being mirrored, or null when idle. */
  name: string | null;
  /** The collection currently being enumerated. */
  currentCollection: string | null;
  /** Media found so far in the current collection. */
  mediaFound: number | null;
  /** Collections finished so far. */
  completedCount: number;
  /** Collections to mirror in this job, once they are known. */
  totalCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  results: CollectionMirrorResult[];
  error: string | null;
  /** Recent activity, oldest first. */
  log: string[];
}

const idleMirrorJob: MirrorJobState = {
  running: false,
  selection: null,
  name: null,
  currentCollection: null,
  mediaFound: null,
  completedCount: 0,
  totalCount: null,
  startedAt: null,
  finishedAt: null,
  results: [],
  error: null,
  log: []
};

const MAX_LOG_LINES = 40;

let mirrorJob: MirrorJobState = { ...idleMirrorJob };

/**
 * Which collection gets the deep pass next.
 *
 * The pass moves on every job, so every collection is enumerated whole over
 * time — that is what catches the media the early-exit walks past.
 */
let deepPassCursor = 0;

/**
 * The results of the last job.
 *
 * They are kept so that the deep pass can go where the work is — a
 * collection that had media missing last time is the one worth enumerating
 * whole. The job's own state is cleared when a new job starts, so the
 * results are remembered here.
 */
let lastResults: CollectionMirrorResult[] = [];

export function getMirrorJob(): MirrorJobState {
  return mirrorJob;
}

export function isMirrorRunning(): boolean {
  return mirrorJob.running;
}

/** Append a line to the activity log, keeping the tail bounded. */
function logLine(message: string): void {
  mirrorJob = {
    ...mirrorJob,
    log: [...mirrorJob.log, message].slice(-MAX_LOG_LINES)
  };
}

/**
 * Mirror collections in the background.
 * Resolves when the job is done; the state is polled via `getMirrorJob()`.
 */
export async function runMirrorJob(
  listCollections: () => Promise<InstagramCollection[]>,
  listMedia: (
    collection: InstagramCollection,
    onProgress?: (found: number) => void,
    /**
     * The paths the Foldergram collection already holds. The enumeration
     * stops when it has seen enough of them in a row — and every media that
     * had to be reached.
     */
    knownPaths?: Set<string>,
    /**
     * The media that are in the library but not yet in the collection. The
     * enumeration walks until it has seen them.
     */
    pendingPaths?: Set<string>,
    /**
     * The deep pass: enumerate the whole collection and fetch what the
     * library lacks.
     */
    options?: { deep?: boolean; galleryRoot?: string }
  ) => Promise<CollectionListing>,
  galleryRoot: string,
  selection: MirrorSelection | null,
  /**
   * The media the general sync downloaded and the collections have not seen
   * yet.
   *
   * They are in the library but not in the collections, and the enumeration
   * has to reach them — a collection is ordered by the date of the post, so
   * one that was posted long ago and saved yesterday sits deep in the list.
   */
  pendingPaths: Set<string> = new Set<string>(),
  onCollectionDone?: (result: CollectionMirrorResult) => void
): Promise<void> {
  const summary = describeSelection(selection);
  mirrorJob = {
    ...idleMirrorJob,
    running: true,
    selection: summary,
    name: selection?.names?.[0] ?? null,
    startedAt: new Date().toISOString()
  };

  const results: CollectionMirrorResult[] = [];

  try {
    const collections = await listCollections();
    const selected = selectCollections(collections, selection);

    if (selection && selected.length === 0) {
      throw new Error(`no Instagram collection matched ${summary}`);
    }

    mirrorJob = { ...mirrorJob, totalCount: selected.length };
    logLine(
      selected.length === 1
        ? `Mirroring ${selected[0].name}`
        : `Mirroring ${selected.length} collections`
    );

    // The Foldergram collections are read ONCE for the whole job. Reading
    // them per collection made the job quadratic: every read counts the
    // media of every collection.
    const summaries = await collectionRepository.listSummaries();
    const summaryFor = (name: string) =>
      summaries.find(
        (summary) =>
          summary.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
      );

    // One collection per job gets the **deep pass**: it is enumerated whole
    // and fetched, so the media the library lacks — a post the general sync
    // never managed to download, because the early-exit walked past it — are
    // brought in. The pass moves on every job, so every collection is checked
    // over time.
    const deepIndex = deepPassCursor % Math.max(1, selected.length);
    deepPassCursor += 1;

    // A collection that had media missing last time comes first: the deep
    // pass is what brings them in, so it goes where the work is.
    const withMissing = selected.findIndex((collection) =>
      mirrorJob.results.some(
        (result) =>
          result.name.trim().toLocaleLowerCase() ===
            collection.name.trim().toLocaleLowerCase() && result.missingCount > 0
      )
    );
    const deepCollectionIndex = withMissing >= 0 ? withMissing : deepIndex;

    for (const [collectionIndex, collection] of selected.entries()) {
      mirrorJob = {
        ...mirrorJob,
        currentCollection: collection.name,
        mediaFound: 0,
        completedCount: results.length
      };

      // What the Foldergram collection already holds. The enumeration stops
      // when it has seen enough of these in a row — the collection is
      // caught up. A collection that was never mirrored has none of them,
      // so it is enumerated whole ✓ and arrives complete.
      const known = summaryFor(collection.name);
      const knownPaths = known
        ? new Set(await collectionRepository.listCollectionItemPaths(known.slug))
        : new Set<string>();

      const isDeepPass = collectionIndex === deepCollectionIndex;
      const listing = await listMedia(collection, (found) => {
        mirrorJob = { ...mirrorJob, mediaFound: found };
      }, knownPaths, pendingPaths, {
        deep: isDeepPass,
        galleryRoot
      });
      const media = listing.paths;
      logLine(
        `${collection.name}: ${media.length} media listed` +
          (listing.complete ? "" : " (caught up — the enumeration stopped early)")
      );

      let result: CollectionMirrorResult;
      try {
        result = await mirrorCollection(collection, media, galleryRoot, {
          known: listing.known,
          stoppedEarly: !listing.complete
        }, known);
      } catch (error) {
        await writeCollectionState(collection.id, {
          name: collection.name,
          mediaCount: media.length,
          syncedCount: 0,
          missingCount: media.length,
          addedCount: 0,
          status: "failed",
          lastSyncedAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }

      results.push(result);
      onCollectionDone?.(result);

      // Keep the per-collection status so the UI can show, for every
      // collection, how many posts it holds and how many are synced.
      await writeCollectionState(collection.id, {
        name: collection.name,
        mediaCount: result.mediaCount,
        syncedCount: result.matchedCount,
        missingCount: result.missingCount,
        addedCount: result.addedCount,
        status: result.missingCount > 0 || result.stoppedEarly ? "partial" : "ok",
        lastSyncedAt: new Date().toISOString(),
        lastError: null
      });

      mirrorJob = {
        ...mirrorJob,
        completedCount: results.length,
        currentCollection: null,
        mediaFound: null,
        results: [...results]
      };
      logLine(
        `${collection.name}: ${result.addedCount} added, ${result.missingCount} not in the library`
      );
    }

    // The results are remembered so that the next job's deep pass can go
    // where the media are missing.
    lastResults = results;

    mirrorJob = {
      ...mirrorJob,
      running: false,
      results,
      finishedAt: new Date().toISOString()
    };
    logLine(`Done — ${results.length} collections mirrored`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mirrorJob = {
      ...mirrorJob,
      running: false,
      results,
      error: message,
      finishedAt: new Date().toISOString()
    };
    logLine(`Failed: ${message}`);
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
  galleryRoot: string,
  listing: { known: number; stoppedEarly: boolean } = {
    known: 0,
    stoppedEarly: false
  },
  known: CollectionSummaryRecord | undefined = undefined
): Promise<CollectionMirrorResult> {
  let images = await findImagesByRelativePaths(relativePaths);
  let missingPaths = relativePaths.filter(
    (relativePath) => !images.has(mediaIdOf(relativePath))
  );

  // Media that is on disk but not indexed yet: index it, then look again.
  if (missingPaths.length > 0) {
    await indexMissingMedia(galleryRoot, missingPaths);

    // MERGE the newly indexed rows into the map. Replacing it would drop
    // everything that was already matched, and the mirror would then add
    // only the freshly indexed media and under-report the rest.
    images = mergeImageLookups(images, await findImagesByRelativePaths(missingPaths));
  }

  missingPaths = relativePaths.filter(
    (relativePath) => !images.has(mediaIdOf(relativePath))
  );

  const existing = known;

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
      const imageId = images.get(mediaIdOf(relativePath));
      if (imageId === undefined) continue;
      await collectionRepository.addImage(slug, imageId);
      addedCount += 1;
    }
  }

  // The listing hands over every media of the collection it reached — the
  // ones that were downloaded as well as the ones that were skipped because
  // they are already in the library. Both are members.
  const seen = relativePaths.length;

  // When the listing stopped early, `seen` is a **lower bound**: the
  // collection may hold much more. The size a previous run knew is the
  // better answer, and a lower bound must never shrink it — the mirror only
  // ever adds, so the collection only grows.
  const previous = (await readCollectionStates())[collection.id];
  const mediaCount = listing.stoppedEarly
    ? Math.max(previous?.mediaCount ?? 0, seen)
    : seen;

  return {
    name: collection.name,
    instagramId: collection.id,
    collectionSlug: slug,
    collectionCreated: created,
    mediaCount,
    // Everything the collection holds is in the library: the members that
    // were missing are the ones the listing reached but the library does
    // not have.
    matchedCount: Math.max(0, mediaCount - missingPaths.length),
    missingCount: missingPaths.length,
    missingPaths: missingPaths.slice(0, 25),
    addedCount,
    stoppedEarly: listing.stoppedEarly
  };
}
