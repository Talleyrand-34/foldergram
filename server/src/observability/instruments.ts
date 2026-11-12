/**
 * Shared access to the OpenTelemetry instruments.
 *
 * The instruments are bound to the meter provider that was active when they
 * were created. If the provider is replaced (the pipeline starts late, or the
 * tests install a new one), the instruments have to be created again, or they
 * would keep reporting to a provider nobody reads.
 *
 * This module holds that rule in one place, so every facade (the AI usage,
 * the database, the HTTP requests) follows the same one.
 */

import { metrics, type Meter } from '@opentelemetry/api';

const SCOPE_NAME = 'foldergram';

interface InstrumentCache {
  readonly provider: unknown;
  readonly instruments: unknown;
}

const caches = new Map<string, InstrumentCache>();

/**
 * Returns the instruments of a facade, creating them if the meter provider
 * changed since the last call.
 *
 * @param key The name of the facade. Each one gets its own instruments.
 * @param create Builds the instruments from a meter.
 */
export function getInstruments<T>(key: string, create: (meter: Meter) => T): T {
  const provider = metrics.getMeterProvider();
  const cached = caches.get(key);

  if (cached && cached.provider === provider) {
    return cached.instruments as T;
  }

  const instruments = create(metrics.getMeter(SCOPE_NAME));
  caches.set(key, { provider, instruments });

  return instruments;
}

/** The name of the instrumentation scope every facade reports under. */
export const TELEMETRY_SCOPE_NAME = SCOPE_NAME;
