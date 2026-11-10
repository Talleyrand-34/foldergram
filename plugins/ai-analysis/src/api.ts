/**
 * HTTP routes exposed by the ai-analysis plugin.
 *
 * Mounted under /api/plugins/ai-analysis by the host (see server/dist/plugins/host.ts).
 *
 *   GET  /status                       — overall progress + worker pause state
 *   GET  /search?q=&domain=&tag=&limit= — search analyzed videos
 *   POST /analyze/:imageId             — manually trigger analysis for one video
 *   POST /pause                        — admin: stop the worker from claiming work
 *   POST /resume                       — admin: start the worker again
 *   GET  /config                       — the provider + pipeline configuration
 *   POST /config                       — change the configuration
 *   POST /config/test                  — probe a provider before trusting it
 */

import type { PluginContext, Request, RequestHandler, Response } from "../../../server/dist/plugins/types.js";
import { databaseManager } from "../../../server/dist/db/database.js";
import { requireCapability } from "../../../server/dist/middleware/auth-protection.js";
import {
  enqueueAnalysis,
  getPauseState,
  getSmartStates,
  pauseWorker,
  resumeWorker
} from "./worker.js";
import { getImageAiStatus, getStatusSummary, markAllPendingInFolder, markPendingIfFresh, searchVideos } from "./storage.js";
import { validateAiConfig } from "./config.js";
import {
  getRecanonicalizationState,
  runRecanonicalizationSweep
} from "./canonicalize.js";
import {
  readAiConfig,
  saveAiConfigPatch,
  toConfigView
} from "./configStore.js";
import { countDomains } from "./storage.js";
import { getUsageStatus, invalidateUsageCache } from "./usage.js";
import { listProviderModels } from "./lib/provider-models.js";
import { buildProviderHeaders, providerUrl } from "./lib/litellm-client.js";

/** Queue control is an admin action: it decides what the worker analyses. */
const requireLibraryAdmin = requireCapability("canManageLibrary", "Admin access is required.");

/** Wrap a handler so only admins (canManageLibrary) can reach it. */
function adminOnly(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    requireLibraryAdmin(req, res, () => {
      void handler(req, res).catch((err: unknown) => {
        next(err);
      });
    });
  };
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.addRoutes([
    {
      method: "get",
      path: "/status",
      handler: async (_req: Request, res: Response) => {
        try {
          const summary = await getStatusSummary();
          // The pause state rides along with the counters so the client can
          // render it from the same poll it already does.
          res.json({ ...summary, worker: getPauseState() });
        } catch (e) {
          ctx.log(`status failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "post",
      path: "/pause",
      handler: adminOnly(async (req: Request, res: Response) => {
        const body: unknown = req.body;
        const reason =
          typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string"
            ? body.reason
            : undefined;
        const worker = pauseWorker(reason);
        ctx.log(`pause requested${reason ? `: ${reason}` : ""}`);
        res.json({ worker });
      }),
    },
    {
      method: "post",
      path: "/resume",
      handler: adminOnly(async (_req: Request, res: Response) => {
        const worker = resumeWorker();
        ctx.log("resume requested");
        res.json({ worker });
      }),
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
      path: "/canonicalization",
      handler: async (_req: Request, res: Response) => {
        try {
          const config = await readAiConfig();
          res.json({
            state: getRecanonicalizationState(),
            domains: await countDomains(),
            enabled: config.stages.canonicalizer.enabled,
            verify: config.stages.canonicalizer.verify
          });
        } catch (e) {
          ctx.log(`canonicalization status failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "post",
      path: "/canonicalization/run",
      handler: adminOnly(async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as { limit?: unknown; verify?: unknown };
        const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : 200;
        const verify = body.verify === undefined ? undefined : body.verify === true;

        ctx.log(`re-check requested (limit=${limit})`);
        const state = await runRecanonicalizationSweep(
          Math.min(1000, Math.max(1, limit)),
          verify
        );
        res.json({ state });
      }),
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
    {
      method: "get",
      path: "/config",
      handler: async (_req: Request, res: Response) => {
        try {
          const config = await readAiConfig();
          res.json({
            config: toConfigView(config),
            errors: validateAiConfig(config),
            usage: await getUsageStatus(config.providers),
            smart: getSmartStates()
          });
        } catch (e) {
          ctx.log(`config read failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      },
    },
    {
      method: "post",
      path: "/config",
      handler: adminOnly(async (req: Request, res: Response) => {
        try {
          const saved = await saveAiConfigPatch(req.body);
          // The limits may have changed, so the cached usage is stale.
          invalidateUsageCache();
          const errors = validateAiConfig(saved);
          if (errors.length > 0) {
            // The configuration is saved even when it has problems — the
            // operator may be fixing them one field at a time. The errors
            // come back so the UI can show them.
            ctx.log(`config saved with ${errors.length} problem(s): ${errors.join("; ")}`);
          } else {
            ctx.log(
              `config saved: ${saved.providers.length} provider(s), every ${saved.pipeline.frameCount} frames`
            );
          }
          res.json({
            config: toConfigView(saved),
            errors,
            usage: await getUsageStatus(saved.providers),
            smart: getSmartStates()
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          ctx.log(`config save failed: ${message}`);
          res.status(500).json({ error: "internal" });
        }
      }),
    },
    {
      method: "get",
      path: "/providers/:id/models",
      handler: adminOnly(async (req: Request, res: Response) => {
        try {
          const config = await readAiConfig();
          const id = String(req.params?.id ?? "").trim();
          const provider = config.providers.find((entry) => entry.id === id);
          if (!provider) {
            res.status(404).json({ error: "no such provider" });
            return;
          }

          // The list is read with the stored key, so it never has to travel
          // to the browser.
          const result = await listProviderModels(provider);
          res.json(result);
        } catch (e) {
          ctx.log(`models failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: "internal" });
        }
      }),
    },
    {
      method: "post",
      path: "/config/test",
      handler: adminOnly(async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as { provider?: unknown; model?: unknown };
        const config = await readAiConfig();

        // The body may carry an unsaved provider — that is the point of the
        // button: "does my new endpoint work before I save it?".
        const raw = (body.provider ?? {}) as Record<string, unknown>;
        const id = typeof raw.id === "string" ? raw.id : "";
        const stored = config.providers.find((p) => p.id === id);

        const baseUrl =
          typeof raw.baseUrl === "string" && raw.baseUrl.trim()
            ? raw.baseUrl.trim().replace(/\/+$/, "")
            : (stored?.baseUrl ?? "");
        if (!baseUrl) {
          res.status(400).json({ error: "the provider has no base URL" });
          return;
        }

        // An absent key keeps the stored one; an explicit empty string means
        // "no key", which is what a local provider needs.
        const apiKey =
          raw.apiKey === undefined || raw.apiKey === null
            ? (stored?.apiKey ?? "")
            : String(raw.apiKey);

        const headers = buildProviderHeaders({
          id,
          label: typeof raw.label === "string" ? raw.label : id,
          dialect: raw.dialect === "minimax" ? "minimax" : "openai-compatible",
          baseUrl,
          apiKey,
          defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : "",
          headers: {},
          reasoningEffort:
            typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : "",
          thinkingType: typeof raw.thinkingType === "string" ? raw.thinkingType : "",
          usageLimits: {
            enabled: false,
            budget: 0,
            windows: [],
            mode: "hard",
            smart: {
              probeUrl: "",
              probeApiKey: "",
              watch: "interval",
              pollMinutes: 2,
              idlePercent: 100,
              yieldPercent: 0,
              contentionPercent: 5,
              ignoreHardWindows: false
            }
          }
        });

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        try {
          const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
            method: "GET",
            headers,
            signal: ctrl.signal
          });
          const text = await response.text();

          if (!response.ok) {
            res.status(200).json({
              ok: false,
              status: response.status,
              message: text.slice(0, 300)
            });
            return;
          }

          // The model list is a convenience, not a requirement: some gateways
          // do not expose it. A 200 with an unparseable body is still a
          // reachable, accepting endpoint.
          let models: string[] = [];
          try {
            const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
            models = (parsed.data ?? [])
              .map((entry) => entry.id ?? "")
              .filter((modelId) => modelId !== "");
          } catch {
            models = [];
          }

          const wanted = typeof body.model === "string" ? body.model.trim() : "";
          res.json({
            ok: true,
            status: response.status,
            models: models.slice(0, 200),
            modelCount: models.length,
            modelFound: wanted ? models.includes(wanted) : null
          });
        } catch (e) {
          res.status(200).json({
            ok: false,
            status: null,
            message: e instanceof Error ? e.message : String(e)
          });
        } finally {
          clearTimeout(timer);
        }
      }),
    }
  ]);
}
