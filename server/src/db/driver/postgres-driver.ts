import pg from 'pg';

import type { IDbDriver, QueryResult } from './types.js';

const BOOLEAN_COLUMNS = new Set([
  'is_deleted',
  'is_trashed',
  'is_animated',
  'is_approximate',
  'is_default'
]);

function rewritePlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function normalizeRow<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (BOOLEAN_COLUMNS.has(key) && typeof value === 'boolean') {
      result[key] = value ? 1 : 0;
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export class PostgresDriver implements IDbDriver {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(rewritePlaceholders(sql), params);
    const rows = result.rows.map((row: Record<string, unknown>) => normalizeRow<T>(row));
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.pool.query(rewritePlaceholders(sql), params);
    if (result.rows.length === 0) {
      return undefined;
    }
    return normalizeRow<T>(result.rows[0]);
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const result = await this.pool.query(rewritePlaceholders(sql), params);
    const lastInsertId = result.rows.length > 0 && result.rows[0].id != null
      ? Number(result.rows[0].id)
      : undefined;
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
      lastInsertId
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (driver: IDbDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const clientDriver = new PostgresClientDriver(client);
    try {
      await client.query('BEGIN');
      const result = await fn(clientDriver);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresClientDriver implements IDbDriver {
  readonly dialect = 'postgres' as const;

  constructor(private readonly client: pg.PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.client.query(rewritePlaceholders(sql), params);
    const rows = result.rows.map((row: Record<string, unknown>) => normalizeRow<T>(row));
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.client.query(rewritePlaceholders(sql), params);
    if (result.rows.length === 0) {
      return undefined;
    }
    return normalizeRow<T>(result.rows[0]);
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const result = await this.client.query(rewritePlaceholders(sql), params);
    const lastInsertId = result.rows.length > 0 && result.rows[0].id != null
      ? Number(result.rows[0].id)
      : undefined;
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
      lastInsertId
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (driver: IDbDriver) => Promise<T>): Promise<T> {
    // Already inside a transaction — run directly
    return fn(this);
  }

  async close(): Promise<void> {
    // Client is managed by the pool — do not close here
  }
}
