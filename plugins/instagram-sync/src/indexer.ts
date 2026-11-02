/**
 * Hands newly downloaded media to Foldergram's scanner.
 *
 * The watcher only runs in development (`server/src/services/watcher-service.ts:26`),
 * so in production nothing would ever notice the new files. The plugin calls
 * `scanChangedPaths` itself.
 *
 * `scanChangedPaths` expects FILE paths relative to the gallery root, not
 * folder paths — it derives the affected folder via `path.posix.dirname`
 * (`server/src/services/scanner-service.ts:2047`).
 */

import path from "node:path";

import { scannerService } from "../../../server/dist/services/scanner-service.js";
import { isSupportedMediaFile } from "../../../server/dist/utils/image-utils.js";

/** Absolute paths → gallery-root-relative, posix-separated paths. */
export function toRelativePaths(galleryRoot: string, absolutePaths: string[]): string[] {
  return absolutePaths.map((absolutePath) =>
    path.relative(galleryRoot, absolutePath).replace(/\\/g, "/")
  );
}

/**
 * Index the files gallery-dl just downloaded.
 * Files with an unsupported extension (e.g. `.heic`) are dropped — the
 * scanner would ignore them anyway.
 */
export async function indexDownloaded(
  galleryRoot: string,
  absolutePaths: string[]
): Promise<string[]> {
  const relativePaths = toRelativePaths(galleryRoot, absolutePaths).filter((relativePath) =>
    isSupportedMediaFile(path.posix.basename(relativePath))
  );

  if (relativePaths.length === 0) {
    return [];
  }

  await scannerService.scanChangedPaths(relativePaths, "instagram-sync");
  return relativePaths;
}
