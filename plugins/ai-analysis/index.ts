/**
 * AI Analysis plugin — entrypoint.
 *
 * Listens for the `video.indexed` hook, queues the video for analysis
 * (frames + audio → domains, tags, summary, transcript), and exposes:
 *
 *   GET  /api/plugins/ai-analysis/status              → overall progress
 *   GET  /api/plugins/ai-analysis/videos              → list analyzed videos
 *   POST /api/plugins/ai-analysis/analyze/:imageId    → manual trigger
 *   GET  /api/plugins/ai-analysis/search?q=...        → search by word/domain/tag
 *
 * The plugin does NOT auto-analyze on every video.indexed by default — it
 * rate-limits itself to one concurrent analysis and respects the global
 * AI queue depth exposed via /status.
 *
 * Set AI_ANALYSIS_ENABLED=0 to disable.
 */

import { registerRoutes } from "./src/api.js";
import { startBackgroundWorker } from "./src/worker.js";

import type { Plugin } from "../../server/src/plugins/types.js";

const plugin: Plugin = {
  manifest: {
    name: "ai-analysis",
    version: "0.1.0",
    hooks: ["video.indexed"],
    requireAuth: true,
  },

  async register(ctx) {
    if (process.env.AI_ANALYSIS_ENABLED === "0") {
      ctx.log("disabled via AI_ANALYSIS_ENABLED=0");
      return;
    }

    ctx.log("registering hooks + routes");
    ctx.hooks.on("video.indexed", (asset) => {
      // Fire-and-forget: the worker manages its own queue.
      void import("./src/worker.js").then((m) => m.enqueueAnalysis(asset));
    });

    startBackgroundWorker(ctx);

    registerRoutes(ctx);
    ctx.log("ready");
  },
};

export default plugin;
