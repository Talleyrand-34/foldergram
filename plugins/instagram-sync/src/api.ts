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
import type { Request, RequestHandler, Response } from "express";

import { requireCapability } from "../../../server/dist/middleware/auth-protection.js";
import type { PluginContext } from "../../../server/dist/plugins/types.js";

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
import { isRunning, runSyncNow, schedulerState } from "./scheduler.js";

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

          res.json({
            enabled: config.enabled,
            sourceUrl: config.sourceUrl,
            cron: config.cron,
            nextRunAt: scheduler.nextRunAt,
            running: scheduler.running,
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
            lastRun: scheduler.lastRun
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
            res.status(409).json({ message: "a sync is already running" });
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
          res.json({ collections });
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

          // The work happens in the background: mirroring one collection takes
          // minutes, and a request that long just looks like a failure.
          void runMirrorJob(
            () => listInstagramCollections(config),
            (collection) => listCollectionMedia(config, collection),
            galleryRoot,
            requested,
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
    }
  ]);
}
