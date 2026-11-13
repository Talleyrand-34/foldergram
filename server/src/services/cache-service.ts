/**
 * A cache for the answers that are expensive to compute and cheap to keep.
 *
 * Two backends are behind the same door:
 *
 *  - **Valkey** (or any Redis-compatible server), when `VALKEY_URL` points at
 *    one. The cache is then shared by every process that talks to the same
 *    server, and it survives a restart.
 *  - **The process itself**, when there is no server to talk to. The cache is
 *    then private to this process and disappears with it.
 *
 * The second one is not a consolation prize: it is what makes the first one
 * optional. The application never has to know which backend it got, and a
 * cache that cannot be reached never takes the application down with it.
 *
 * The cache is also single-flighted: when a key is cold and ten requests ask
 * for it at the same time, the expensive work runs once and the nine others
 * wait for the answer instead of running it ten times.
 */

import { appConfig } from '../config/env.js';
import { log } from './log-service.js';
import { ValkeyClient, type ValkeyOptions } from './valkey-client.js';

/** How long the cache waits before it tries the Valkey server again. */
const BACKEND_RETRY_MS = 10_000;

/** How many entries the in-process cache keeps before it drops the oldest. */
const MEMORY_MAX_ENTRIES = 2_000;

export type CacheBackendKind = 'memory' | 'valkey';

interface CacheEntry {
  readonly value: string;
  readonly expiresAt: number;
}

/** The operations every backend has to offer. */
interface CacheBackend {
  readonly kind: CacheBackendKind;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  delByPrefix(prefix: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The in-process cache.
 *
 * The entries are removed when they are read and found to be expired, and the
 * oldest entry is dropped when the cache grows past its limit — a cache that
 * grows without bound is a memory leak with a nice name.
 */
class MemoryBackend implements CacheBackend {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, CacheEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (this.entries.size >= MEMORY_MAX_ENTRIES && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }

    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

/** The Valkey backend, wrapped so a broken server is a failed command. */
class ValkeyBackend implements CacheBackend {
  readonly kind = 'valkey' as const;

  constructor(private readonly client: ValkeyClient) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(key, value, ttlMs);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    await this.client.delByPrefix(prefix);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export interface CacheOptions {
  /** The connection string of the Valkey server, if there is one. */
  readonly valkeyUrl?: string | undefined;
  /** The prefix every key is stored under. */
  readonly keyPrefix?: string | undefined;
}

/** What the cache did, for the metrics and the tests. */
export interface CacheStats {
  readonly backend: CacheBackendKind;
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly errors: number;
}

export class CacheService {
  private readonly memory = new MemoryBackend();
  private valkey: CacheBackend | null = null;
  private valkeyBrokenUntil = 0;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private errors = 0;

  constructor(options: CacheOptions = {}) {
    if (options.valkeyUrl) {
      const clientOptions: ValkeyOptions = {
        url: options.valkeyUrl,
        keyPrefix: options.keyPrefix ?? 'foldergram:'
      };
      this.valkey = new ValkeyBackend(new ValkeyClient(clientOptions));
    }
  }

  /** Which backend is in use. */
  get backend(): CacheBackendKind {
    return this.valkey && Date.now() >= this.valkeyBrokenUntil ? 'valkey' : 'memory';
  }

  /** The counters of the cache. */
  get stats(): CacheStats {
    return {
      backend: this.backend,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      errors: this.errors
    };
  }

  /**
   * The backend a command should go to.
   *
   * When the Valkey server has just failed, the process cache takes over for
   * a while: a cache that cannot be reached must not turn every read into a
   * connection attempt that has to time out.
   */
  private target(): CacheBackend {
    if (!this.valkey) return this.memory;
    if (Date.now() < this.valkeyBrokenUntil) return this.memory;
    return this.valkey;
  }

  /** Runs a command against the backend, falling back to the process cache. */
  private async run<T>(command: (backend: CacheBackend) => Promise<T>): Promise<T> {
    const backend = this.target();
    if (backend === this.memory) return command(this.memory);

    try {
      return await command(backend);
    } catch (error) {
      this.errors += 1;
      this.valkeyBrokenUntil = Date.now() + BACKEND_RETRY_MS;
      const message = error instanceof Error ? error.message : String(error);
      log.warn('the cache server could not be reached, the process cache takes over', { error: message });
      return command(this.memory);
    }
  }

  /** Reads one key. */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.run((backend) => backend.get(key));
    if (raw === null) {
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value that cannot be read is treated as a miss: the caller then
      // computes the answer again.
      this.misses += 1;
      return null;
    }
  }

  /** Writes one key. */
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.writes += 1;
    const raw = JSON.stringify(value);
    await this.run((backend) => backend.set(key, raw, ttlMs));
  }

  /**
   * Reads one key, and computes it when it is not there.
   *
   * The computation runs once even when several callers ask for the same key
   * at the same time.
   */
  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const promise = load()
      .then(async (value) => {
        await this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Removes one key. */
  async invalidate(key: string): Promise<void> {
    await this.run((backend) => backend.del(key));
  }

  /** Removes every key that starts with a prefix. */
  async invalidatePrefix(prefix: string): Promise<void> {
    await this.run((backend) => backend.delByPrefix(prefix));
  }

  /** Closes the cache. */
  async close(): Promise<void> {
    await this.valkey?.close();
    await this.memory.close();
  }
}

let instance: CacheService | null = null;

/**
 * The cache of this process.
 *
 * The settings of the environment are the default, so the cache is the same
 * one whoever asks for it first — the server or a plugin.
 *
 * @param options How the cache is built. Only the first call counts: the
 * cache is a process wide thing, so it is built once.
 */
export function getCacheService(options: CacheOptions = {}): CacheService {
  if (!instance) {
    instance = new CacheService({
      valkeyUrl: options.valkeyUrl ?? appConfig.valkeyUrl,
      keyPrefix: options.keyPrefix ?? appConfig.cacheKeyPrefix
    });
  }
  return instance;
}

/** Forgets the cache. Used by the tests. */
export function resetCacheService(): void {
  instance = null;
}
