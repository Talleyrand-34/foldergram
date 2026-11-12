/**
 * Continuous profiling of the Node.js process.
 *
 * The profiles leave the application as pprof and land in a Pyroscope server,
 * which Grafana reads to draw the flame graphs. This is the counterpart of the
 * metrics: the metrics say *how long*, the flame graph says *where*.
 *
 * The wall profiler is the interesting one: it samples the stack every few
 * milliseconds and charges the time between two samples to the stack that was
 * running, so the time spent waiting for the database shows up in the graph
 * as the stack that was waiting for it.
 *
 * The profiling is off unless `PYROSCOPE_SERVER_ADDRESS` says where the
 * profiles go. When it is off the module is not even loaded: the native
 * profiler is only required when there is somewhere to send the profiles to.
 */

import { createRequire } from 'node:module';

import { appConfig } from '../config/env.js';
import { log } from '../services/log-service.js';
import { readResourceAttributes } from './telemetry.js';

/**
 * The part of the Pyroscope client that is used here.
 *
 * The client is a CommonJS module, so it is loaded with `require` instead of
 * an import: an import would load it (and its native profiler) on every boot,
 * even when the profiling is off.
 */
interface PyroscopeClient {
  init(config: Record<string, unknown>): void;
  startWallProfiling(): void;
  startHeapProfiling(): void;
  stopWallProfiling(): Promise<void>;
  stopHeapProfiling(): Promise<void>;
}

let client: PyroscopeClient | null = null;
let started = false;

/**
 * Whether the profiling is configured.
 *
 * Without a server address there is nowhere to send the profiles to.
 */
export function isProfilingEnabled(): boolean {
  return appConfig.pyroscope.serverAddress !== null;
}

/**
 * The tags every profile of this process carries.
 *
 * They are the resource attributes of the telemetry (`env`, `host`), so a
 * profile and a metric of the same deployment are labelled the same way.
 */
function buildTags(): Record<string, string> {
  const attributes = readResourceAttributes();
  const serviceName = (process.env.OTEL_SERVICE_NAME ?? 'foldergram').trim() || 'foldergram';

  return {
    env: attributes.env ?? 'unknown',
    host: attributes.host ?? process.env.HOSTNAME ?? 'unknown',
    service: serviceName
  };
}

/**
 * Starts the profiling.
 *
 * It is safe to call it more than once: the second call does nothing. It
 * never throws: a profiling that cannot start must not stop the application.
 */
export function startProfiling(): void {
  if (started || !isProfilingEnabled()) {
    return;
  }

  const serverAddress = appConfig.pyroscope.serverAddress;

  if (!serverAddress) {
    return;
  }

  try {
    const require = createRequire(import.meta.url);
    const loaded = require('@pyroscope/nodejs') as { default?: PyroscopeClient } & PyroscopeClient;
    const pyroscope = loaded.default ?? loaded;

    pyroscope.init({
      serverAddress,
      appName: appConfig.pyroscope.applicationName,
      tags: buildTags(),
      flushIntervalMs: appConfig.pyroscope.flushIntervalMs,
      // The CPU time is collected together with the wall time, so the same
      // profile answers "how long" and "how much of it was the CPU".
      wall: {
        collectCpuTime: true,
        samplingDurationMs: appConfig.pyroscope.wallSamplingDurationMs,
        samplingIntervalMicros: appConfig.pyroscope.wallSamplingIntervalMicros
      },
      basicAuthUser: appConfig.pyroscope.basicAuthUser,
      basicAuthPassword: appConfig.pyroscope.basicAuthPassword,
      tenantID: appConfig.pyroscope.tenantId
    });

    pyroscope.startWallProfiling();

    if (appConfig.pyroscope.heapEnabled) {
      pyroscope.startHeapProfiling();
    }

    client = pyroscope;
    started = true;

    log.info('Profiling enabled', {
      server: serverAddress,
      app: appConfig.pyroscope.applicationName,
      heap: appConfig.pyroscope.heapEnabled ? 'on' : 'off'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Could not start the profiler', message);
  }
}

/**
 * Stops the profiling and flushes the last profile.
 *
 * Called on shutdown, so the last minutes of the process are not lost.
 */
export async function stopProfiling(): Promise<void> {
  if (!started || !client) {
    return;
  }

  started = false;

  const pyroscope = client;
  client = null;

  try {
    await pyroscope.stopWallProfiling();

    if (appConfig.pyroscope.heapEnabled) {
      await pyroscope.stopHeapProfiling();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Could not stop the profiler', message);
  }
}
