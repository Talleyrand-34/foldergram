/**
 * instagram-sync plugin — entrypoint.
 *
 * Syncs an Instagram saved-posts feed into the gallery on a schedule.
 *
 * The plugin owns its gallery-dl working set under a hidden directory inside
 * the gallery root (`<galleryRoot>/.instagram-sync/`):
 *
 *   cookies.txt      the live Instagram session (0600)
 *   archive.sqlite   the download ledger (adopted from the pvei archive)
 *   gallery-dl/      the vendored, versioned gallery-dl (updatable from the UI)
 *
 * The hidden directory matters twice over: the scanner skips dot-prefixed
 * paths (`server/src/utils/path-utils.ts:24`), so the plugin's own files are
 * never indexed; and the gallery is a separate btrfs mount, so the working set
 * does not compete with Postgres for the (much smaller) root filesystem.
 *
 * The schedule is first-class: it is stored in the database and edited from
 * the UI (`pollConfig.ts`). A poll refreshes the general library and/or the
 * saved collections, on an interval the user picks.
 *
 * Routes (all under /api/plugins/instagram-sync):
 *   GET  /status            → plugin + gallery-dl + cookie + archive state
 *   POST /run               → trigger a library sync now
 *   POST /cookie            → upload a fresh session cookie (text/plain)
 *   GET  /gallery-dl/check  → ask PyPI for the latest gallery-dl
 *   POST /gallery-dl/update → download, verify and activate a newer gallery-dl
 *   GET  /collections       → the user's Instagram saved collections
 *   POST /collections/sync  → mirror them into library collections
 *   GET  /poll              → the polling configuration and its state
 *   POST /poll              → change the polling configuration
 *   POST /poll/run          → trigger a poll now
 *
 * Set INSTAGRAM_SYNC_ENABLED=0 to disable the plugin entirely.
 */

import fs from "node:fs/promises";

import type { Plugin } from "../../../server/dist/plugins/types.js";

import { registerRoutes } from "./api.js";
import { loadConfig } from "./config.js";
import { startScheduler } from "./scheduler.js";

const plugin: Plugin = {
  manifest: {
    name: "instagram-sync",
    version: "0.1.0",
    hooks: [],
    requireAuth: true
  },
  async register(ctx) {
    if (process.env.INSTAGRAM_SYNC_ENABLED === "0") {
      ctx.log("disabled via INSTAGRAM_SYNC_ENABLED=0");
      return;
    }

    const config = loadConfig(ctx.config);
    const galleryRoot = ctx.config.galleryRoot;

    await fs.mkdir(config.workDir, { recursive: true });
    await fs.mkdir(config.galleryDlDir, { recursive: true });

    registerRoutes(ctx, { config, galleryRoot });
    await startScheduler(ctx, config, galleryRoot);

    ctx.log(`ready: source=${config.sourceUrl} workDir=${config.workDir}`);
  }
};

export default plugin;
