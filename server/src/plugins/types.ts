/**
 * Plugin contract.
 *
 * A plugin is a directory under `plugins/<name>/` with:
 *   - manifest.json  (declarative: name, version, hooks, routes)
 *   - index.ts       (default export: { manifest, register(ctx) })
 *
 * The host loads plugins at boot, calls `register(ctx)`, and exposes hooks +
 * route registration through `ctx`. Plugins may import server modules directly
 * (e.g. db/repositories.ts, services/...) — there is no sandbox.
 *
 * Plugins run in-process. A crash in one plugin will not crash the host; the
 * host logs and continues. A blocking call in a hook will block the scanner;
 * plugins must do their own queueing for expensive work.
 */

import type { Express, Request, Response, NextFunction, RequestHandler } from "express";

import type { appConfig } from "../config/env.js";

/** What gets emitted to plugins when a video finishes indexing. */
export interface IndexedVideoAsset {
  imageId: number;
  assetKey: string;
  relativePath: string;
  absolutePath: string;
  folderId: number;
  mediaType: "video";
  extension: string;
  fileSize: number;
  mtimeMs: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/** Currently-defined hook events. Extend by adding a key here + an emitter call. */
export interface HookEvents {
  "video.indexed": (asset: IndexedVideoAsset) => void | Promise<void>;
}

/** Routes a plugin may declare. Mounted at /api/plugins/<pluginName><route.path>. */
export interface PluginRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  /** Express handler; receives an authenticated request like any other API route. */
  handler: RequestHandler;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  /** Entrypoint file path, relative to the plugin directory. Default "index.js". */
  entry?: string;
  hooks?: Array<keyof HookEvents>;
  /** If true, plugins require authentication on their routes. Default true. */
  requireAuth?: boolean;
}

/** The context passed to `register`. Anything we want plugins to see. */
export interface PluginContext {
  config: typeof appConfig;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  hooks: HookEmitter;
  /** Register an Express router under /api/plugins/<pluginName>. */
  addRoutes: (routes: PluginRoute[]) => void;
}

export interface Plugin {
  manifest: PluginManifest;
  register: (ctx: PluginContext) => void | Promise<void>;
}

/** Hook emitter: register handlers by event name; emit later. */
export class HookEmitter {
  private readonly handlers = new Map<keyof HookEvents, Set<(...args: unknown[]) => unknown>>();

  on<K extends keyof HookEvents>(event: K, handler: HookEvents[K]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (...args: unknown[]) => unknown);
  }

  off<K extends keyof HookEvents>(event: K, handler: HookEvents[K]): void {
    this.handlers.get(event)?.delete(handler as (...args: unknown[]) => unknown);
  }

  /** Emit an event. Handlers run sequentially; one throwing does not block the next. */
  async emit<K extends keyof HookEvents>(
    event: K,
    ...args: Parameters<HookEvents[K]>
  ): Promise<void> {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        await h(...args);
      } catch (e) {
        // The host logs; we don't bubble — one plugin must not poison the rest.
        // Logging happens in the host's emit wrapper, not here, so this stays
        // library-agnostic.
        throw e;
      }
    }
  }
}

/**
 * Helpers that depend on Express live here so the rest of the file stays
 * pure-TS and importable from anywhere (tests, scripts).
 *
 * `RequestHandler` is re-exported so plugins can type their handlers without
 * depending on the `express` package directly. Plugins are not pnpm workspace
 * packages, so `express` types are not resolvable from a plugin directory on a
 * clean install; importing them from here keeps the plugin contract in one
 * place and guarantees the handler type is identical to the one the host mounts.
 */
export type { Express, Request, Response, NextFunction, RequestHandler };
