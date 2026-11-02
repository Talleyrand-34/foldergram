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

import { registerRoutes } from "./api.js";
import { startBackgroundWorker } from "./worker.js";
import { getPauseState, getRateLimitState } from "./worker.js";
import {
  addDomainNode,
  applyCanonicalization,
  deleteDomain,
  getAnalysisStats,
  getDistinctFolderIdsWithPendingOrUnanalyzedVideos,
  getDistinctLanguages,
  getDomainEdges,
  getExistingDomainsForCanonicalization,
  getExistingLanguagesForCanonicalization,
  getFolderRollup,
  getFoldersWithRollup,
  getTopDomains,
  getVideoStats,
  getVideosForDomain,
  listPendingSynonyms,
  markFolderUnanalyzedAsPending,
  recordPendingSynonym,
  registerNewDomain,
  renameDomain,
  resolvePendingSynonym,
  touchExistingDomain,
  updateDomainDescription,
  updateFolderRollupOverride,
} from "./storage.js";

import type { Plugin } from "../../../server/dist/plugins/types.js";

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
        void import("./worker.js").then((m) => m.enqueueAnalysis(asset));
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

/**
 * Named exports exposed for the host server to call into. The plugin
 * loader attaches this object to the plugin's LoadedPlugin.exposes so
 * the server's main router can pull stats / knowledge queries without
 * reaching into the plugin's internals.
 */
export const exposes = {
  getAnalysisStats,
  getVideoStats,
  getFolderRollup,
  getFoldersWithRollup,
  getTopDomains,
  getDomainEdges,
  getDistinctLanguages,
  getVideosForDomain,
  getDistinctFolderIdsWithPendingOrUnanalyzedVideos,
  markFolderUnanalyzedAsPending,
  getRateLimitState,
  getPauseState,
  updateFolderRollupOverride,
  addDomainNode,
  renameDomain,
  deleteDomain,
  updateDomainDescription,
  getExistingDomainsForCanonicalization,
  getExistingLanguagesForCanonicalization,
  registerNewDomain,
  touchExistingDomain,
  applyCanonicalization,
  recordPendingSynonym,
  listPendingSynonyms,
  resolvePendingSynonym,
};
