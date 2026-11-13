/**
 * A small client for Valkey (and for Redis, which speaks the same protocol).
 *
 * Why not a library: the cache only needs four commands, and the deployment
 * of this project copies the build output and restarts the service. A
 * dependency would have to be installed on every host before the new build
 * could start, and a host that is missing it would run the old code (or
 * crash) instead of the new one. So the protocol is spoken here, over a
 * socket, with nothing to install.
 *
 * The protocol is RESP2, which is small enough to read in one sitting:
 *
 *   - a request is an array of bulk strings: `*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n`
 *   - a reply is one of: `+ok`, `-ERR message`, `:42`, `$3\r\nfoo`, `$-1` (nil)
 *
 * Only the commands the cache needs are implemented: PING, GET, SET (with an
 * expiry), DEL and SCAN. Everything is best effort: a cache that cannot be
 * reached must never take the application down with it.
 */

import net from 'node:net';
import tls from 'node:tls';

/** How long a command may take before it is given up on. */
const COMMAND_TIMEOUT_MS = 2_000;

export class ValkeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValkeyError';
  }
}

/** A reply that the server refused. */
class ValkeyReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValkeyReplyError';
  }
}

type Reply = string | number | null | Reply[];

interface PendingCommand {
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Parses RESP2 replies out of a byte stream.
 *
 * The replies arrive in the order the commands were sent, so the parser only
 * has to hand them back one by one.
 */
class RespParser {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feeds a chunk in and returns every reply that is complete. */
  push(chunk: Buffer): Reply[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const replies: Reply[] = [];

    for (;;) {
      const parsed = this.parseAt(0);
      if (!parsed) break;
      replies.push(parsed.value);
      this.buffer = this.buffer.subarray(parsed.consumed);
    }

    return replies;
  }

  /** Parses one reply that starts at the given offset. */
  private parseAt(offset: number): { value: Reply; consumed: number } | null {
    if (this.buffer.length <= offset) return null;

    const type = this.buffer[offset];
    const lineEnd = this.buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;

    const line = this.buffer.subarray(offset + 1, lineEnd).toString('utf8');

    switch (type) {
      case 0x2b: // '+' simple string
        return { value: line, consumed: lineEnd + 2 };

      case 0x2d: // '-' error
        throw new ValkeyReplyError(line);

      case 0x3a: // ':' integer
        return { value: Number(line), consumed: lineEnd + 2 };

      case 0x24: { // '$' bulk string
        const length = Number(line);
        const start = lineEnd + 2;
        if (length === -1) return { value: null, consumed: start };
        if (this.buffer.length < start + length + 2) return null;
        const value = this.buffer.subarray(start, start + length).toString('utf8');
        return { value, consumed: start + length + 2 };
      }

      case 0x2a: { // '*' array
        const count = Number(line);
        const start = lineEnd + 2;
        if (count === -1) return { value: null, consumed: start };

        const items: Reply[] = [];
        let cursor = start;

        for (let index = 0; index < count; index += 1) {
          const item = this.parseAt(cursor);
          if (!item) return null;
          items.push(item.value);
          cursor = item.consumed;
        }

        return { value: items, consumed: cursor };
      }

      default:
        // An unknown type means the stream is not RESP: the connection is
        // unusable from here on.
        this.buffer = Buffer.alloc(0);
        throw new ValkeyError(`unexpected reply type ${String.fromCharCode(type)}`);
    }
  }
}

export interface ValkeyOptions {
  /** The connection string, e.g. `valkey://127.0.0.1:6379`. */
  readonly url: string;
  /** The key every entry is stored under. */
  readonly keyPrefix?: string;
}

/**
 * A connection to a Valkey server.
 *
 * The connection is opened when the first command is sent and closed when the
 * cache is shut down. Every command is answered in order, so the replies are
 * matched to the commands with a queue.
 */
export class ValkeyClient {
  private readonly url: URL;
  private readonly keyPrefix: string;
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending: PendingCommand[] = [];
  private readonly parser = new RespParser();
  private closed = false;

  constructor(options: ValkeyOptions) {
    this.url = new URL(options.url);
    this.keyPrefix = options.keyPrefix ?? '';
  }

  /** Whether the client has been shut down. */
  get isClosed(): boolean {
    return this.closed;
  }

  private key(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private ensureSocket(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const secure = this.url.protocol === 'valkeys:' || this.url.protocol === 'rediss:';
      const port = Number(this.url.port || (secure ? 6380 : 6379));
      const host = this.url.hostname || '127.0.0.1';

      const socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });

      const onError = (error: Error) => {
        this.socket = null;
        this.connecting = null;
        this.failAll(error);
        reject(error);
      };

      socket.setNoDelay(true);

      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        socket.on('error', () => {
          this.socket = null;
          this.failAll(new ValkeyError('the connection to the cache was lost'));
        });
        socket.on('close', () => {
          this.socket = null;
          this.failAll(new ValkeyError('the connection to the cache was closed'));
        });
        socket.on('data', (chunk: Buffer) => this.onData(chunk));

        this.socket = socket;
        this.connecting = null;
        resolve();
      });
    });

    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    let replies: Reply[];
    try {
      replies = this.parser.push(chunk);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new ValkeyError(String(error)));
      this.socket?.destroy();
      this.socket = null;
      return;
    }

    for (const reply of replies) {
      const command = this.pending.shift();
      if (!command) continue;
      clearTimeout(command.timer);
      command.resolve(reply);
    }
  }

  private failAll(error: Error): void {
    while (this.pending.length > 0) {
      const command = this.pending.shift();
      if (!command) break;
      clearTimeout(command.timer);
      command.reject(error);
    }
  }

  /** Sends a command and waits for its reply. */
  private async send(parts: string[]): Promise<Reply> {
    if (this.closed) throw new ValkeyError('the cache client is closed');

    await this.ensureSocket();
    const socket = this.socket;
    if (!socket) throw new ValkeyError('the cache is not connected');

    const payload = parts
      .map((part) => `$${Buffer.byteLength(part, 'utf8')}\r\n${part}\r\n`)
      .join('');
    const frame = `*${parts.length}\r\n${payload}`;

    const entry: PendingCommand = {
      resolve: () => undefined,
      reject: () => undefined,
      timer: setTimeout(() => undefined, COMMAND_TIMEOUT_MS)
    };

    const reply = new Promise<Reply>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => {
        // The command is taken out of the queue, or the next reply would
        // answer the wrong promise.
        const index = this.pending.indexOf(entry);
        if (index !== -1) this.pending.splice(index, 1);
        reject(new ValkeyError(`the cache did not answer in ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      // The timer must not keep the process alive on its own.
      entry.timer.unref?.();
      this.pending.push(entry);
    });

    socket.write(frame);
    return reply;
  }

  /** Checks that the server answers. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.send(['PING']);
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /** Reads one key. */
  async get(key: string): Promise<string | null> {
    const reply = await this.send(['GET', this.key(key)]);
    if (reply === null) return null;
    return String(reply);
  }

  /** Writes one key with an expiry. */
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.send(['SET', this.key(key), value, 'EX', String(seconds)]);
  }

  /** Removes one key. */
  async del(key: string): Promise<void> {
    await this.send(['DEL', this.key(key)]);
  }

  /**
   * Removes every key that starts with a prefix.
   *
   * The scan walks the keyspace in batches, so a big keyspace does not have
   * to be listed all at once.
   */
  async delByPrefix(prefix: string): Promise<void> {
    const pattern = `${this.keyPrefix}${prefix}*`;
    let cursor = '0';

    do {
      const reply = await this.send(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
      if (!Array.isArray(reply)) return;

      const [nextCursor, keys] = reply;
      cursor = String(nextCursor ?? '0');

      if (Array.isArray(keys) && keys.length > 0) {
        await this.send(['DEL', ...keys.map((key) => String(key))]);
      }
    } while (cursor !== '0');
  }

  /** Closes the connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new ValkeyError('the cache client was closed'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }
}
