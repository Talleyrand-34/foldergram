import { DatabaseSync } from 'node:sqlite';

import { appConfig } from '../config/env.js';
import { SqliteDriver } from './driver/sqlite-driver.js';
import { PostgresDriver } from './driver/postgres-driver.js';
import type { IDbDriver } from './driver/types.js';
import { ensurePostgresExtensions, runStartupMigrations } from './migration.js';
import { assertNoLegacySchema } from './schema-compat.js';
import { schemaSql } from './schema.js';
import { storageService } from '../services/storage-service.js';

class DatabaseManager {
  private driverPromise: Promise<IDbDriver> | null = null;

  getConnection(): Promise<IDbDriver> {
    if (!this.driverPromise) {
      this.driverPromise = this.initialize();
    }
    return this.driverPromise;
  }

  /**
   * Closes the underlying driver (and with it the PostgreSQL connection pool).
   * Used for graceful shutdown and by the test harness to release handles
   * deterministically.
   */
  async close(): Promise<void> {
    if (!this.driverPromise) {
      return;
    }

    const driver = await this.driverPromise;
    this.driverPromise = null;
    await driver.close();
  }

  private async initialize(): Promise<IDbDriver> {
    if (appConfig.dbDriver === 'postgres') {
      // The migrations need `pg_trgm`; the extension is created here and not
      // inside a migration, because `CREATE EXTENSION` takes a catalog lock.
      await ensurePostgresExtensions(appConfig.databaseUrl!);
      runStartupMigrations({ dialect: 'postgres' });
      return new PostgresDriver(appConfig.databaseUrl!);
    }

    const databasePath = storageService.getDatabasePath();

    if (databasePath === ':memory:') {
      const db = new DatabaseSync(':memory:');
      db.exec(schemaSql);
      return new SqliteDriver(db);
    }

    runStartupMigrations({ databasePath, dialect: 'sqlite' });
    const db = new DatabaseSync(databasePath);
    assertNoLegacySchema(db);
    return new SqliteDriver(db);
  }
}

export const databaseManager = new DatabaseManager();
