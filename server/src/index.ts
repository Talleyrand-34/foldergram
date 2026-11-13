/*
    Foldergram - Local-only photo and video gallery
    Copyright (C) 2026 Sajjad Ali

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { createServer } from "node:http";

import { appConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { collectionRepository, initRepositories } from "./db/repositories.js";
import { log } from "./services/log-service.js";
import { authService } from "./services/auth-service.js";
import { getCacheService } from "./services/cache-service.js";
import { pluginHost } from "./plugins/host.js";
import { scannerService } from "./services/scanner-service.js";
import { watcherService } from "./services/watcher-service.js";
import { shutdownTelemetry, startTelemetry } from "./observability/telemetry.js";
import { startProfiling, stopProfiling } from "./observability/pyroscope.js";

function logServerReady(): void {
  if (!appConfig.isDevelopment) {
    log.info(`HTTP server listening on http://${appConfig.host}:${appConfig.port}`);
    return;
  }

  const firstClientPort = appConfig.devClientPorts[0] ?? appConfig.devClientPort;
  const lastClientPort = appConfig.devClientPorts.at(-1) ?? appConfig.devClientPort;
  const clientPortRange =
    firstClientPort === lastClientPort ? String(firstClientPort) : `${firstClientPort}-${lastClientPort}`;

  log.table(
    "Development server ready",
    [
      ["API", `http://localhost:${appConfig.port}`],
      ["Health", `http://localhost:${appConfig.port}/api/health`],
      ["Client ports", clientPortRange]
    ],
    "success"
  );
}

async function bootstrap(): Promise<void> {
  // The telemetry pipeline is started before anything else so the first
  // requests are already covered. Without an exporter this is a no-op.
  startTelemetry();
  // The profiling is off unless there is a Pyroscope server to send the
  // profiles to. When it is off, nothing is even loaded.
  startProfiling();

  // The cache is built before anything reads from it. Without a cache server
  // the cache keeps the answers inside this process, which is what a single
  // node installation needs anyway.
  const cache = getCacheService();
  log.info(
    cache.backend === "valkey"
      ? `Cache server ready (${appConfig.valkeyUrl})`
      : "Cache running inside this process (no VALKEY_URL)"
  );

  await initRepositories();
  await authService.initialize();
  await scannerService.initialize();
  await pluginHost.loadAll();
  const app = createApp();
  pluginHost.mountRoutes(app);
  const server = createServer(app);
  const portVariableName = appConfig.nodeEnv === "production" ? "SERVER_PORT" : "DEV_SERVER_PORT";
  await collectionRepository.ensureDefaultCollection();
  const repairedCollectionMemberships = await collectionRepository.repairDefaultMemberships();
  if (repairedCollectionMemberships > 0) {
    log.info(`Repaired ${repairedCollectionMemberships} saved collection memberships`);
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      log.error(
        `Port ${appConfig.port} is already in use`,
        `Another server is already listening on that port. Stop it first or change ${portVariableName} for this runtime.`,
      );
    } else {
      log.error("HTTP server failed to start", error.message);
    }

    process.exitCode = 1;
  });

  server.listen(appConfig.port, appConfig.host, () => {
    logServerReady();
    void scannerService.handleStartup("startup").then((startupAction) => {
      if (startupAction === "blocked") {
        log.info("Gallery watcher deferred until the library rebuild completes");
        return;
      }

      if (startupAction === "idle" && appConfig.isDevelopment) {
        log.info(
          "Gallery watcher idle until a user-triggered scan or rebuild starts it",
        );
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Startup action failed", message);
    });
  });

  async function shutdown(signal: string): Promise<void> {
    log.info(`Received ${signal}, shutting down`);
    await watcherService.stop();
    // Flush the last batch of metrics and traces before the process goes.
    await shutdownTelemetry();
    // The last profile is flushed too, so the last minutes are not lost.
    await stopProfiling();
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void bootstrap();
