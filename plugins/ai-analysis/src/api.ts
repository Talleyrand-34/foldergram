/**
 * HTTP routes exposed by the ai-analysis plugin.
 *
 * Mounted under /api/plugins/ai-analysis by the host (see server/dist/plugins/host.ts).
 *
 *   GET  /status                       — overall progress
 *   GET  /search?q=&domain=&tag=&limit= — search analyzed videos
 *   POST /analyze/:imageId             — manually trigger analysis for one video
 */

import type { Request, Response } from "express";
import { databaseManager } from "../../../server/dist/db/database.js";
import type { PluginContext } from "../../../server/dist/plugins/types.js";
import { enqueueAnalysis } from "./worker.js";
import { getImageAiStatus, getStatusSummary, markAllPendingInFolder, markPendingIfFresh, searchVideos } from "./storage.js";

export function registerRoutes(ctx: PluginContext): void {
  ctx.addRoutes([
    {
      method: "get",
      path: "/status",
      handler: async (_req: Request, res: Response) => {
        try {
          const summary = await getStatusSummary();
          res.json(summary);
        } catch (e) {
          ctx.log(`status failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "get",
      path: "/search",
      handler: async (req: Request, res: Response) => {
        const q = typeof req.query.q === "string" ? req.query.q : undefined;
        const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
        const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
        const language = typeof req.query.language === "string" ? req.query.language : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        try {
          const hits = await searchVideos({ query: q, domain, tag, language, limit });
          res.json({ hits, count: hits.length });
        } catch (e) {
          ctx.log(`search failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "post",
      path: "/analyze/:imageId",
      handler: async (req: Request, res: Response) => {
        const imageId = Number(req.params.imageId);
        if (!Number.isFinite(imageId)) {
          res.status(400).json({ error: "invalid imageId" });
          return;
        }
        const force = req.query.force === "1" || req.query.force === "true";
        try {
          const drv = await databaseManager.getConnection();
          const row = (await drv.queryOne(
            `SELECT id, folder_id, absolute_path, mtime_ms, media_type FROM images WHERE id = ? AND is_deleted = 0`,
            [imageId],
          )) as { id: number; folder_id: number; absolute_path: string; mtime_ms: number; media_type: string } | undefined;
          if (!row || row.media_type !== "video") {
            res.status(404).json({ error: "video not found" });
            return;
          }
          const queued = await markPendingIfFresh(row.id, row.mtime_ms, { force });
          if (!queued) {
            res.json({ imageId, queued: false, reason: "already analyzed at this mtime, or already queued" });
            return;
          }
          enqueueAnalysis({
            imageId: row.id,
            assetKey: "",
            relativePath: "",
            absolutePath: row.absolute_path,
            folderId: row.folder_id,
            mediaType: "video" as const,
            extension: "",
            fileSize: 0,
            mtimeMs: row.mtime_ms,
            durationMs: null,
            width: null,
            height: null,
          });
          res.json({ imageId, queued: true });
        } catch (e) {
          ctx.log(`analyze trigger failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "post",
      path: "/analyze-folder/:folderId",
      handler: async (req: Request, res: Response) => {
        const folderId = Number(req.params.folderId);
        if (!Number.isFinite(folderId)) {
          res.status(400).json({ error: "invalid folderId" });
          return;
        }
        const force = req.query.force === "1" || req.query.force === "true";
        try {
          const drv = await databaseManager.getConnection();
          const folder = (await drv.queryOne(
            `SELECT id, name, slug FROM folders WHERE id = ?`,
            [folderId],
          )) as { id: number; name: string; slug: string } | undefined;
          if (!folder) {
            res.status(404).json({ error: "folder not found" });
            return;
          }
          const result = await markAllPendingInFolder(folderId, { force });
          ctx.log(
            `analyze-folder: ${folder.name} marked=${result.marked} alreadyAnalyzed=${result.alreadyAnalyzed} alreadyQueued=${result.alreadyQueued} force=${force}`,
          );
          res.json({
            folderId,
            folderSlug: folder.slug,
            ...result,
            force,
          });
        } catch (e) {
          ctx.log(`analyze-folder failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "get",
      path: "/image/:imageId/status",
      handler: async (req: Request, res: Response) => {
        const imageId = Number(req.params.imageId);
        if (!Number.isFinite(imageId)) {
          res.status(400).json({ error: "invalid imageId" });
          return;
        }
        try {
          const status = await getImageAiStatus(imageId);
          if (!status) {
            res.status(404).json({ error: "video not found" });
            return;
          }
          res.json({ imageId, ...status });
        } catch (e) {
          ctx.log(`image status failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
  ]);
}
