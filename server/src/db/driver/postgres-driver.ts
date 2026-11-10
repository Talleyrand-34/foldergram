import { performance } from 'node:perf_hooks';

import pg from 'pg';

import { appConfig } from '../../config/env.js';
import { log } from '../../services/log-service.js';
import { metricsService } from '../../services/metrics-service.js';
import type { IDbDriver, QueryResult } from './types.js';

function extractCaller(): string {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n')) {
    if (line.includes('repositories.')) {
      const match = line.match(/at (?:async )?(?:Object\.)?(\w+)\s/);
      if (match?.[1]) return match[1];
    }
  }
  return 'unknown';
}

function recordQuery(sql: string, elapsedMs: number, getCaller?: () => string): void {
  metricsService.recordQuery(sql, elapsedMs, appConfig.logSlowQueryMs, getCaller);
  if (elapsedMs >= appConfig.logSlowQueryMs) {
    log.info('Slow query', { elapsed: `${elapsedMs}ms`, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
}

const BOOLEAN_COLUMNS = new Set([
  'is_deleted',
  'is_trashed',
  'is_animated',
  'is_approximate',
  'is_default'
]);

const BOOL_COLUMN_PATTERN = /(\b(?:is_deleted|is_trashed|is_animated|is_approximate|is_default)\b\s*=\s*)(0|1)(?!\d)/g;

function normalizeBooleanLiterals(sql: string): string {
  return sql.replace(BOOL_COLUMN_PATTERN, (_, prefix, val) => `${prefix}${val === '1' ? 'true' : 'false'}`);
}

function rewritePlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/**
 * `pg` returns `BIGINT` (int8) as a string by default, because a 64 bit
 * integer does not always fit into a JavaScript number.
 *
 * The PostgreSQL schema stores the timestamps and the file sizes as BIGINT,
 * while SQLite stores them as INTEGER - so on SQLite they are numbers and on
 * PostgreSQL they would be strings. The models (and every comparison in the
 * service layer) expect numbers, so the values are parsed as numbers here.
 * The values in question (millisecond timestamps, file sizes) are far below
 * `Number.MAX_SAFE_INTEGER`.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

const BOOL_COL_NAMES = 'is_deleted|is_trashed|is_animated|is_approximate|is_default';
// Finds zero-based parameter indices that correspond to boolean columns.
// Handles two patterns:
//   1. SET/WHERE:  `bool_col = ?`
//   2. INSERT:     `INSERT INTO t (col1, bool_col, ...) VALUES (?, ?, ...)`
function boolParamIndices(sql: string): Set<number> {
  const indices = new Set<number>();

  function qsBefore(pos: number): number {
    return (sql.slice(0, pos).match(/\?/g) ?? []).length;
  }

  // Pattern 1: col = ?
  const eqRe = new RegExp(`\\b(${BOOL_COL_NAMES})\\s*=\\s*\\?`, 'g');
  let m: RegExpExecArray | null;
  while ((m = eqRe.exec(sql)) !== null) {
    indices.add(qsBefore(m.index + m[0].length) - 1);
  }

  // Pattern 2: INSERT INTO t (..., bool_col, ...) VALUES (..., ?, ...)
  const insertRe = /INSERT\s+(?:\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)\s*(?:OVERRIDING\s+\w+\s+VALUE\s+)?VALUES\s*\(([^)]+)\)/gi;
  while ((m = insertRe.exec(sql)) !== null) {
    const cols = m[1].split(',').map(s => s.trim());
    const valTokens = m[2].split(',').map(s => s.trim());
    const baseQ = qsBefore(sql.indexOf(m[2], m.index));
    let localQ = 0;
    for (let i = 0; i < valTokens.length && i < cols.length; i++) {
      if (valTokens[i] === '?') {
        if (BOOLEAN_COLUMNS.has(cols[i])) indices.add(baseQ + localQ);
        localQ++;
      }
    }
  }

  return indices;
}

function normalizeBooleanParams(sql: string, params: unknown[]): unknown[] {
  if (params.length === 0) return params;
  const indices = boolParamIndices(sql);
  if (indices.size === 0) return params;
  const result = [...params];
  for (const idx of indices) {
    if (idx >= 0 && idx < result.length && (result[idx] === 0 || result[idx] === 1)) {
      result[idx] = result[idx] === 1;
    }
  }
  return result;
}

function quoteAliases(sql: string): string {
  return sql
    .replace(/\bAS (?!")([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, alias) =>
      /[A-Z]/.test(alias) ? `AS "${alias}"` : match
    )
    .replace(/\b(\w+)\.(?!")([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match, table, column) =>
      /[A-Z]/.test(column) ? `${table}."${column}"` : match
    );
}

function prepSql(sql: string): string {
  return rewritePlaceholders(normalizeBooleanLiterals(quoteAliases(sql)));
}

/**
 * Rewrites a repository query into the PostgreSQL dialect:
 *
 *  - `?` placeholders become `$1`, `$2`, ... (in order of appearance),
 *  - SQLite boolean literals (`is_deleted = 0`) become real booleans,
 *  - mixed case aliases and columns are quoted.
 *
 * Exported so the migration safety test can assert that the rewriting never
 * silently stops working.
 */
export function preparePostgresSql(sql: string): string {
  return prepSql(sql);
}

/**
 * The columns whose SQLite boolean literals (`0` / `1`) are rewritten into
 * PostgreSQL booleans.
 */
export const POSTGRES_BOOLEAN_COLUMNS: readonly string[] = [...BOOLEAN_COLUMNS];

function normalizeRow<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return result as T;
}

/**
 * The connection pools are kept in a process wide registry instead of in the
 * module scope.
 *
 * The module scope is not enough: the server resets its module registry on
 * every reload (and the test suite resets it for every test file), which
 * would create a new pool - and a new set of database connections - for the
 * same connection string over and over again. The registry makes sure that
 * one connection string means exactly one pool.
 */
interface PoolRegistry {
  pools: Map<string, pg.Pool>;
}

const globalScope = globalThis as typeof globalThis & { __foldergramPgPools?: PoolRegistry };

function getPoolRegistry(): PoolRegistry {
  if (!globalScope.__foldergramPgPools) {
    globalScope.__foldergramPgPools = { pools: new Map() };
  }

  return globalScope.__foldergramPgPools;
}

/**
 * The maximum number of connections of one pool.
 *
 * `pg` defaults to 10 connections per pool. A test suite runs many files in
 * parallel, and every file brings its own pool - 73 files with 10 connections
 * each would blow through the connection limit of the server ("sorry, too many
 * clients already"). The test environment therefore uses small pools, and
 * `PG_POOL_MAX` overrides the default.
 */
function resolvePoolMax(): number {
  const configured = Number.parseInt(process.env.PG_POOL_MAX ?? '', 10);

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return process.env.NODE_ENV === 'test' ? 3 : 10;
}

function getPool(connectionString: string): pg.Pool {
  const registry = getPoolRegistry();
  const existing = registry.pools.get(connectionString);

  if (existing) {
    return existing;
  }

  const pool = new pg.Pool({ connectionString, max: resolvePoolMax() });
  registry.pools.set(connectionString, pool);
  return pool;
}

/**
 * Waits until every client of the pool of the given connection string is
 * back in the pool.
 *
 * A client that is still busy holds the locks of its last transaction, and
 * whoever cleans up the database afterwards would block behind it. The test
 * harness uses this before it resets the database.
 */
export async function waitForPoolIdle(connectionString: string, timeoutMs = 5000): Promise<boolean> {
  const pool = getPoolRegistry().pools.get(connectionString);

  if (!pool) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pool.totalCount === pool.idleCount && pool.waitingCount === 0) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return pool.totalCount === pool.idleCount && pool.waitingCount === 0;
}

export class PostgresDriver implements IDbDriver {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = getPool(connectionString);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const t = performance.now();
    const result = await this.pool.query(prepSql(sql), normalizeBooleanParams(sql, params));
    recordQuery(sql, Math.round(performance.now() - t), extractCaller);
    const rows = result.rows.map((row: Record<string, unknown>) => normalizeRow<T>(row));
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const t = performance.now();
    const result = await this.pool.query(prepSql(sql), normalizeBooleanParams(sql, params));
    recordQuery(sql, Math.round(performance.now() - t), extractCaller);
    if (result.rows.length === 0) {
      return undefined;
    }
    return normalizeRow<T>(result.rows[0]);
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const t = performance.now();
    const result = await this.pool.query(prepSql(sql), normalizeBooleanParams(sql, params));
    recordQuery(sql, Math.round(performance.now() - t), extractCaller);
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
    const registry = getPoolRegistry();

    if (registry.pools.get(this.connectionString) === this.pool) {
      registry.pools.delete(this.connectionString);
    }

    await this.pool.end();
  }
}

class PostgresClientDriver implements IDbDriver {
  readonly dialect = 'postgres' as const;

  constructor(private readonly client: pg.PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const t = performance.now();
    const result = await this.client.query(prepSql(sql), normalizeBooleanParams(sql, params));
    recordQuery(sql, Math.round(performance.now() - t), extractCaller);
    const rows = result.rows.map((row: Record<string, unknown>) => normalizeRow<T>(row));
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const t = performance.now();
    const result = await this.client.query(prepSql(sql), normalizeBooleanParams(sql, params));
    recordQuery(sql, Math.round(performance.now() - t), extractCaller);
    if (result.rows.length === 0) {
      return undefined;
    }
    return normalizeRow<T>(result.rows[0]);
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const t = performance.now();
    const result = await this.client.query(prepSql(sql), normalizeBooleanParams(sql, params));
    recordQuery(sql, Math.round(performance.now() - t), extractCaller);
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
