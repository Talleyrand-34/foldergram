import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { IDbDriver, QueryResult } from './types.js';

export class SqliteDriver implements IDbDriver {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: DatabaseSync) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...(params as SQLInputValue[])) as T[];
    return { rows, rowCount: rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params as SQLInputValue[])) as T | undefined;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params as SQLInputValue[]));
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
