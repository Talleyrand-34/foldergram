/**
 * Runs gallery-dl and reports what it did.
 *
 * gallery-dl prints one line per file to stdout: a `# ` prefix means the file
 * was SKIPPED (already downloaded), no prefix means it was DOWNLOADED. The
 * unprefixed lines are exactly the files the scanner has to index.
 *
 * gallery-dl downloads straight into the gallery. Two independent dedup layers
 * make that safe:
 *   - the archive ledger skips media downloaded in a previous run;
 *   - `skip: true` (gallery-dl's default) skips files that already exist on
 *     disk, even when they are absent from the archive.
 * Verified on the server: a file present on disk but missing from the archive
 * is skipped and left untouched (its mtime does not change).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { InstagramSyncConfig } from "./config.js";
import { galleryDlPackageDir, isVersionAtLeast, readInstalledVersion } from "./galleryDl.js";

const execFileAsync = promisify(execFile);

export type FetchStatus = "ok" | "session-expired" | "gallery-dl-too-old" | "error";

export interface FetchResult {
  status: FetchStatus;
  /** Absolute paths of files gallery-dl actually downloaded. */
  downloadedPaths: string[];
  skippedCount: number;
  error: string | null;
  durationMs: number;
}

export interface FetchOptions {
  config: InstagramSyncConfig;
  galleryRoot: string;
  signal?: AbortSignal;
}

/**
 * Build the gallery-dl argv.
 *
 * Two details are easy to get wrong:
 *  - `-o extractor.instagram.directory=["{username}"]` is ONE argv element. If
 *    it is shell-interpolated the braces break and gallery-dl dies with
 *    `DirectoryFormatError: Single '{' encountered in format string`.
 *  - the flag is `--config-ignore`; there is no `--no-config`.
 */
export function buildArgs(opts: FetchOptions): string[] {
  const { config } = opts;
  return [
    "-m",
    "gallery_dl",
    "--config-ignore",
    "--download-archive",
    config.archiveFile,
    "--cookies",
    config.cookieFile,
    "-d",
    opts.galleryRoot,
    "-o",
    'extractor.instagram.directory=["{username}"]',
    "-A",
    String(config.abortAfterSkips),
    config.sourceUrl
  ];
}

/** Split gallery-dl's stdout into downloaded paths and a skip count. */
export function parseStdout(stdout: string): { downloaded: string[]; skipped: number } {
  const downloaded: string[] = [];
  let skipped = 0;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      skipped += 1;
      continue;
    }
    downloaded.push(line);
  }

  return { downloaded, skipped };
}

/** Map gallery-dl's stderr onto a status the plugin can act on. */
export function classifyError(stderr: string): FetchStatus {
  const text = stderr.toLowerCase();
  if (text.includes("topsearch") || text.includes("not found' for 'https://www.instagram.com/web/search")) {
    return "gallery-dl-too-old";
  }
  if (
    text.includes("login_required") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("challenge") ||
    text.includes("cookie")
  ) {
    return "session-expired";
  }
  return "error";
}

/** Run gallery-dl once and report what changed. */
export async function runGalleryDl(opts: FetchOptions): Promise<FetchResult> {
  const { config, galleryRoot } = opts;
  const startedAt = Date.now();

  const installed = await readInstalledVersion(config.galleryDlDir);
  if (!installed) {
    return {
      status: "error",
      downloadedPaths: [],
      skippedCount: 0,
      error: "gallery-dl is not installed — install it from the plugin's Update control",
      durationMs: Date.now() - startedAt
    };
  }

  if (!isVersionAtLeast(installed, config.minGalleryDlVersion)) {
    return {
      status: "gallery-dl-too-old",
      downloadedPaths: [],
      skippedCount: 0,
      error: `gallery-dl ${installed} is too old; ${config.minGalleryDlVersion} or newer is required`,
      durationMs: Date.now() - startedAt
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      ["-m", "gallery_dl", ...buildArgs(opts)],
      {
        env: { ...process.env, PYTHONPATH: galleryDlPackageDir(config.galleryDlDir) },
        cwd: config.workDir,
        // stdout carries one line per media file; the default 1 MB buffer
        // would kill the child with ENOBUFS on a large library.
        maxBuffer: 64 * 1024 * 1024,
        timeout: config.timeoutMinutes * 60_000,
        signal: opts.signal
      }
    );

    const { downloaded, skipped } = parseStdout(stdout);
    const failure = classifyError(stderr);
    if (failure !== "ok" && downloaded.length === 0) {
      return {
        status: failure,
        downloadedPaths: [],
        skippedCount: skipped,
        error: stderr.trim().slice(0, 500) || null,
        durationMs: Date.now() - startedAt
      };
    }

    return {
      status: "ok",
      downloadedPaths: downloaded,
      skippedCount: skipped,
      error: null,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const stdout = typeof err.stdout === "string" ? err.stdout : "";

    if (err.code === "ETIMEDOUT") {
      return {
        status: "error",
        downloadedPaths: [],
        skippedCount: 0,
        error: `gallery-dl timed out after ${config.timeoutMinutes} minutes`,
        durationMs: Date.now() - startedAt
      };
    }

    // A non-zero exit still leaves usable stdout: gallery-dl aborts the
    // extractor after the `-A` budget, which is a normal, successful outcome.
    const { downloaded, skipped } = parseStdout(stdout);
    if (downloaded.length > 0) {
      return {
        status: "ok",
        downloadedPaths: downloaded,
        skippedCount: skipped,
        error: null,
        durationMs: Date.now() - startedAt
      };
    }

    return {
      status: classifyError(stderr),
      downloadedPaths: [],
      skippedCount: skipped,
      error: stderr.trim().slice(0, 500) || err.message,
      durationMs: Date.now() - startedAt
    };
  }
}
