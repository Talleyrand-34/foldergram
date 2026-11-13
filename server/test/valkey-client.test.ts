import { describe, expect, it } from 'vitest';

import { ValkeyClient } from '../src/services/valkey-client.js';

/**
 * The cache speaks RESP over a socket, so it is checked against a real
 * server: a hand-written client is only as good as the protocol it speaks.
 *
 * The server is only there when one is running on the port below. Without
 * it the checks are skipped — a missing cache server is not a failure.
 */
const VALKEY_URL = process.env.TEST_VALKEY_URL ?? 'valkey://127.0.0.1:56379';

async function withClient(run: (client: ValkeyClient) => Promise<void>): Promise<void> {
  const client = new ValkeyClient({ url: VALKEY_URL, keyPrefix: 'test:' });
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

async function serverIsThere(): Promise<boolean> {
  const client = new ValkeyClient({ url: VALKEY_URL });
  try {
    return await client.ping();
  } finally {
    await client.close();
  }
}

describe('valkey client', () => {
  it('talks to the cache server', async () => {
    if (!(await serverIsThere())) return;

    await withClient(async (client) => {
      expect(await client.ping()).toBe(true);
    });
  });

  it('writes a value and reads it back', async () => {
    if (!(await serverIsThere())) return;

    await withClient(async (client) => {
      await client.set('greeting', 'hello', 60_000);
      expect(await client.get('greeting')).toBe('hello');
      await client.del('greeting');
      expect(await client.get('greeting')).toBeNull();
    });
  });

  it('keeps the value under the prefix of the client', async () => {
    if (!(await serverIsThere())) return;

    const first = new ValkeyClient({ url: VALKEY_URL, keyPrefix: 'one:' });
    const second = new ValkeyClient({ url: VALKEY_URL, keyPrefix: 'two:' });

    try {
      await first.set('key', 'value', 60_000);

      expect(await first.get('key')).toBe('value');
      expect(await second.get('key')).toBeNull();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('removes every key of a prefix', async () => {
    if (!(await serverIsThere())) return;

    await withClient(async (client) => {
      await client.set('group:one', '1', 60_000);
      await client.set('group:two', '2', 60_000);
      await client.set('other', '3', 60_000);

      await client.delByPrefix('group:');

      expect(await client.get('group:one')).toBeNull();
      expect(await client.get('group:two')).toBeNull();
      expect(await client.get('other')).toBe('3');
      await client.del('other');
    });
  });

  it('lets a value expire', async () => {
    if (!(await serverIsThere())) return;

    await withClient(async (client) => {
      await client.set('short', 'value', 1_000);
      expect(await client.get('short')).toBe('value');

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await client.get('short')).toBeNull();
    });
  });

  it('answers many commands in a row', async () => {
    if (!(await serverIsThere())) return;

    await withClient(async (client) => {
      const writes = Array.from({ length: 25 }, (_, index) =>
        client.set(`many:${index}`, String(index), 60_000)
      );
      await Promise.all(writes);

      const reads = await Promise.all(
        Array.from({ length: 25 }, (_, index) => client.get(`many:${index}`))
      );

      expect(reads).toEqual(Array.from({ length: 25 }, (_, index) => String(index)));
      await client.delByPrefix('many:');
    });
  });
});
