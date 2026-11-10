/**
 * How many requests each provider has actually sent.
 *
 * The smart usage mode has to answer one question: *is somebody else using
 * this provider's plan?* The plan reports what **everybody** used, so the
 * only way to tell our own share from the rest is to know what we sent.
 *
 * The counter lives in memory on purpose. It is read once every couple of
 * minutes and only ever compared against a pool reading taken at the same
 * moment, so a restart costs one interval of history — the probe takes a
 * fresh baseline and carries on. That is worth a lot less than a write on
 * the hot path of every request.
 *
 * The counts are bucketed by the minute, so the memory stays bounded no
 * matter how many videos are analysed.
 */

/** One provider's counts, bucketed by the minute. */
interface ProviderBucket {
  /** The minute the bucket starts at, in epoch milliseconds. */
  minute: number;
  /** The requests sent in that minute. */
  count: number;
}

/** How long the buckets are kept. The longest window is a week. */
const KEEP_MS = 8 * 24 * 3_600_000;

const buckets = new Map<string, ProviderBucket[]>();

/**
 * Count one request to a provider.
 *
 * Called by the provider client on every upstream call, so the count is what
 * the provider saw — not what the pipeline meant to send.
 */
export function noteProviderRequest(providerId: string): void {
  if (!providerId) return;

  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const list = buckets.get(providerId) ?? [];

  const last = list[list.length - 1];
  if (last && last.minute === minute) {
    last.count += 1;
  } else {
    list.push({ minute, count: 1 });
  }

  // Old buckets are dropped as we go, so the map cannot grow without bound.
  const cutoff = minute - KEEP_MS;
  while (list.length > 0 && list[0].minute < cutoff) list.shift();

  buckets.set(providerId, list);
}

/** The requests a provider sent since a moment, in epoch milliseconds. */
export function providerRequestsSince(providerId: string, since: number): number {
  const list = buckets.get(providerId);
  if (!list) return 0;

  let total = 0;
  for (const bucket of list) {
    if (bucket.minute >= since) total += bucket.count;
  }
  return total;
}

/** The requests a provider sent between two moments. */
export function providerRequestsBetween(
  providerId: string,
  from: number,
  to: number
): number {
  const list = buckets.get(providerId);
  if (!list) return 0;

  let total = 0;
  for (const bucket of list) {
    if (bucket.minute >= from && bucket.minute < to) total += bucket.count;
  }
  return total;
}

/** Every request a provider sent, in total. */
export function providerRequestTotal(providerId: string): number {
  const list = buckets.get(providerId);
  if (!list) return 0;

  let total = 0;
  for (const bucket of list) total += bucket.count;
  return total;
}

/** Forget everything. Used by the tests and when the configuration changes. */
export function resetProviderRequests(): void {
  buckets.clear();
}
