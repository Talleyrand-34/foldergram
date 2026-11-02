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
 * Build the gallery-dl argv (everything after `python3 -m gallery_dl`).
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

/**
 * Decide the outcome of a gallery-dl run that exited 0.
 *
 * The steady state is "everything already downloaded": no downloads, no
 * stderr. That is a SUCCESS. A run that exited 0 but logged per-file
 * failures (a permission problem, say) is reported as an error so a broken
 * sync is never hidden behind a partial success.
 */
export function statusForSuccessfulRun(
  stdout: string,
  stderr: string
): { status: FetchStatus; downloaded: string[]; skipped: number; error: string | null } {
  const { downloaded, skipped } = parseStdout(stdout);
  const partial = summariseFailures(stderr);
  return {
    status: partial ? "error" : "ok",
    downloaded,
    skipped,
    error: partial
  };
}

/**
 * Map gallery-dl's stderr onto a status the plugin can act on.
 *
 * Only *specific* upstream faults are recognised here; anything else is a
 * generic error. This is for the FAILURE path — a run that exited non-zero.
 */
export function classifyError(stderr: string): FetchStatus {
  const text = stderr.toLowerCase();
  if (!text.trim()) {
    return "error";
  }
  if (text.includes("topsearch") || text.includes("not found' for 'https://www.instagram.com/web/search")) {
    return "gallery-dl-too-old";
  }
  if (
    text.includes("login_required") ||
    text.includes("invalid api key") ||
    text.includes("401 unauthorized") ||
    text.includes("403 forbidden") ||
    text.includes("challenge")
  ) {
    return "session-expired";
  }
  return "error";
}

/**
 * Summarise the per-file failures in gallery-dl's stderr.
 *
 * gallery-dl keeps going after a file fails, so a run can download most of
 * the batch and still fail on the rest. The distinct failure reasons are
 * counted so the operator sees what broke without a wall of log noise.
 *
 * The reason is normalised first — media ids and paths vary per file, so
 * without that every failure would count as its own reason.
 */
export function summariseFailures(stderr: string): string | null {
  if (!stderr.trim()) return null;

  const counts = new Map<string, number>();
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "Cannot import yt-dlp" is gallery-dl saying it will use its fallback
    // downloader, not a file failing.
    if (trimmed.includes("Cannot import yt-dlp")) continue;
    const isError = trimmed.includes("[error]");
    const isPermission = trimmed.includes("PermissionError");
    if (!isError && !isPermission) continue;

    const reason = trimmed
      .replace(/^.*\[(error|warning)\]\s*/, "")
      .replace(/'[^']*'/g, "<path>")
      .replace(/\b\d{6,}\b/g, "<id>")
      .slice(0, 160);
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  if (counts.size === 0) return null;

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (×${count})`)
    .join("; ");
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

    // gallery-dl exited 0, so the extractor completed. The steady state —
    // everything already downloaded, every file skipped — produces no
    // downloads and no stderr, and that is a SUCCESS, not a failure.
    const outcome = statusForSuccessfulRun(stdout, stderr);
    return {
      status: outcome.status,
      downloadedPaths: outcome.downloaded,
      skippedCount: outcome.skipped,
      error: outcome.error,
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
      const partial = summariseFailures(stderr);
      return {
        status: partial ? "error" : "ok",
        downloadedPaths: downloaded,
        skippedCount: skipped,
        error: partial,
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
