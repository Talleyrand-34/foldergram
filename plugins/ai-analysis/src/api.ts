/**
 * HTTP routes exposed by the ai-analysis plugin.
 *
 * Mounted under /api/plugins/ai-analysis by the host (see server/src/plugins/host.ts).
 *
 *   GET  /status                       — overall progress
 *   GET  /search?q=&domain=&tag=&limit= — search analyzed videos
 *   POST /analyze/:imageId             — manually trigger analysis for one video
 */

import type { Request, Response } from "express";
import { databaseManager } from "../../../server/src/db/database.js";
import type { PluginContext } from "../../../server/src/plugins/types.js";
import { enqueueAnalysis } from "./worker.js";
import { getStatusSummary, markPendingIfFresh, searchVideos } from "./storage.js";

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
        try {
          const drv = await databaseManager.getConnection();
          const row = (await drv.queryOne(
            `SELECT id, absolute_path, mtime_ms, media_type FROM images WHERE id = ? AND is_deleted = 0`,
            [imageId],
          )) as { id: number; absolute_path: string; mtime_ms: number; media_type: string } | undefined;
          if (!row || row.media_type !== "video") {
            res.status(404).json({ error: "video not found" });
            return;
          }
          const queued = await markPendingIfFresh(row.id, row.mtime_ms);
          if (!queued) {
            res.json({ imageId, queued: false, reason: "already analyzed at this mtime, or already queued" });
            return;
          }
          enqueueAnalysis({
            imageId: row.id,
            assetKey: "",
            relativePath: "",
            absolutePath: row.absolute_path,
            folderId: 0,
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
  ]);
}
