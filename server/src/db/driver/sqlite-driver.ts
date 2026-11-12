import { performance } from 'node:perf_hooks';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { appConfig } from '../../config/env.js';
import { sqlitePrepare } from './sqlite-raw.js';
import { recordDbQuery } from '../../observability/db-telemetry.js';
import { log } from '../../services/log-service.js';
import { metricsService } from '../../services/metrics-service.js';
import type { IDbDriver, QueryResult } from './types.js';

function recordQuery(sql: string, elapsedMs: number): void {
  metricsService.recordQuery(sql, elapsedMs, appConfig.logSlowQueryMs);
  recordDbQuery({ dialect: 'sqlite', sql, elapsedMs });
  if (elapsedMs >= appConfig.logSlowQueryMs) {
    log.info('Slow query', { elapsed: `${elapsedMs}ms`, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
}

function recordQueryError(sql: string, elapsedMs: number, error: unknown): void {
  // A query that failed is not a query that does not exist: it is measured
  // too, so the failures show up in the same place as the rest.
  recordDbQuery({ dialect: 'sqlite', sql, elapsedMs, error });
}

/**
 * Runs a query and measures it.
 *
 * The measurement covers the failed queries too.
 */
function runQuery<T>(sql: string, run: () => T): T {
  const startedAt = performance.now();

  try {
    const result = run();
    recordQuery(sql, Math.round(performance.now() - startedAt));
    return result;
  } catch (error) {
    recordQueryError(sql, Math.round(performance.now() - startedAt), error);
    throw error;
  }
}

export class SqliteDriver implements IDbDriver {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: DatabaseSync) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const rows = runQuery(sql, () => {
      const stmt = sqlitePrepare(this.db, sql);
      return stmt.all(...(params as SQLInputValue[])) as T[];
    });
    return { rows, rowCount: rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return runQuery(sql, () => {
      const stmt = sqlitePrepare(this.db, sql);
      return stmt.get(...(params as SQLInputValue[])) as T | undefined;
    });
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const result = runQuery(sql, () => {
      const stmt = sqlitePrepare(this.db, sql);
      return stmt.run(...(params as SQLInputValue[]));
    });
    return {
      rows: [],
      rowCount: Number(result.changes ?? 0),
      lastInsertId: result.lastInsertRowid
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (driver: IDbDriver) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
