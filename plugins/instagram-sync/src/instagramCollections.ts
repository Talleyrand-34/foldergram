/**
 * Reading the user's Instagram saved collections.
 *
 * Two independent pieces:
 *
 * 1. **The collection list** — Instagram exposes it through the GraphQL query
 *    `PolarisProfileSavedTabContentQuery`. gallery-dl has no extractor for it
 *    (it has one for saved posts and one for a collection's contents), so the
 *    query is driven by a small Python helper that reuses gallery-dl's own
 *    machinery: cookie handling, token extraction and request signing.
 *
 * 2. **A collection's media** — gallery-dl already has an extractor for this:
 *    `USER/saved/<name>/<id>/`. Run with `--no-download` it enumerates the
 *    collection's media and prints the paths it *would* download, without
 *    fetching a single byte. The archive is not consulted at all.
 *
 * The printed paths are `<author>/<media_id>.<ext>`, which is exactly
 * Foldergram's `images.relative_path` — so a collection's media maps onto
 * library rows without any translation.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { InstagramSyncConfig } from "./config.js";
import { galleryDlPackageDir } from "./galleryDl.js";

const execFileAsync = promisify(execFile);

export interface InstagramCollection {
  id: string;
  name: string;
  type: string;
  /** Instagram's catch-all "All posts" pseudo-collection. */
  isAuto: boolean;
}

/** The account whose saved posts are synced. */
export function instagramUsername(sourceUrl: string): string | null {
  const match = /^https?:\/\/(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(sourceUrl);
  return match ? match[1] : null;
}

/** The URL gallery-dl needs for one collection's contents. */
export function collectionUrl(sourceUrl: string, collection: InstagramCollection): string {
  const match = /^https?:\/\/(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(sourceUrl);
  const user = match ? match[1] : "";
  return `https://www.instagram.com/${user}/saved/${collection.name}/${collection.id}/`;
}

/**
 * The Python helper that lists the collections.
 *
 * It lives next to the compiled plugin — the build copies `python/` into
 * `dist/python/` — so the deploy carries it along with the JavaScript.
 */
export function helperPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "python", "list_collections.py");
}

/** Parse the helper's output line. */
export function parseCollectionsOutput(stdout: string): InstagramCollection[] {
  const match = /COLLECTIONS_JSON=(.*)/s.exec(stdout);
  if (!match) {
    throw new Error("collection helper produced no output");
  }

  const parsed = JSON.parse(match[1]) as Array<{
    id?: string;
    name?: string;
    type?: string;
    isAuto?: boolean;
  }>;

  return parsed
    .filter((entry) => entry.id && entry.name)
    .map((entry) => ({
      id: String(entry.id),
      name: String(entry.name),
      type: String(entry.type ?? ""),
      isAuto: entry.isAuto === true
    }));
}

/** List the user's Instagram saved collections. */
export async function listInstagramCollections(
  config: InstagramSyncConfig
): Promise<InstagramCollection[]> {
  const username = instagramUsername(config.sourceUrl);
  if (!username) {
    throw new Error(`cannot derive an Instagram account from "${config.sourceUrl}"`);
  }

  const helper = helperPath();
  await fs.access(helper).catch(() => {
    throw new Error(`collection helper is missing at ${helper}`);
  });

  const { stdout } = await execFileAsync(
    "python3",
    [helper, config.cookieFile, username],
    {
      env: { ...process.env, PYTHONPATH: galleryDlPackageDir(config.galleryDlDir) },
      cwd: config.workDir,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60_000
    }
  );

  return parseCollectionsOutput(stdout);
}

/** How many already-filed media in a row mean the collection is caught up. */
export const DEFAULT_STOP_AFTER = 10;

/** What the enumeration knows about the collection so far. */
export interface KnownProgress {
  /** How many of the media seen were already filed. */
  known: number;
  /** How many of them came in a row. */
  run: number;
  /** How many of the media that had to be reached have been seen. */
  reached: number;
  /** True when the collection is caught up and the enumeration may stop. */
  caughtUp: boolean;
}

/**
 * Follow the enumeration against the media the collection already holds.
 *
 * The criterion is "this many already-filed media **in a row**". A media
 * that is not filed resets the run — it may be new, and a new post can sit
 * deep in the collection, because a collection is ordered by the date of the
 * post and not by the day it was saved.
 */
export function trackKnownMedia(
  state: KnownProgress,
  relativePath: string,
  knownPaths: Set<string>,
  stopAfter: number = DEFAULT_STOP_AFTER,
  pendingPaths: Set<string> = new Set<string>(),
  pendingTotal: number = 0
): KnownProgress {
  const reached = state.reached + (pendingPaths.has(relativePath) ? 1 : 0);

  if (!knownPaths.has(relativePath)) {
    return { known: state.known, run: 0, reached, caughtUp: false };
  }

  const known = state.known + 1;
  const run = state.run + 1;

  // The enumeration may stop when the collection is caught up **and** every
  // media that had to be reached has been seen.
  const caughtUp =
    stopAfter > 0 && run >= stopAfter && reached >= pendingTotal;

  return { known, run, reached, caughtUp };
}

/**
 * Read one line of a collection listing.
 *
 * A "# " prefix means gallery-dl **skipped** the media — it is already in
 * the library. It is still a member of the collection, so its path is
 * returned: the mirror files the media of a collection, and the media that
 * are already downloaded are exactly the ones it has to place.
 *
 * The path is the one gallery-dl printed; the caller takes the part that
 * follows the listing directory.
 */
export function parseListingLine(
  line: string
): { path: string; skipped: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("# ")) {
    return { path: trimmed.slice(2).trim(), skipped: true };
  }
  return { path: trimmed, skipped: false };
}

/**
 * What one collection listing produced.
 *
 * `complete` is the important one: the enumeration stops as soon as the
 * collection is caught up, so a listing that stopped half way is not the
 * same as one that reached the end. The mirror needs to know which it was.
 */
export interface CollectionListing {
  /** The media of the collection, relative to the gallery root. */
  paths: string[];
  /** How many of them the collection already held. */
  known: number;
  /**
   * True when the collection was enumerated to the end.
   *
   * False when the enumeration was stopped because the collection was
   * caught up: the media behind that point were never looked at.
   */
  complete: boolean;
}

/**
 * How one listing is run.
 */
export interface ListOptions {
  /**
   * The paths the Foldergram collection already holds.
   *
   * The enumeration stops when it has seen this many of them **in a row**:
   * the collection is caught up, and the rest of it would be media it has
   * already filed.
   */
  knownPaths?: Set<string>;
  /**
   * The paths that must still be reached before the enumeration may stop.
   *
   * These are the media the general sync downloaded since the last mirror.
   * They are in the library but not yet in the collection, and a collection
   * is ordered by the date of the **post** — so one that was posted long ago
   * and saved yesterday sits deep in the list, where the early-exit would
   * never reach it. The enumeration walks until it has seen them all.
   */
  pendingPaths?: Set<string>;
  /**
   * How many already-filed media in a row end the enumeration.
   *
   * `0` enumerates the whole collection.
   */
  stopAfter?: number;
  /**
   * Fetch what is not in the library yet.
   *
   * The run downloads the collection: the download archive skips what is
   * already there, so only the media the library lacks are fetched. This is
   * how a post that the general sync never managed to download — because the
   * early-exit walked past it — ends up in the library at all.
   */
  download?: boolean;
  /** Where the fetched media land. Required when `download` is set. */
  galleryRoot?: string;
}

/**
 * The media paths of one collection, relative to the gallery root.
 *
 * gallery-dl is run with `--no-download`, so nothing is fetched.
 *
 * The **download archive is still consulted**: gallery-dl checks it before
 * the download step, so the media that are already in the library are skipped
 * rather than listed. That is what lets the `-A` budget fire — and the budget
 * is what makes the collection poll fast. Without it, every poll enumerates
 * every media of every collection again, which is minutes per collection.
 *
 * The listing is streamed, because enumerating a collection is the slow part
 * (minutes) and the caller wants to report progress while it happens.
 */
export async function listCollectionMedia(
  config: InstagramSyncConfig,
  collection: InstagramCollection,
  onProgress?: (found: number) => void,
  options: ListOptions = {}
): Promise<CollectionListing> {
  const url = collectionUrl(config.sourceUrl, collection);
  const listingDir = path.join(config.workDir, "listing");
  // A fetch lands in the gallery, so its paths are relative to the gallery
  // root; a listing is relative to the listing directory.
  const outputRoot = options.download ? options.galleryRoot ?? listingDir : listingDir;
  const prefix = outputRoot.endsWith(path.sep) ? outputRoot : `${outputRoot}${path.sep}`;
  const knownPaths = options.knownPaths ?? new Set<string>();
  const pendingPaths = options.pendingPaths ?? new Set<string>();
  const pendingTotal = pendingPaths.size;
  const stopAfter = options.stopAfter ?? DEFAULT_STOP_AFTER;

  const args = [
    "-m",
    "gallery_dl"
  ];

  if (!options.download) {
    args.push("--no-download");
  }

  args.push(
    "--config-ignore",
    "--cookies",
    config.cookieFile,
    "-d",
    outputRoot,
    "-o",
    'extractor.instagram.directory=["{username}"]'
  );

  // A fetch runs **without** the ledger on purpose.
  //
  // The ledger is a claim, not a fact: it says a media was downloaded once.
  // When the file is gone from the gallery — deleted, or never indexed — the
  // ledger still claims it, so gallery-dl skips it and the media is never
  // fetched again. The on-disk check is the truth: what is not on disk is
  // fetched, and what is on disk is left alone.
  //
  // The deep pass is the one run that does this, so it costs a walk of the
  // collection and nothing more in bandwidth.

  args.push(url);

  const listing = await new Promise<CollectionListing>((resolve, reject) => {
    const child = spawn(
      "python3",
      args,
      {
        env: { ...process.env, PYTHONPATH: galleryDlPackageDir(config.galleryDlDir) },
        cwd: config.workDir,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let pending = "";
    let stderr = "";
    let found = 0;
    let progress: KnownProgress = { known: 0, run: 0, reached: 0, caughtUp: false };
    let stopped = false;
    const collected: string[] = [];

    const takeLine = (rawLine: string): void => {
      const line = parseListingLine(rawLine);
      if (!line) return;

      found += 1;
      if (line.path.startsWith(prefix)) {
        const relative = line.path.slice(prefix.length).replace(/\\/g, "/");
        collected.push(relative);

        progress = trackKnownMedia(
          progress,
          relative,
          knownPaths,
          stopAfter,
          pendingPaths,
          pendingTotal
        );
      }

      onProgress?.(found);

      if (progress.caughtUp) {
        stopped = true;
        // The collection is caught up: the rest of it would be media it
        // already holds. The enumeration stops here.
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) takeLine(line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      // A listing that was stopped on purpose ends with a signal, not a
      // failure.
      if (code !== 0 && !stopped) {
        reject(new Error(stderr.trim().slice(0, 500) || `gallery-dl exited with ${code}`));
        return;
      }

      // The last line may not have been terminated.
      takeLine(pending);
      resolve({
        paths: collected,
        known: progress.known,
        complete: !stopped
      });
    });
  });

  return listing;
}
