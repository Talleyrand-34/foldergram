import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach } from 'vitest';
import pg from 'pg';

import { createScratchSchema, assertSharedSchemaIsClean, SCHEMA_RESET_SQL } from './helpers/dialect.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Global test setup.
 *
 * 1. The suite always runs with NODE_ENV=test.
 * 2. The repository's own `data/` directory is guarded: a test that forgets to
 *    redirect the storage paths would otherwise write into the developer's real
 *    library (and leak state into the next run).
 * 3. The environment is restored after every test file. Vitest reuses worker
 *    processes for several files, so a file that leaves a stubbed value behind
 *    (for example a DATA_ROOT pointing at a directory it just deleted) would
 *    otherwise break the next file in the same worker.
 * 4. When the suite runs against PostgreSQL, every test file gets its own
 *    schema. Without it all files would share one database and see each
 *    other's rows.
 */

process.env.NODE_ENV = 'test';

const repositoryDataDir = path.join(repositoryRoot, 'data');

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

const filesBeforeTestRun = await listFilesRecursively(repositoryDataDir);
const environmentSnapshot = { ...process.env };

const usePostgres =
  (process.env.DB_DRIVER ?? '').trim().toLowerCase() === 'postgres' ||
  (process.env.DATABASE_URL ?? '').trim().length > 0;

let scratchSchema: { schema: string; connectionUrl: string } | null = null;

/**
 * The scratch schema of this worker process.
 *
 * The schema name is stable for a whole run, so the migration set is applied
 * once instead of once per worker. The rows are deleted before every test (see
 * the reset below), so the files still do not see each other's data. The
 * files of a run have to be serialized while they share it, which is what the
 * `maxForks` setting of the PostgreSQL path does.
 */
const schemaScope = globalThis as typeof globalThis & {
  __foldergramScratchSchema?: { schema: string; connectionUrl: string };
};

if (usePostgres) {
  const baseUrl = process.env.DATABASE_URL!;

  // The app tables must not be in the shared "public" schema: the tests run
  // in their own schema, and a table that is missing there would silently
  // fall back to the shared one. This fails the file loudly instead of
  // letting the test files see each other's rows.
  await assertSharedSchemaIsClean(baseUrl);

  try {
    scratchSchema = schemaScope.__foldergramScratchSchema ?? null;

    if (!scratchSchema) {
      scratchSchema = await createScratchSchema(baseUrl, 'foldergram_suite');
      schemaScope.__foldergramScratchSchema = scratchSchema;
    }

    process.env.DATABASE_URL = scratchSchema.connectionUrl;
    process.env.DB_DRIVER = 'postgres';
  } catch (error) {
    // Without an isolated schema the DB backed tests would see each other's
    // rows. That is loud (the tests fail), but it must not be silent.
    console.warn(
      `[test setup] Could not create an isolated PostgreSQL schema for this test file: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The DB backed tests of this file will run against the shared database.'
    );
  }
}

/**
 * Empties the isolated schema before every test.
 *
 * The SQLite tests get their isolation from the database file inside the
 * temporary data root (every test deletes the data root, so the file is
 * recreated). PostgreSQL has no such file, so the rows of the isolated schema
 * are deleted instead - including the identity sequences, so the row ids
 * restart at 1 just like on SQLite.
 *
 * The reset must never fail silently: a schema that still holds the rows of
 * the previous test makes the next test see stale state, which shows up as a
 * mystery failure somewhere else. So the reset retries a few times and then
 * fails the test with the blocking sessions listed.
 */
const RESET_ATTEMPTS = 5;
const RESET_LOCK_TIMEOUT = '5s';

const RESET_SQL = SCHEMA_RESET_SQL;

/**
 * Lists the sessions that are holding a transaction open - they are the ones
 * the reset waits for.
 */
async function describeBlockingSessions(client: pg.Client): Promise<string> {
  try {
    const { rows } = await client.query<{
      pid: number;
      state: string;
      wait_event_type: string | null;
      wait_event: string | null;
      query: string;
    }>(
      `SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND (state LIKE 'idle in transaction%' OR xact_start IS NOT NULL)
       ORDER BY xact_start`
    );

    if (rows.length === 0) {
      return 'no other session holds a transaction open';
    }

    return rows
      .map(
        (row) =>
          `pid ${row.pid} (${row.state}` +
          `${row.wait_event_type ? `, waiting for ${row.wait_event_type}/${row.wait_event}` : ''}): ` +
          `${row.query.replace(/\s+/g, ' ').trim()}`
      )
      .join(' | ');
  } catch (error) {
    return `the blocking sessions could not be listed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

beforeEach(async () => {
  if (!scratchSchema) {
    return;
  }

  const connectionString = scratchSchema.connectionUrl;

  // The environment is restored after every file, and the restoration can
  // land after this file's setup code has run. The connection string of the
  // isolated schema therefore has to be re-asserted before every test:
  // without it a test would migrate the shared "public" schema.
  process.env.DATABASE_URL = connectionString;
  process.env.DB_DRIVER = 'postgres';

  // A client of the pool may still be busy with the previous test. It holds
  // the locks of its last transaction, and the reset would wait for it.
  try {
    const { waitForPoolIdle } = await import('../src/db/driver/postgres-driver.js');
    await waitForPoolIdle(connectionString, 5000);
  } catch (error) {
    console.warn(
      `[test setup] Could not wait for the idle PostgreSQL pool: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }

  let lastError: unknown;
  let blockingSessions = '';

  for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt += 1) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });

    try {
      await client.connect();
      await client.query(`SET lock_timeout = '${RESET_LOCK_TIMEOUT}'`);
      await client.query(`SET statement_timeout = '120s'`);
      await client.query(RESET_SQL);
      return;
    } catch (error) {
      lastError = error;
      blockingSessions = await describeBlockingSessions(client);

      console.warn(
        `[test setup] Reset of the isolated PostgreSQL schema failed ` +
          `(attempt ${attempt}/${RESET_ATTEMPTS}): ` +
          `${error instanceof Error ? error.message : String(error)}. Blocking sessions: ${blockingSessions}`
      );
    } finally {
      await client.end().catch(() => undefined);
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  throw new Error(
    `[test setup] The isolated PostgreSQL schema could not be reset after ${RESET_ATTEMPTS} attempts, ` +
      'so this test would see the rows of the previous one. Last error: ' +
      `${lastError instanceof Error ? lastError.message : String(lastError)}. ` +
      `Blocking sessions: ${blockingSessions}`
  );
});

afterAll(async () => {
  if (scratchSchema) {
    // Release the connection pool of this file. Vitest reuses the worker
    // process for the next file, and a pool that is never closed keeps its
    // database connections open.
    //
    // This happens *before* the environment is restored: the import pulls in
    // the config module, which reads the environment once and caches it.
    try {
      const { PostgresDriver } = await import('../src/db/driver/postgres-driver.js');
      await new PostgresDriver(scratchSchema.connectionUrl).close();
    } catch (error) {
      console.warn(
        `[test setup] Could not close the PostgreSQL connection pool: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    // The scratch schema is shared by the files of this worker, so it must not
    // be dropped here. The leftovers of a previous run are cleaned up when the
    // schema is created.
  }

  // Restore the environment - but only the values this file set, and only if
  // they still hold them.
  //
  // Vitest reuses the worker process for the next file, and that file may
  // already have set up its own scratch schema (its setup runs before this
  // file's teardown finishes). Restoring the original values unconditionally
  // would point the next file's config module at the shared database, and its
  // migrations would run against the "public" schema.
  //
  // The storage paths are not touched: they are stubbed by the test files
  // themselves, and vitest restores them per file.
  if (scratchSchema && process.env.DATABASE_URL === scratchSchema.connectionUrl) {
    if (environmentSnapshot.DATABASE_URL) {
      process.env.DATABASE_URL = environmentSnapshot.DATABASE_URL;
    } else {
      delete process.env.DATABASE_URL;
    }
  }

  const filesAfterTestRun = await listFilesRecursively(repositoryDataDir);
  const writtenFiles = filesAfterTestRun.filter((file) => !filesBeforeTestRun.includes(file));

  if (writtenFiles.length > 0) {
    throw new Error(
      `This test file wrote into the repository data directory (${repositoryDataDir}). ` +
        'Storage paths must be redirected to a temporary directory. Files: ' +
        writtenFiles.join(', ')
    );
  }
});
