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

import { execFile } from "node:child_process";
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

/**
 * The media paths of one collection, relative to the gallery root.
 *
 * gallery-dl is run with `--no-download`, so nothing is fetched: the archive
 * is irrelevant here and the already-downloaded files are simply listed.
 */
export async function listCollectionMedia(
  config: InstagramSyncConfig,
  collection: InstagramCollection
): Promise<string[]> {
  const url = collectionUrl(config.sourceUrl, collection);
  const listingDir = path.join(config.workDir, "listing");

  const { stdout } = await execFileAsync(
    "python3",
    [
      "-m",
      "gallery_dl",
      "--no-download",
      "--config-ignore",
      "--cookies",
      config.cookieFile,
      "-d",
      listingDir,
      "-o",
      'extractor.instagram.directory=["{username}"]',
      url
    ],
    {
      env: { ...process.env, PYTHONPATH: galleryDlPackageDir(config.galleryDlDir) },
      cwd: config.workDir,
      maxBuffer: 32 * 1024 * 1024,
      timeout: config.timeoutMinutes * 60_000
    }
  );

  const prefix = listingDir.endsWith(path.sep) ? listingDir : `${listingDir}${path.sep}`;
  const paths: string[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("# ")) continue;
    if (!line.startsWith(prefix)) continue;
    paths.push(line.slice(prefix.length).replace(/\\/g, "/"));
  }

  return paths;
}
