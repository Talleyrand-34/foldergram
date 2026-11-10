/**
 * Runs gallery-dl and reports what it did.
 *
 * gallery-dl prints one line per file to stdout: a `# ` prefix means the file
 * was SKIPPED (already downloaded), no prefix means it was DOWNLOADED. The
 * unprefixed lines are exactly the files the scanner has to index.
 *
 * gallery-dl downloads straight into the gallery. Two independent dedup layers
 * make that safe:
 *   - the archive ledger skips media the plugin has downloaded before;
 *   - `skip: true` (gallery-dl's default) skips files that already exist on
 *     disk, even when the archive misses them.
 * Verified on the server: a file present on disk but missing from the archive
 * is skipped and left untouched (its mtime does not change).
 *
 * The archive is the FAST path, not the only path. It is a SQLite file on a
 * volume shared with another host, so it can be locked by somebody else. When
 * that happens the run is retried without it: the on-disk check still stops
 * every re-download, and the sync degrades to "the ledger is unavailable"
 * instead of failing outright.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { InstagramSyncConfig } from "./config.js";
import { galleryDlPackageDir, isVersionAtLeast, readInstalledVersion } from "./galleryDl.js";

const execFileAsync = promisify(execFile);

export type FetchStatus =
  | "ok"
  | "session-expired"
  | "gallery-dl-too-old"
  /**
   * The download archive could not be used — locked, or unreadable — but the
   * sync itself worked. The files are still deduped by the on-disk check.
   */
  | "archive-unavailable"
  | "error";

export interface FetchResult {
  status: FetchStatus;
  /** Absolute paths of files gallery-dl actually downloaded. */
  downloadedPaths: string[];
  skippedCount: number;
  /**
   * True when the extractor stopped early because it had skipped enough
   * files in a row.
   *
   * gallery-dl swallows the abort and exits 0, so a run that gave up looks
   * exactly like a run that finished. This is the difference.
   */
  stoppedEarly: boolean;
  error: string | null;
  durationMs: number;
}

export interface FetchOptions {
  config: InstagramSyncConfig;
  galleryRoot: string;
  signal?: AbortSignal;
  /** Run WITHOUT the download-archive ledger. */
  useArchive?: boolean;
  /**
   * Override the `-A` budget.
   *
   * `0` means "no budget": the extractor walks the whole source instead of
   * deciding that it has caught up. That is the intensive scan.
   */
  abortAfterSkips?: number;
  /** Test seam: replaces the gallery-dl spawn. */
  spawn?: SpawnGalleryDl;
}

/** What one gallery-dl invocation produced. */
export interface RawRun {
  stdout: string;
  stderr: string;
  /** null when gallery-dl exited 0. */
  failure: { code?: string | number | null; message: string; killed?: boolean; signal?: string | null } | null;
}

export type SpawnGalleryDl = (opts: FetchOptions) => Promise<RawRun>;

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
  const args = ["--config-ignore"];

  // The ledger is optional: a run without it still skips every file that is
  // already on disk.
  if (opts.useArchive !== false) {
    args.push("--download-archive", config.archiveFile);
  }

  args.push(
    "--cookies",
    config.cookieFile,
    "-d",
    opts.galleryRoot,
    "-o",
    'extractor.instagram.directory=["{username}"]'
  );

  // The budget is gallery-dl's early-exit: it stops the extractor after this
  // many files in a row were skipped. A budget of 0 means "no early-exit" —
  // the extractor walks the whole source, which is the intensive scan.
  const budget = opts.abortAfterSkips ?? config.abortAfterSkips;
  if (budget > 0) {
    args.push("-A", String(budget));
  }

  args.push(config.sourceUrl);
  return args;
}

/**
 * Split gallery-dl's stdout into downloaded paths and a skip count.
 *
 * The longest run of skips in a row is reported too: gallery-dl's `-A`
 * budget counts *consecutive* skips and resets after every download, so the
 * run length is what tells us whether the early-exit could have fired.
 */
export function parseStdout(stdout: string): {
  downloaded: string[];
  skipped: number;
  longestSkipRun: number;
} {
  const downloaded: string[] = [];
  let skipped = 0;
  let currentRun = 0;
  let longestSkipRun = 0;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      skipped += 1;
      currentRun += 1;
      if (currentRun > longestSkipRun) longestSkipRun = currentRun;
      continue;
    }
    // A download resets the run: the budget counts consecutive skips.
    currentRun = 0;
    downloaded.push(line);
  }

  return { downloaded, skipped, longestSkipRun };
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
): {
  status: FetchStatus;
  downloaded: string[];
  skipped: number;
  longestSkipRun: number;
  error: string | null;
} {
  const { downloaded, skipped, longestSkipRun } = parseStdout(stdout);
  const partial = summariseFailures(stderr);
  return {
    status: partial ? "error" : "ok",
    downloaded,
    skipped,
    longestSkipRun,
    error: partial
  };
}

/**
 * Did the extractor stop early because it had skipped enough files in a row?
 *
 * gallery-dl's `-A` budget counts *consecutive* skips and resets after every
 * download, so the run of skips in the output is what decides. The budget is
 * not known here — the caller compares.
 */
export function stoppedEarly(longestSkipRun: number, budget: number): boolean {
  return budget > 0 && longestSkipRun >= budget;
}

/**
 * Is this a fault of the download archive rather than of Instagram or of the
 * gallery?
 *
 * gallery-dl's SQLite backend has no exception handling around the archive,
 * so a locked file escapes as a generic `OperationalError` and aborts the
 * whole extractor. The message it produces names the problem.
 */
export function isArchiveFault(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("database is locked") ||
    text.includes("database table is locked") ||
    text.includes("database schema is locked") ||
    text.includes("attempt to write a readonly database") ||
    text.includes("malformed database schema") ||
    text.includes("disk i/o error") ||
    text.includes("failed to open download archive")
  );
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
  if (isArchiveFault(text)) {
    return "archive-unavailable";
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

/**
 * Was the child killed because it ran out of time?
 *
 * Node does NOT report a timeout as `code === "ETIMEDOUT"` — it reports
 * `code: null`, `killed: true` and `signal: "SIGTERM"`. Checking the code
 * alone would silently miss every timeout.
 */
export function isTimeoutFailure(
  failure: RawRun["failure"]
): boolean {
  if (!failure) return false;
  if (failure.code === "ETIMEDOUT") return true;
  return failure.killed === true && failure.signal === "SIGTERM";
}

/**
 * Turn one raw gallery-dl run into a result.
 *
 * This is the whole failure taxonomy, kept separate from the spawn so it can
 * be tested without running Python.
 */
export function interpretRun(
  run: RawRun,
  timeoutMinutes: number,
  durationMs: number,
  /** The `-A` budget the run was given; 0 means "no early-exit". */
  abortBudget: number = 0
): FetchResult {
  const { stdout, stderr, failure } = run;

  if (isTimeoutFailure(failure)) {
    return {
      status: "error",
      downloadedPaths: [],
      skippedCount: 0,
      stoppedEarly: false,
      error: `gallery-dl timed out after ${timeoutMinutes} minutes`,
      durationMs
    };
  }

  // Exited 0 — the steady state is "everything already downloaded".
  if (!failure) {
    const outcome = statusForSuccessfulRun(stdout, stderr);
    return {
      status: outcome.status,
      downloadedPaths: outcome.downloaded,
      skippedCount: outcome.skipped,
      stoppedEarly: stoppedEarly(outcome.longestSkipRun, abortBudget),
      error: outcome.error,
      durationMs
    };
  }

  // Exited non-zero. A non-zero exit still leaves usable stdout: gallery-dl
  // aborts the extractor after the `-A` budget, which is a normal, successful
  // outcome.
  const { downloaded, skipped, longestSkipRun } = parseStdout(stdout);
  const partial = summariseFailures(stderr);
  const stopped = stoppedEarly(longestSkipRun, abortBudget);

  if (downloaded.length > 0) {
    // A ledger fault is checked FIRST: gallery-dl can download a few files
    // before the archive locks, and a partial success must not mask the fact
    // that the ledger is unusable.
    const archiveFault = isArchiveFault(stderr);
    return {
      status: archiveFault ? "archive-unavailable" : partial ? "error" : "ok",
      downloadedPaths: downloaded,
      skippedCount: skipped,
      stoppedEarly: stopped,
      error: partial,
      durationMs
    };
  }

  return {
    status: classifyError(stderr),
    downloadedPaths: [],
    skippedCount: skipped,
    stoppedEarly: stopped,
    error: stderr.trim().slice(0, 500) || failure.message,
    durationMs
  };
}

/** The default spawn: run gallery-dl in a child process. */
export const spawnGalleryDl: SpawnGalleryDl = async (opts) => {
  const { config } = opts;
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
    return { stdout, stderr, failure: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      killed?: boolean;
      signal?: string | null;
    };
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      failure: {
        code: err.code ?? null,
        message: err.message,
        killed: err.killed,
        signal: err.signal ?? null
      }
    };
  }
};

/**
 * Run gallery-dl once and report what changed.
 *
 * When the download archive turns out to be locked, the run is repeated
 * without it. That is not a downgrade of the dedup guarantee: the on-disk
 * check still skips every file that is already in the gallery, so nothing is
 * downloaded twice. Only the fast path is lost.
 */
export async function runGalleryDl(opts: FetchOptions): Promise<FetchResult> {
  const { config, galleryRoot } = opts;
  const startedAt = Date.now();

  const installed = await readInstalledVersion(config.galleryDlDir);
  if (!installed) {
    return {
      status: "error",
      downloadedPaths: [],
      skippedCount: 0,
      stoppedEarly: false,
      error: "gallery-dl is not installed — install it from the plugin's Update control",
      durationMs: Date.now() - startedAt
    };
  }

  if (!isVersionAtLeast(installed, config.minGalleryDlVersion)) {
    return {
      status: "gallery-dl-too-old",
      downloadedPaths: [],
      skippedCount: 0,
      stoppedEarly: false,
      error: `gallery-dl ${installed} is too old; ${config.minGalleryDlVersion} or newer is required`,
      durationMs: Date.now() - startedAt
    };
  }

  const spawn = opts.spawn ?? spawnGalleryDl;

  const budget = opts.abortAfterSkips ?? config.abortAfterSkips;
  const first = interpretRun(
    await spawn(opts),
    config.timeoutMinutes,
    Date.now() - startedAt,
    budget
  );
  if (first.status !== "archive-unavailable") {
    return first;
  }

  // The ledger is the problem — not Instagram, not the gallery. Run again
  // without it.
  const retry = interpretRun(
    await spawn({ ...opts, useArchive: false }),
    config.timeoutMinutes,
    Date.now() - startedAt,
    budget
  );

  // The first attempt may already have downloaded files before the archive
  // locked. They are on disk now, so the retry skips them — but only the
  // scanner ever indexes them, and the scanner is handed the download list.
  // Both lists are merged so nothing is left behind.
  const downloadedPaths = [
    ...first.downloadedPaths,
    ...retry.downloadedPaths.filter((path) => !first.downloadedPaths.includes(path))
  ];

  if (retry.status === "ok" || retry.status === "archive-unavailable") {
    // The sync worked; only the ledger is missing. Say so, but do not call it
    // a failure.
    return {
      ...retry,
      status: "archive-unavailable",
      downloadedPaths,
      skippedCount: first.skippedCount + retry.skippedCount,
      error: first.error ?? retry.error
    };
  }

  // The retry's own fault is the more informative one.
  return { ...retry, downloadedPaths };
}
