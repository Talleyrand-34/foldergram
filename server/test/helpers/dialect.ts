import { randomUUID } from 'node:crypto';

import pg from 'pg';

/**
 * Dialect helpers for the server test suite.
 *
 * The project is PostgreSQL-first: SQLite is the embedded fallback that is
 * being dropped. The helpers in this file make it possible to run the very
 * same test code against both dialects and to detect (and cleanly skip when
 * missing) a live PostgreSQL server.
 */

export type TestDialect = 'sqlite' | 'postgres';

/**
 * The connection string used by `docker-compose.postgres.yml`.
 */
export const DEFAULT_POSTGRES_URL =
  'postgresql://foldergram:foldergram@localhost:5432/foldergram?sslmode=disable';

export const POSTGRES_SETUP_HINT = [
  'Start PostgreSQL with: docker compose -f docker-compose.postgres.yml up -d postgres',
  'or point DATABASE_URL at an existing server, e.g.',
  'DATABASE_URL=postgresql://foldergram:foldergram@localhost:5432/foldergram?sslmode=disable'
].join('\n');

export function resolveTestDialect(env: NodeJS.ProcessEnv = process.env): TestDialect {
  if ((env.DB_DRIVER ?? '').trim().toLowerCase() === 'postgres') {
    return 'postgres';
  }

  if ((env.DATABASE_URL ?? '').trim().length > 0) {
    return 'postgres';
  }

  return 'sqlite';
}

function isUsableUrl(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Replaces the database name of a PostgreSQL connection string.
 */
export function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Adds `synchronous_commit=off` to a PostgreSQL connection string.
 *
 * The tests do not need durability, and waiting for the WAL sync on every
 * commit is by far the slowest part of a test run on a container with a slow
 * disk.
 */
export function withFastCommit(connectionString: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get('options');
  const fastCommitOption = '-c synchronous_commit=off';

  url.searchParams.set(
    'options',
    existingOptions ? `${existingOptions} ${fastCommitOption}` : fastCommitOption
  );

  return url.toString();
}

/**
 * Adds `search_path` to a PostgreSQL connection string so a test can work in
 * its own schema instead of the public one.
 */
export function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema},public -c synchronous_commit=off`);
  return url.toString();
}

async function canConnect(connectionString: string, timeoutMs = 3000): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The app tables. They must live in the private schema of a test run - if
 * they are also in the shared `public` schema, a query for a table that the
 * private schema does not have would silently fall back to the shared one and
 * the test files would see each other's rows.
 */
const APP_TABLES = [
  'folders',
  'images',
  'places',
  'collections',
  'collection_items',
  'app_settings',
  'likes',
  'scan_runs',
  'folder_scan_state',
  // The ai-analysis plugin owns these tables. They belong to the private
  // schema of a test run for exactly the same reason: a query that falls back
  // to the shared schema would read another test file's rows.
  'ai_analysis_events',
  'ai_domain_nodes',
  'ai_domain_edges',
  'ai_folder_rollup',
  'ai_synonym_pending'
] as const;

/**
 * Fails when the shared `public` schema contains the app tables.
 *
 * A test runs in its own schema, but the `public` schema has to stay on the
 * search path (it holds the `pg_trgm` extension the migrations need). If the
 * app tables are in `public` as well, a query for a table the private schema
 * does not have falls back to the shared one - and the test files see each
 * other's rows.
 */
export async function assertSharedSchemaIsClean(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: withFastCommit(connectionString), connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename = ANY ($1::text[])`,
      [[...APP_TABLES]]
    );

    if (rows.length > 0) {
      throw new Error(
        `The shared "public" schema of the test database contains the app tables ` +
          `(${rows.map((row) => row.tablename).join(', ')}). ` +
          'A test that runs in its own schema would fall back to them and see the rows of ' +
          'another test file. Use a database whose public schema is empty - the tables have to ' +
          'be created by the migrations of the test schema, not by hand.'
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Fails when the schema of the given connection does not hold the migrated
 * schema.
 *
 * That means the migrations did not run in it - the queries would silently
 * read and write the shared schema instead.
 */
export async function assertSchemaHasAppTables(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: withFastCommit(connectionString), connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename = ANY ($1::text[])`,
      [[...APP_TABLES]]
    );

    if (rows.length > 0) {
      return;
    }

    // The migrations may have been applied by an earlier connection: the
    // bookkeeping table is enough then, the app tables are not recreated.
    const { rows: migrationRows } = await client.query<{ present: number }>(
      `SELECT 1 AS present
       FROM pg_tables
       WHERE schemaname = current_schema() AND tablename = 'schema_migrations'`
    );

    if (migrationRows.length === 0) {
      throw new Error(
        'The isolated schema does not contain the migrated schema - the migrations did not run in it. ' +
          'The queries would silently read and write the shared schema.'
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface PostgresProbe {
  /** True when a PostgreSQL server answered. */
  readonly available: boolean;
  /** Human readable explanation (also used as the skip message). */
  readonly reason: string;
  /** The connection string that answered, if any. */
  readonly connectionUrl: string | null;
  /** True when the connected role may create schemas (needed for isolation). */
  readonly canCreateSchema: boolean;
}

function candidateUrls(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];

  if (isUsableUrl(env.DATABASE_URL)) {
    candidates.push(env.DATABASE_URL);
  }

  if (isUsableUrl(env.POSTGRES_TEST_URL)) {
    candidates.push(env.POSTGRES_TEST_URL);
  }

  candidates.push(DEFAULT_POSTGRES_URL);

  return [...new Set(candidates)];
}

/**
 * Detects whether a PostgreSQL server is reachable.
 *
 * Never throws: a missing database is a normal situation in CI and the caller
 * is expected to skip the PostgreSQL-only assertions with a clear message.
 */
export async function probePostgres(env: NodeJS.ProcessEnv = process.env): Promise<PostgresProbe> {
  const candidates = candidateUrls(env);
  const failures: string[] = [];

  for (const candidate of candidates) {
    if (!(await canConnect(candidate))) {
      failures.push(`${candidate}: connection refused or timed out`);
      continue;
    }

    const canCreateSchema = await canCreateSchemaIn(candidate);

    return {
      available: true,
      reason: canCreateSchema
        ? `PostgreSQL is reachable at ${redactUrl(candidate)}`
        : `PostgreSQL is reachable at ${redactUrl(candidate)}, but the role cannot create schemas; ` +
          'the parity test will use the default schema and clean up after itself',
      connectionUrl: candidate,
      canCreateSchema
    };
  }

  return {
    available: false,
    reason:
      `No reachable PostgreSQL server was found.\n${POSTGRES_SETUP_HINT}\nTried:\n${failures.join('\n')}`,
    connectionUrl: null,
    canCreateSchema: false
  };
}

function redactUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

async function canCreateSchemaIn(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: withFastCommit(connectionString), connectionTimeoutMillis: 3000 });
  const probeSchema = `foldergram_probe_${process.pid}_${Date.now().toString(36)}`;

  try {
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${probeSchema}"`);
    await client.query(`DROP SCHEMA IF EXISTS "${probeSchema}"`);
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The extensions the PostgreSQL migrations need.
 *
 * `pg_trgm` is used by the AI analysis migrations for the trigram indexes.
 * It is a *trusted* extension, so a role with CREATE rights on the database
 * can install it - no superuser needed.
 */
/**
 * The PostgreSQL extensions the migrations need are installed by the
 * production code (`server/src/db/migration.ts` -> `ensurePostgresExtensions`)
 * before every migration run - both the driver and the migration script call
 * it. The test harness deliberately does not do it itself: importing the
 * production module pulls in the config module, which reads the environment
 * once and caches it, and the harness has to set the environment up first.
 */

/**
 * Empties the tables of the current schema.
 *
 * The rows are deleted in an order that respects the foreign keys, and the
 * identity sequences are restarted, so the row ids begin at 1 again - the same
 * as on SQLite, where every test starts with a fresh database file.
 */
export const SCHEMA_RESET_SQL = `
  DO $reset$
  -- The variable names must not collide with a column of the queried views:
  -- information_schema.tables has a "table_name" column, and PL/pgSQL would
  -- report "column reference is ambiguous" for it.
  DECLARE reset_table text;
  DECLARE reset_sequence text;
  BEGIN
    -- folders.avatar_image_id references images(id) without an ON DELETE
    -- clause, so the reference has to go before the images can be deleted.
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables AS tables
      WHERE tables.table_schema = current_schema() AND tables.table_name = 'folders'
    ) THEN
      EXECUTE 'UPDATE folders SET avatar_image_id = NULL WHERE avatar_image_id IS NOT NULL';
    END IF;

    -- The children first, then the parents. The foreign keys are either
    -- ON DELETE CASCADE or ON DELETE SET NULL, so this order never runs into
    -- a constraint violation.
    FOR reset_table IN
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename <> 'schema_migrations'
      ORDER BY
        CASE tablename
          WHEN 'collection_items' THEN 0
          WHEN 'likes' THEN 1
          WHEN 'images' THEN 2
          WHEN 'folders' THEN 3
          ELSE 4
        END
    LOOP
      EXECUTE 'DELETE FROM ' || quote_ident(reset_table);
    END LOOP;

    FOR reset_sequence IN
      SELECT sequencename
      FROM pg_sequences
      WHERE schemaname = current_schema()
    LOOP
      EXECUTE 'ALTER SEQUENCE ' || quote_ident(reset_sequence) || ' RESTART';
    END LOOP;
  END
  $reset$;
`;

export interface ScratchSchema {
  readonly schema: string;
  readonly connectionUrl: string;
}

/**
 * Creates an isolated schema and returns a connection string that points at it.
 *
 * A schema (instead of a separate database) keeps the test usable with a
 * non-superuser role, which is what the docker-compose setup provides.
 */
export async function createScratchSchema(
  connectionString: string,
  prefix = 'foldergram_test',
  options: { unique?: boolean } = {}
): Promise<ScratchSchema> {
  const unique = options.unique ?? false;

  // A unique name per schema that exists at the same time: a schema is
  // dropped with CASCADE, so two schemas that share a name would take each
  // other's tables with them.
  //
  // A stable name, on the other hand, means the migrations are applied once
  // for the whole run instead of once per worker. Applying the migration set
  // is a couple of dozen commits, and every worker that created its own
  // schema would pay for them again.
  //
  // "Stable" has to mean stable for the *run* and not stable for ever: two
  // suites that run against the same database at the same time would empty
  // each other's schema in the middle of a test. The run is identified by the
  // process that started the workers, which is the same for every file of a
  // run and different for two runs.
  const runId = `${process.ppid}`;
  const schema = unique
    ? `${prefix}_${process.pid}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    : `${prefix}_${runId}`;
  const client = new pg.Client({ connectionString: withFastCommit(connectionString), connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    if (unique) {
      // Drop the schemas that a previous run left behind. A run that was
      // killed cannot clean up after itself, and the leftovers would pile up
      // in the test database.
      const { rows } = await client.query<{ schema: string }>(
        `SELECT nspname AS schema
         FROM pg_namespace
         WHERE nspname LIKE $1 AND nspname <> $2`,
        [`${prefix.replace(/_/g, '\\_')}%`, schema]
      );

      for (const row of rows) {
        await client.query(`DROP SCHEMA IF EXISTS "${row.schema}" CASCADE`).catch(() => undefined);
      }
    }
    // The stable schema of a previous run is a leftover as well, but it may
    // only be dropped when no session uses it: a suite that runs against the
    // same database right now has its own schema, and dropping that one would
    // empty it in the middle of its tests.
    //
    // `pg_stat_activity` has no `search_path` column, so the sessions cannot
    // be matched by the schema they work in. The leftovers are therefore left
    // alone - they are named after the run that created them and they hold no
    // locks. They can be removed with:
    //
    //   DROP SCHEMA <name> CASCADE;
  } finally {
    await client.end().catch(() => undefined);
  }

  return { schema, connectionUrl: withSearchPath(connectionString, schema) };
}

export async function dropScratchSchema(connectionString: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: withFastCommit(connectionString), connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch {
    // Best effort cleanup - a leftover schema must never fail the suite.
  } finally {
    await client.end().catch(() => undefined);
  }
}
