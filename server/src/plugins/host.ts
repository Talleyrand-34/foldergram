/**
 * PluginHost — discovers, loads, and runs plugins from `plugins/<name>/`.
 *
 * Lifecycle:
 *   1. `await host.loadAll()` — called once at boot, after DB + auth + scanner init.
 *      Reads `plugins/<name>/manifest.json`, dynamically imports the entrypoint,
 *      calls `register(ctx)`. Plugins may register hooks and routes here.
 *
 *   2. `await host.emit(event, ...args)` — called by core code (e.g. scanner-service)
 *      when something interesting happens. Each registered hook fires; errors are
 *      logged but do not stop the chain.
 *
 *   3. `host.mountRoutes(app)` — called after `createApp()`, before listen. Mounts
 *      each plugin's routes under `/api/plugins/<name>`. Optional; if no plugins
 *      declare routes, this is a no-op.
 *
 * Config:
 *   PLUGINS_DIR (default: <cwd>/plugins) — where to look for plugin directories.
 *   PLUGINS_ENABLED (default: 1) — set to 0 to disable plugin loading entirely.
 */

import fs from "node:fs";
import path from "node:path";

import type { Express } from "express";

import { appConfig, repositoryRoot } from "../config/env.js";
import { log } from "../services/log-service.js";
import {
  type HookEvents,
  type Plugin,
  type PluginContext,
  type PluginManifest,
  type PluginRoute,
  HookEmitter
} from "./types.js";

interface LoadedPlugin {
  plugin: Plugin;
  ctx: PluginContext;
  routes: PluginRoute[];
}

class PluginHost {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly emitter = new HookEmitter();
  private loaded = false;

  /** Resolve the plugins directory. Env-overridable for tests. */
  private pluginsDir(): string {
    return process.env.PLUGINS_DIR ?? path.join(repositoryRoot, "plugins");
  }

  /** Discover + load every plugin. Called once at boot. */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    if (process.env.PLUGINS_ENABLED === "0") {
      log.info("Plugin host disabled via PLUGINS_ENABLED=0");
      return;
    }

    const dir = this.pluginsDir();
    if (!fs.existsSync(dir)) {
      log.info("Plugin host: no plugins directory", { dir });
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip hidden / scratch directories so we can put experiments under
      // plugins/<name>/.scratch/ without them trying to register.
      if (entry.name.startsWith(".")) continue;

      const pluginDir = path.join(dir, entry.name);
      const manifestPath = path.join(pluginDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;

      await this.loadOne(entry.name, pluginDir, manifestPath);
    }
  }

  private async loadOne(dirName: string, pluginDir: string, manifestPath: string): Promise<void> {
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PluginManifest;
    } catch (e) {
      log.error(`Plugin ${dirName}: invalid manifest.json`, e instanceof Error ? e.message : String(e));
      return;
    }

    if (!manifest.name || !manifest.version) {
      log.error(`Plugin ${dirName}: manifest missing required fields (name, version)`);
      return;
    }

    // Resolve entrypoint. Default to index.ts; ts-node-less, so we expect either
    // a compiled .js next to the .ts (production), or that the project uses
    // tsx/ts-node in dev. We use a dynamic import — the caller resolves.
    const entryRel = manifest.entry ?? "index.js";
    const entryPath = path.join(pluginDir, entryRel);

    if (!fs.existsSync(entryPath)) {
      // Fallback: try .ts if .js was requested and we're in dev (tsx/ts-node
      // resolves the .ts at runtime via their loader; if neither is installed,
      // this load fails and we log).
      const tsFallback = entryPath.replace(/\.js$/, ".ts");
      if (entryRel.endsWith(".js") && fs.existsSync(tsFallback)) {
        await this.tryLoad(dirName, pluginDir, manifest, tsFallback);
        return;
      }
      log.error(`Plugin ${dirName}: entrypoint not found`, { entryPath });
      return;
    }

    await this.tryLoad(dirName, pluginDir, manifest, entryPath);
  }

  private async tryLoad(
    dirName: string,
    pluginDir: string,
    manifest: PluginManifest,
    entryPath: string,
  ): Promise<void> {
    let mod: { default?: Plugin } & Partial<Plugin>;
    try {
      mod = await import(entryPath);
    } catch (e) {
      log.error(
        `Plugin ${dirName}: failed to import ${entryPath}`,
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
      return;
    }

    const plugin: Plugin | undefined = mod.default ?? ((mod as Plugin).register ? (mod as Plugin) : undefined);
    if (!plugin || typeof plugin.register !== "function") {
      log.error(`Plugin ${dirName}: no default export with a register(ctx) function`);
      return;
    }

    const routes: PluginRoute[] = [];
    const ctx: PluginContext = {
      config: appConfig,
      log: (msg, extra) => log.info(`plugin[${manifest.name}] ${msg}`, extra),
      hooks: this.emitter,
      addRoutes: (rs) => { routes.push(...rs); },
    };

    try {
      await plugin.register(ctx);
    } catch (e) {
      log.error(
        `Plugin ${dirName}: register() threw`,
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
      return;
    }

    this.plugins.set(manifest.name, { plugin, ctx, routes });
    log.info(`Plugin loaded: ${manifest.name} v${manifest.version}`, {
      hooks: manifest.hooks ?? [],
      routes: routes.length,
      dir: pluginDir,
    });
  }

  /** Emit a hook event. Errors in individual handlers are logged, not thrown. */
  async emit<K extends keyof HookEvents>(
    event: K,
    ...args: Parameters<HookEvents[K]>
  ): Promise<void> {
    // HookEmitter.emit already calls handlers sequentially. We wrap to add
    // logging + per-handler isolation: one plugin's bug must not break the rest.
    const set = (this.emitter as unknown as {
      handlers: Map<K, Set<HookEvents[K]>>;
    }).handlers.get(event);
    if (!set || set.size === 0) return;

    for (const handler of set) {
      try {
        await (handler as (...a: typeof args) => unknown)(...args);
      } catch (e) {
        log.error(
          `Plugin hook ${String(event)} threw`,
          e instanceof Error ? (e.stack ?? e.message) : String(e),
        );
      }
    }
  }

  /** Mount every plugin's routes under /api/plugins/<name>. */
  mountRoutes(app: Express): void {
    if (this.plugins.size === 0) return;

    for (const [name, loaded] of this.plugins) {
      if (loaded.routes.length === 0) continue;
      const requireAuth = loaded.plugin.manifest.requireAuth !== false;
      for (const route of loaded.routes) {
        const fullPath = `/api/plugins/${name}${route.path.startsWith("/") ? route.path : `/${route.path}`}`;
        const handlers = requireAuth
          ? [route.handler] // auth is applied at the /api mount in app.ts
          : [route.handler];
        app[route.method](fullPath, ...handlers);
        log.info(`Plugin route mounted`, { plugin: name, method: route.method.toUpperCase(), path: fullPath });
      }
    }
  }

  /** For diagnostics / status endpoints. */
  listLoaded(): Array<{ name: string; version: string; hooks: string[]; routes: number }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.plugin.manifest.name,
      version: p.plugin.manifest.version,
      hooks: p.plugin.manifest.hooks ?? [],
      routes: p.routes.length,
    }));
  }
}

export const pluginHost = new PluginHost();
