/**
 * HTTP surface for the plugin.
 *
 * All routes are mounted under `/api/plugins/instagram-sync`. Authentication is
 * applied by the server at the `/api` mount (`server/src/app.ts:53`); the
 * mutating routes additionally require the `canManageLibrary` capability,
 * which is the same guard the core library routes use.
 */

import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { PluginContext, Request, RequestHandler, Response } from "../../../server/dist/plugins/types.js";

import { requireCapability } from "../../../server/dist/middleware/auth-protection.js";

import {
  readCookieFile,
  readCookieUpdatedAt,
  validateCookie,
  writeCookieFile
} from "./cookie.js";
import type { InstagramSyncConfig } from "./config.js";
import { compareVersions, readInstalledVersion } from "./galleryDl.js";
import {
  fetchLatestRelease,
  installRelease,
  latestKnownVersion,
  pruneVersions
} from "./galleryDlUpdater.js";
import {
  listCollectionMedia,
  listInstagramCollections,
  type InstagramCollection
} from "./instagramCollections.js";
import {
  getMirrorJob,
  isMirrorRunning,
  runMirrorJob
} from "./collectionMirror.js";
import type { MirrorSelection } from "./collectionSelection.js";
import { readCollectionStates } from "./collectionState.js";
import {
  MAX_POLL_INTERVAL_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
  isValidIntervalMinutes,
  mergePollConfig
} from "./pollConfig.js";
import { readPollConfig, writePollConfig } from "./pollStore.js";
import {
  isRunning,
  nextScheduledRun,
  reschedule,
  runPollNow,
  runSyncNow,
  schedulerState
} from "./scheduler.js";
import { readDeepScanState } from "./state.js";

interface RouteDeps {
  config: InstagramSyncConfig;
  galleryRoot: string;
}

interface ArchiveStats {
  present: boolean;
  entries: number;
  sizeBytes: number;
}

/**
 * Run the capability guard, then the handler. The plugin route contract
 * takes a single `RequestHandler`, so the guard and the handler are composed
 * here rather than passed as an array.
 */
function withCapability(
  capability: "canManageLibrary" | "canAccessSettings",
  message: string,
  handler: RequestHandler
): RequestHandler {
  const guard = requireCapability(capability, message);
  return (req, res, next) => {
    guard(req, res, () => {
      handler(req, res, next);
    });
  };
}

async function archiveStats(archiveFile: string): Promise<ArchiveStats> {
  try {
    const stats = await fs.stat(archiveFile);
    let entries = 0;
    try {
      const db = new DatabaseSync(archiveFile, { readOnly: true });
      try {
        const row = db.prepare("SELECT COUNT(*) AS n FROM archive").get();
        entries = Number((row as { n?: number }).n ?? 0);
      } finally {
        db.close();
      }
    } catch {
      entries = 0;
    }
    return { present: true, entries, sizeBytes: stats.size };
  } catch {
    return { present: false, entries: 0, sizeBytes: 0 };
  }
}

export function registerRoutes(ctx: PluginContext, deps: RouteDeps): void {
  const { config, galleryRoot } = deps;

  ctx.addRoutes([
    {
      method: "get",
      path: "/status",
      handler: async (_req: Request, res: Response) => {
        try {
          const installed = await readInstalledVersion(config.galleryDlDir);
          const cookieText = await readCookieFile(config.cookieFile);
          const cookieValidation =
            cookieText === null
              ? { ok: false, reason: "no cookie file" }
              : validateCookie(cookieText);
          const scheduler = await schedulerState();
          const archive = await archiveStats(config.archiveFile);
          const latest = await latestKnownVersion();
          const poll = await readPollConfig();

          res.json({
            enabled: config.enabled,
            sourceUrl: config.sourceUrl,
            nextRunAt: scheduler.nextRunAt,
            running: scheduler.running,
            // The early-exit budgets, so the operator can see why a poll
            // walked as far as it did.
            budgets: {
              feed: config.abortAfterSkips,
              collections: config.abortAfterSkipsCollections,
              intensive: config.abortAfterSkipsDeep
            },
            // An intensive scan is waiting to run, and why.
            deepScan: await readDeepScanState(),
            galleryDl: {
              installed,
              latest,
              minRequired: config.minGalleryDlVersion,
              updateAvailable:
                latest !== null &&
                installed !== null &&
                compareVersions(latest, installed) > 0
            },
            cookie: {
              present: cookieText !== null,
              valid: cookieValidation.ok,
              updatedAt: await readCookieUpdatedAt(config.cookieFile)
            },
            archive,
            lastRun: scheduler.lastRun,
            poll: {
              enabled: poll.enabled,
              intervalMinutes: poll.intervalMinutes,
              library: poll.library,
              collections: poll.collections,
              collectionMode: poll.collectionMode,
              collectionIds: poll.collectionIds,
              collectionNames: poll.collectionNames,
              nextRunAt: scheduler.nextRunAt,
              lastRun: scheduler.lastPoll
            }
          });
        } catch (error) {
          ctx.log(
            `status failed: ${error instanceof Error ? error.message : String(error)}`
          );
          res.status(500).json({ message: "status failed" });
        }
      }
    },
    {
      method: "post",
      path: "/run",
      handler: withCapability(
        "canManageLibrary",
        "Library management access required",
        async (_req: Request, res: Response) => {
          if (isRunning()) {
            res.status(409).json({ message: "a sync or poll is already running" });
            return;
          }

          // The run continues in the background; the response only confirms it
          // started.
          void runSyncNow(galleryRoot).catch((error: unknown) => {
            ctx.log(
              `sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });

          res.json({ started: true });
        }
      )
    },
    {
      method: "post",
      path: "/cookie",
      handler: withCapability(
        "canManageLibrary",
        "Library management access required",
        async (req: Request, res: Response) => {
          try {
            const body = typeof req.body === "string" ? req.body : "";
            if (!body.trim()) {
              res.status(400).json({ message: "cookie body is empty" });
              return;
            }

            const validation = validateCookie(body);
            if (!validation.ok) {
              res.status(400).json({ message: `invalid cookie file: ${validation.reason}` });
              return;
            }

            await writeCookieFile(config.cookieFile, body);
            ctx.log("cookie updated");
            // Never echo the cookie back.
            res.json({ ok: true });
          } catch (error) {
            ctx.log(
              `cookie upload failed: ${error instanceof Error ? error.message : String(error)}`
            );
            res.status(500).json({ message: "cookie upload failed" });
          }
        }
      )
    },
    {
      method: "get",
      path: "/gallery-dl/check",
      handler: async (_req: Request, res: Response) => {
        try {
          const installed = await readInstalledVersion(config.galleryDlDir);
          const release = await fetchLatestRelease();
          res.json({
            latest: release?.version ?? null,
            installed,
            updateAvailable:
              release !== null &&
              installed !== null &&
              compareVersions(release.version, installed) > 0
          });
        } catch (error) {
          ctx.log(
            `gallery-dl check failed: ${error instanceof Error ? error.message : String(error)}`
          );
          res.status(502).json({ message: "could not reach PyPI" });
        }
      }
    },
    {
      method: "post",
      path: "/gallery-dl/update",
      handler: withCapability(
        "canManageLibrary",
        "Library management access required",
        async (_req: Request, res: Response) => {
          try {
            const installed = await readInstalledVersion(config.galleryDlDir);
            const release = await fetchLatestRelease();
            if (!release) {
              res.status(502).json({ message: "could not reach PyPI" });
              return;
            }

            if (installed !== null && compareVersions(release.version, installed) <= 0) {
              res.json({ updated: false, version: installed });
              return;
            }

            const activated = await installRelease(release, config.galleryDlDir);
            await pruneVersions(config.galleryDlDir);
            ctx.log(`gallery-dl updated: ${installed ?? "none"} -> ${activated}`);

            res.json({ updated: true, from: installed, to: activated });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.log(`gallery-dl update failed: ${message}`);
            res.status(500).json({ message });
          }
        }
      )
    },
    {
      method: "get",
      path: "/collections",
      handler: async (_req: Request, res: Response) => {
        try {
          const collections = await listInstagramCollections(config);
          const states = await readCollectionStates();

          // Each collection carries its own status: how many posts it holds,
          // how many of them are in the library, and what the last mirror did.
          res.json({
            collections: collections.map((collection) => ({
              ...collection,
              state: states[collection.id] ?? null
            }))
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.log(`collection list failed: ${message}`);
          res.status(502).json({ message });
        }
      }
    },
    {
      method: "post",
      path: "/collections/sync",
      handler: withCapability(
        "canManageLibrary",
        "Library management access required",
        async (req: Request, res: Response) => {
          if (isMirrorRunning()) {
            res.status(409).json({ message: "a collection mirror is already running" });
            return;
          }

          const requested = typeof req.query.name === "string" ? req.query.name : null;
          const selection: MirrorSelection | null = requested
            ? { names: [requested] }
            : null;

          // The work happens in the background: mirroring one collection takes
          // minutes, and a request that long just looks like a failure.
          void runMirrorJob(
            () => listInstagramCollections(config),
            async (collection, onProgress, knownPaths, pendingPaths) =>
              listCollectionMedia(config, collection, onProgress, {
                knownPaths,
                pendingPaths,
                stopAfter: config.abortAfterSkipsCollections
              }),
            galleryRoot,
            selection,
            new Set<string>(),
            (result) =>
              ctx.log(
                `mirrored collection "${result.name}": ${result.addedCount}/${result.mediaCount} media, ${result.missingCount} missing`
              )
          );

          res.json({ started: true });
        }
      )
    },
    {
      method: "get",
      path: "/collections/sync",
      handler: async (_req: Request, res: Response) => {
        res.json(getMirrorJob());
      }
    },
    {
      method: "get",
      path: "/poll",
      handler: async (_req: Request, res: Response) => {
        try {
          const poll = await readPollConfig();
          const scheduler = await schedulerState();
          res.json({
            config: poll,
            nextRunAt: scheduler.nextRunAt,
            running: scheduler.running,
            lastRun: scheduler.lastPoll,
            limits: {
              minIntervalMinutes: MIN_POLL_INTERVAL_MINUTES,
              maxIntervalMinutes: MAX_POLL_INTERVAL_MINUTES
            }
          });
        } catch (error) {
          ctx.log(
            `poll status failed: ${error instanceof Error ? error.message : String(error)}`
          );
          res.status(500).json({ message: "poll status failed" });
        }
      }
    },
    {
      method: "post",
      path: "/poll",
      handler: withCapability(
        "canManageLibrary",
        "Library management access required",
        async (req: Request, res: Response) => {
          try {
            const body = (req.body ?? {}) as Record<string, unknown>;

            // An out-of-range interval is rejected rather than clamped: the
            // user asked for something specific.
            if (
              body.intervalMinutes !== undefined &&
              !isValidIntervalMinutes(body.intervalMinutes)
            ) {
              res.status(400).json({
                message: `the polling interval must be between ${MIN_POLL_INTERVAL_MINUTES} and ${MAX_POLL_INTERVAL_MINUTES} minutes`
              });
              return;
            }

            const current = await readPollConfig();
            const saved = await writePollConfig(mergePollConfig(current, body));

            // The new schedule takes effect immediately.
            await reschedule();

            ctx.log(
              `poll configured: every ${saved.intervalMinutes} min, library=${saved.library}, collections=${saved.collections} (${saved.collectionMode})`
            );

            res.json({ config: saved, nextRunAt: nextScheduledRun()?.toISOString() ?? null });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.log(`poll configuration failed: ${message}`);
            res.status(500).json({ message });
          }
        }
      )
    },
    {
      method: "post",
      path: "/poll/run",
      handler: withCapability(
        "canManageLibrary",
        "Library management access required",
        async (_req: Request, res: Response) => {
          if (isRunning()) {
            res.status(409).json({ message: "a poll is already running" });
            return;
          }

          // The poll continues in the background; the response only confirms
          // it started.
          void runPollNow(galleryRoot)
            .then(() => reschedule())
            .catch((error: unknown) => {
              ctx.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
            });

          res.json({ started: true });
        }
      )
    }
  ]);
}
