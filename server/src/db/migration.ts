import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveBinary } from 'dbmate';
import pg from 'pg';

import { sqliteGet, sqliteRun } from './driver/sqlite-raw.js';

import { appConfig, repositoryRoot } from '../config/env.js';
import {
  applyBaselineCompatMigrations,
  assertNoLegacySchema,
  rebuildBaselineForeignKeys,
  tableExists
} from './schema-compat.js';
import { log } from '../services/log-service.js';
import { storageService } from '../services/storage-service.js';

export const BASELINE_MIGRATION_VERSION = '000001';
const SCHEMA_MIGRATIONS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)';

/**
 * The PostgreSQL extensions the migrations need.
 *
 * `pg_trgm` backs the trigram indexes of the ai-analysis plugin. It is a
 * trusted extension, so the database owner can install it without superuser
 * rights.
 *
 * The extensions are created here, in the runner, and NOT inside a migration:
 * `CREATE EXTENSION` takes a catalog lock, and a migration runs inside the
 * migration transaction. When many test files migrate the same database in
 * parallel, those locks serialise and the migrations end up waiting for
 * minutes. Checking first and only creating what is missing keeps the common
 * case lock-free.
 */
const REQUIRED_POSTGRES_EXTENSIONS = ['pg_trgm'] as const;

/**
 * The schema the PostgreSQL extensions have to live in.
 *
 * The operator classes of an extension live in the schema it was installed
 * in, and the migrations create their indexes with them. `public` is the
 * schema that stays on the search path of every connection - no matter which
 * schema a connection works in - so it is the only safe place.
 */
const POSTGRES_EXTENSION_SCHEMA = 'public';

/**
 * The databases whose extensions were already ensured.
 *
 * The set lives in the global scope so it survives a module reset. Without it
 * every driver initialisation would open another connection to check the
 * extensions, and a test suite that initialises the driver many times would
 * exhaust the connection limit of the server.
 */
const extensionScope = globalThis as typeof globalThis & { __foldergramEnsuredPostgresExtensions?: Set<string> };

function getEnsuredPostgresDatabases(): Set<string> {
  if (!extensionScope.__foldergramEnsuredPostgresExtensions) {
    extensionScope.__foldergramEnsuredPostgresExtensions = new Set<string>();
  }

  return extensionScope.__foldergramEnsuredPostgresExtensions;
}

/**
 * The identity of the database behind a connection string.
 *
 * The search path is not part of it: the extensions belong to the database,
 * not to the schema a connection happens to use.
 */
function getDatabaseIdentity(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    url.searchParams.delete('options');
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

export async function ensurePostgresExtensions(databaseUrl: string): Promise<void> {
  const ensured = getEnsuredPostgresDatabases();
  const identity = getDatabaseIdentity(databaseUrl);

  if (ensured.has(identity)) {
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });

  try {
    await client.connect();

    for (const extension of REQUIRED_POSTGRES_EXTENSIONS) {
      const { rows } = await client.query<{ schema: string }>(
        `SELECT namespace.nspname AS schema
         FROM pg_extension AS extension
         INNER JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
         WHERE extension.extname = $1`,
        [extension]
      );

      if (rows.length > 0) {
        // The operator classes of the extension live in the schema it was
        // installed in, and the migrations create their indexes with them. The
        // migrations need the extension in "public" - the schema that stays on
        // the search path of every connection, no matter which schema a
        // connection works in.
        if (rows[0].schema !== POSTGRES_EXTENSION_SCHEMA) {
          await movePostgresExtension(client, extension, rows[0].schema);
        }

        continue;
      }

      try {
        await client.query(`CREATE EXTENSION "${extension}" SCHEMA ${POSTGRES_EXTENSION_SCHEMA}`);
      } catch (error) {
        // Another session may have created it in the meantime.
        const { rows: afterRace } = await client.query<{ present: number }>(
          'SELECT 1 AS present FROM pg_extension WHERE extname = $1',
          [extension]
        );

        if (afterRace.length === 0) {
          throw error;
        }
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  ensured.add(identity);
}

/**
 * Moves an extension that was installed in the wrong schema.
 *
 * A `CREATE EXTENSION` without a schema clause installs the extension in the
 * first schema of the search path - which is the schema of the connected role
 * if there is one, and not necessarily `public`.
 */
async function movePostgresExtension(
  client: pg.Client,
  extension: string,
  fromSchema: string
): Promise<void> {
  try {
    await client.query(`ALTER EXTENSION "${extension}" SET SCHEMA ${POSTGRES_EXTENSION_SCHEMA}`);
  } catch (error) {
    throw new Error(
      `The PostgreSQL extension "${extension}" is installed in the schema "${fromSchema}", but the ` +
        `migrations need it in "${POSTGRES_EXTENSION_SCHEMA}": its operator classes live in the ` +
        `schema it was installed in, and "${POSTGRES_EXTENSION_SCHEMA}" is the schema that stays ` +
        `on the search path of every connection. It could not be moved: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The PostgreSQL targets the migrations were already applied to.
 *
 * A migration only has to run once per database, but the startup path runs it
 * for every driver initialisation - and the driver is re-created whenever the
 * module registry is reset (the test suite does that for every test file).
 * Remembering the migrated targets keeps every further call cheap.
 *
 * The set lives in the global scope so it survives a module reset.
 */
const globalScope = globalThis as typeof globalThis & { __foldergramMigratedPostgresTargets?: Set<string> };

function getMigratedPostgresTargets(): Set<string> {
  if (!globalScope.__foldergramMigratedPostgresTargets) {
    globalScope.__foldergramMigratedPostgresTargets = new Set<string>();
  }

  return globalScope.__foldergramMigratedPostgresTargets;
}
const APP_SCHEMA_TABLES = [
  'folders',
  'images',
  'places',
  'scan_runs',
  'app_settings',
  'folder_scan_state',
  'likes',
  'collections',
  'collection_items'
] as const;

export interface BaselineResult {
  baselineInserted: boolean;
  existingSchemaDetected: boolean;
}

export interface StartupMigrationResult {
  baselineInserted: boolean;
  databasePath: string;
  usedInMemoryDatabase: boolean;
}

export interface StartupMigrationOptions {
  databasePath?: string;
  migrationsDirectory?: string;
  spawnSyncImpl?: typeof spawnSync;
  dialect?: 'sqlite' | 'postgres';
}

function defaultSqliteMigrationsDirectory(): string {
  return path.join(repositoryRoot, 'server', 'db', 'migrations', 'sqlite');
}

function defaultPostgresMigrationsDirectory(): string {
  return path.join(repositoryRoot, 'server', 'db', 'migrations', 'postgres');
}

/**
 * The directories the migration runner actually reads.
 *
 * Exported so the migration safety test can assert that a new migration has to
 * be added for both dialects - the flat `server/db/migrations/` directory is
 * legacy and is not read by the runner.
 */
export function getSqliteMigrationsDirectory(): string {
  return defaultSqliteMigrationsDirectory();
}

export function getPostgresMigrationsDirectory(): string {
  return defaultPostgresMigrationsDirectory();
}

function baselineMigrationPath(migrationsDirectory: string): string {
  return path.join(migrationsDirectory, `${BASELINE_MIGRATION_VERSION}_baseline.sql`);
}

function extractMigrationUpSql(migrationSql: string): string {
  const lines = migrationSql.split(/\r?\n/);
  const upLines: string[] = [];
  let inUpSection = false;

  for (const line of lines) {
    if (/^\s*--\s*migrate:up\b/i.test(line)) {
      inUpSection = true;
      continue;
    }

    if (/^\s*--\s*migrate:down\b/i.test(line)) {
      break;
    }

    if (inUpSection) {
      upLines.push(line);
    }
  }

  if (!inUpSection || upLines.length === 0) {
    throw new Error(`Baseline migration is missing an up section: ${migrationSql}`);
  }

  return upLines.join('\n').trim();
}

function applyBaselineSchema(database: DatabaseSync, migrationsDirectory: string): void {
  const migrationSql = fs.readFileSync(baselineMigrationPath(migrationsDirectory), 'utf8');
  database.exec(extractMigrationUpSql(migrationSql));
}

function buildSqliteDatabaseUrl(databasePath: string): string {
  return `sqlite:${pathToFileURL(databasePath).pathname}`;
}

function hasExistingAppSchema(database: DatabaseSync): boolean {
  return APP_SCHEMA_TABLES.some((tableName) => tableExists(database, tableName));
}

function migrationVersionExists(database: DatabaseSync, version: string): boolean {
  if (!tableExists(database, 'schema_migrations')) {
    return false;
  }

  const row = sqliteGet(database, 'SELECT version FROM schema_migrations WHERE version = ? LIMIT 1', version) as
    | { version: string }
    | undefined;

  return row?.version === version;
}

export function baselineExistingDatabaseIfNeeded(databasePath: string, options: StartupMigrationOptions = {}): BaselineResult {
  const database = new DatabaseSync(databasePath);
  const migrationsDirectory = options.migrationsDirectory ?? defaultSqliteMigrationsDirectory();

  try {
    assertNoLegacySchema(database);

    const existingSchemaDetected = hasExistingAppSchema(database);
    if (!existingSchemaDetected || migrationVersionExists(database, BASELINE_MIGRATION_VERSION)) {
      return {
        baselineInserted: false,
        existingSchemaDetected
      };
    }

    applyBaselineCompatMigrations(database);
    applyBaselineSchema(database, migrationsDirectory);
    const rebuiltForeignKeys = rebuildBaselineForeignKeys(database);
    if (rebuiltForeignKeys) {
      applyBaselineSchema(database, migrationsDirectory);
    }
    database.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
    sqliteRun(database, 'INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)', BASELINE_MIGRATION_VERSION);

    return {
      baselineInserted: true,
      existingSchemaDetected
    };
  } finally {
    database.close();
  }
}

/**
 * Translates the application connection string into one dbmate understands.
 *
 * dbmate is a Go program and it ignores the libpq `options` parameter, so a
 * connection string that carries the search path in `options` would make it
 * apply the migrations to the wrong schema - `public` instead of the schema of
 * the connection. dbmate has its own parameter for that.
 *
 * Without this translation the migrations always land in `public`, and every
 * connection that points at another schema silently reads the tables of
 * `public` instead. That is how test files end up seeing each other's rows.
 */
function toDbmateDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const options = url.searchParams.get('options');

    if (!options) {
      return databaseUrl;
    }

    // The whole list matters, not only the first schema: the extension
    // `pg_trgm` lives in `public`, and the trigram indexes of the ai-analysis
    // migration need its operator classes to be resolvable.
    const match = /(?:^|\s)search_path\s*=\s*([^\s]+)/.exec(options);
    if (!match) {
      return databaseUrl;
    }

    url.searchParams.set('search_path', match[1]);
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function runDbmateUp(databaseUrl: string, migrationsDirectory: string, options: StartupMigrationOptions = {}): void {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(
    resolveBinary(),
    [
      '--url',
      toDbmateDatabaseUrl(databaseUrl),
      '--migrations-dir',
      migrationsDirectory,
      '--no-dump-schema',
      'up'
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit'
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Dbmate exited with status ${result.status ?? 'unknown'}`);
  }
}

export function runStartupMigrations(options: StartupMigrationOptions = {}): StartupMigrationResult {
  const dialect = options.dialect ?? 'sqlite';

  if (dialect === 'postgres') {
    const databaseUrl = appConfig.databaseUrl!;
    const migrationsDirectory = options.migrationsDirectory ?? defaultPostgresMigrationsDirectory();
    const migratedTargets = getMigratedPostgresTargets();

    if (!migratedTargets.has(databaseUrl)) {
      runDbmateUp(databaseUrl, migrationsDirectory, options);
      migratedTargets.add(databaseUrl);
    }

    return {
      baselineInserted: false,
      databasePath: databaseUrl,
      usedInMemoryDatabase: false
    };
  }

  const databasePath = options.databasePath ?? storageService.getDatabasePath();
  if (databasePath === ':memory:') {
    log.info('Skipping Dbmate migrations because the configured database directory is unavailable');
    return {
      baselineInserted: false,
      databasePath,
      usedInMemoryDatabase: true
    };
  }

  const migrationsDirectory = options.migrationsDirectory ?? defaultSqliteMigrationsDirectory();
  const baselineResult = baselineExistingDatabaseIfNeeded(databasePath, { ...options, migrationsDirectory });
  runDbmateUp(buildSqliteDatabaseUrl(databasePath), migrationsDirectory, options);

  return {
    baselineInserted: baselineResult.baselineInserted,
    databasePath,
    usedInMemoryDatabase: false
  };
}
