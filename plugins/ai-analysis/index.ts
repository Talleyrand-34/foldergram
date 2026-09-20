/**
 * AI Analysis plugin — entrypoint.
 *
 * AI parsing is OPT-IN. Rescans, library rebuilds, and automatic scans
 * never trigger AI analysis. To analyze a video, hit the per-video or
 * per-folder endpoints, or click the buttons in the UI.
 *
 *   GET  /api/plugins/ai-analysis/status                  → overall progress
 *   GET  /api/plugins/ai-analysis/search?q=...            → search analyzed videos
 *   POST /api/plugins/ai-analysis/analyze/:imageId[?force] → enqueue one video
 *   POST /api/plugins/ai-analysis/analyze-folder/:folderId[?force] → enqueue all videos in a folder
 *
 * The `video.indexed` hook fires on every scan but this plugin deliberately
 * does NOT subscribe to it. We only act when the user explicitly asks.
 *
 * Set AI_ANALYSIS_ENABLED=0 to disable the plugin entirely (worker + routes).
 * Set AI_ANALYSIS_AUTO_QUEUE=1 to subscribe to the hook (NOT recommended —
 * rescan would trigger a full re-analysis pass).
 */

import { registerRoutes } from "./src/api.js";
import { startBackgroundWorker } from "./src/worker.js";

import type { Plugin } from "../../server/src/plugins/types.js";

const plugin: Plugin = {
  manifest: {
    name: "ai-analysis",
    version: "0.1.0",
    hooks: ["video.indexed"], // documented; not subscribed by default
    requireAuth: true,
  },

  async register(ctx) {
    if (process.env.AI_ANALYSIS_ENABLED === "0") {
      ctx.log("disabled via AI_ANALYSIS_ENABLED=0");
      return;
    }

    if (process.env.AI_ANALYSIS_AUTO_QUEUE === "1") {
      // Opt-in: re-analyze every video as it gets indexed. Useful for
      // initial bulk loads, NOT for normal rescans.
      ctx.hooks.on("video.indexed", (asset) => {
        void import("./src/worker.js").then((m) => m.enqueueAnalysis(asset));
      });
      ctx.log("auto-queue enabled via AI_ANALYSIS_AUTO_QUEUE=1 — every video.indexed will enqueue");
    } else {
      ctx.log("auto-queue disabled — AI parsing is opt-in per-folder or per-post");
    }

    startBackgroundWorker(ctx);
    registerRoutes(ctx);
    ctx.log("ready");
  },
};

export default plugin;
