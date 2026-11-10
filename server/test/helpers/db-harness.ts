import { vi } from 'vitest';

import { createTempDataRoot, stubDataRootEnv, type TempDataRoot } from './temp-data-root.js';
import { assertSchemaHasAppTables, type TestDialect } from './dialect.js';

export type AppConfigModule = typeof import('../../src/config/env.js');
export type RepositoriesModule = typeof import('../../src/db/repositories.js');
export type DatabaseModule = typeof import('../../src/db/database.js');

/**
 * A fully initialised repository layer backed by an isolated data root.
 */
export interface DatabaseHarness {
  readonly dialect: TestDialect;
  readonly tempDataRoot: TempDataRoot;
  readonly appConfig: AppConfigModule['appConfig'];
  readonly repositories: RepositoriesModule;
  /** Closes the database handle and removes the temp data root. */
  close(): Promise<void>;
}

export interface DatabaseHarnessOptions {
  /** Which dialect to initialise. Defaults to the dialect implied by the env. */
  readonly dialect?: TestDialect;
  /** PostgreSQL connection string (only used for the `postgres` dialect). */
  readonly databaseUrl?: string;
  /** Prefix for the temporary data root directory. */
  readonly tempRootPrefix?: string;
}

/**
 * Creates an isolated database harness.
 *
 * The harness
 *  - creates a throw-away data root (gallery / db / thumbnails / previews),
 *  - points the storage environment variables at it,
 *  - initialises the repositories for the requested dialect (running the
 *    migrations for that dialect), and
 *  - hands back a `close()` that releases every handle deterministically.
 *
 * Because `vi.resetModules()` is used, the repositories module instance
 * returned here is private to the harness - the module level state of
 * `server/src/db/repositories.ts` never leaks into another harness.
 */
export async function createDatabaseHarness(options: DatabaseHarnessOptions = {}): Promise<DatabaseHarness> {
  const dialect = options.dialect ?? 'sqlite';
  const tempDataRoot = await createTempDataRoot({
    prefix: options.tempRootPrefix ?? `foldergram-${dialect}-`
  });

  stubDataRootEnv(tempDataRoot, (name, value) => vi.stubEnv(name, value));

  if (dialect === 'postgres') {
    if (!options.databaseUrl) {
      throw new Error('createDatabaseHarness({ dialect: "postgres" }) requires a databaseUrl.');
    }

    vi.stubEnv('DB_DRIVER', 'postgres');
    vi.stubEnv('DATABASE_URL', options.databaseUrl);
  } else {
    vi.stubEnv('DB_DRIVER', 'sqlite');
    vi.stubEnv('DATABASE_URL', '');
  }

  vi.resetModules();

  const { appConfig } = (await import('../../src/config/env.js')) as AppConfigModule;
  const repositories = (await import('../../src/db/repositories.js')) as RepositoriesModule;
  const { databaseManager } = (await import('../../src/db/database.js')) as DatabaseModule;

  await repositories.initRepositories();

  if (dialect === 'postgres' && options.databaseUrl) {
    // The migrations have to have created the app tables in the schema of the
    // connection. If they did not, the queries would silently use the shared
    // schema and the harness would see the rows of another test.
    await assertSchemaHasAppTables(options.databaseUrl);
  }

  let closed = false;

  return {
    dialect,
    tempDataRoot,
    appConfig,
    repositories,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;

      try {
        await databaseManager.close();
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
        await tempDataRoot.remove();
      }
    }
  };
}

/**
 * Runs `body` against a fresh harness and always tears the harness down.
 */
export async function withDatabaseHarness<T>(
  options: DatabaseHarnessOptions,
  body: (harness: DatabaseHarness) => Promise<T>
): Promise<T> {
  const harness = await createDatabaseHarness(options);

  try {
    return await body(harness);
  } finally {
    await harness.close();
  }
}
