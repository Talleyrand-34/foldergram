import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { appConfig } from '../config/env.js';
import { log } from '../services/log-service.js';
import { ensurePostgresExtensions, runStartupMigrations } from '../db/migration.js';

export async function main(): Promise<void> {
  if (appConfig.dbDriver === 'postgres' && appConfig.databaseUrl) {
    // The migrations need `pg_trgm`. It is created here and not inside a
    // migration, because `CREATE EXTENSION` takes a catalog lock.
    await ensurePostgresExtensions(appConfig.databaseUrl);
  }

  const result = runStartupMigrations({ dialect: appConfig.dbDriver });

  if (appConfig.dbDriver === 'sqlite' && !result.usedInMemoryDatabase && result.baselineInserted) {
    log.info('Marked existing SQLite database as Dbmate baseline');
  }
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (typeof entryPoint !== 'string' || entryPoint.length === 0) {
    return false;
  }

  return pathToFileURL(path.resolve(entryPoint)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Database migration failed. Foldergram will not start until the issue is resolved.', message);
    process.exit(1);
  }
}
